import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLORS, courseView, isPlayerName, LobbyUI, normalizeCode, pastedCode, ROOM_CODE } from './LobbyUI';
import { getTrack, TRACK_IDS } from '../sim/tracks';
import type { RosterView } from '../net/session';
import { createRace } from '../sim/race';
import { isRoomCode, ROOM_ALPHABET, ROOM_CODE_LENGTH } from '../net/roomCode';

describe('LobbyUI player names', () => {
  it.each(['\u061c', '\u2060', '\u00ad', '\u200b', '\u200c', '\u200d', '\u200e',
    '\u200f', '\u202a', '\u202e', '\u2066', '\u2069', '\ufeff', '\u{e0001}', '\u2028', '\u2029',
    '\u0000', '\n', '\u007f', '\u0085'])('rejects control/format characters %j anywhere', char => {
    expect(isPlayerName(char)).toBe(false);
    expect(isPlayerName(`A${char}`)).toBe(false);
  });

  it.each(['', ' ', '\u3000', '\u3164', '\u115f', '\u1160', '\uffa0', '\u2800',
    '\ufe0f', '\u0301', '\u3164\u115f\u1160\uffa0\u2800\ufe0f'])('requires a visible letter, number, symbol or punctuation: %j', name => {
    expect(isPlayerName(name)).toBe(false);
  });

  it.each(['レーサー', 'A 2', '１２３', '!?', '🏎️', '😀'.repeat(10), 'か\u3099'])('accepts visible names %j', name => {
    expect(isPlayerName(name)).toBe(true);
  });

  it.each(['a'.repeat(11), '😀'.repeat(11), '\ud800', '\udfff', 'a\ud800', '👩‍🚀'])('rejects oversized, malformed and ZWJ names %j', name => {
    expect(isPlayerName(name)).toBe(false);
  });
});

describe('LobbyUI room input', () => {
  it.each(['ab2x', 'ＡＢ２Ｘ', ' a b-2x ', '\ta\nb ２－ｘ'])('normalizes %j', input => {
    expect(normalizeCode(input)).toBe('AB2X');
  });

  it.each(['オンライン対戦のルームコード: ab2x', 'Join AB2X now!',
    'ルームコード：ＡＢ－２Ｘ で参加', 'コード: a b 2 x', 'https://example.com/?room=ab2x',
    'ルームコード AB2X をコピーしました。', 'TEAM AB2X', 'AB2X TEAM', 'ROOM: CODE ABCD AB2X'])('extracts code from %j', input => {
    expect(pastedCode(input)).toBe('AB2X');
  });

  it.each(['0B2X', '1B2X', 'IB2X', 'LB2X', 'OB2X', 'AB2', 'AB2XY'])('does not extract a substring from invalid codes %j', input => {
    expect(ROOM_CODE.test(pastedCode(input))).toBe(false);
  });
});

describe('LobbyUI presentation constants stay in sync', () => {
  it('matches all eight simulation kart colors in slot order', () => {
    expect(COLORS).toEqual(createRace(1).karts.map(kart => kart.color));
    expect(new Set(COLORS).size).toBe(8);
  });

  it('matches the network alphabet at every code position', () => {
    expect(ROOM_CODE.test(ROOM_ALPHABET[0].repeat(ROOM_CODE_LENGTH))).toBe(true);
    for (let position = 0; position < ROOM_CODE_LENGTH; position++) {
      // Check the full BMP, including lookalikes and fullwidth letters.
      for (let point = 0; point <= 0xffff; point++) {
        const code = [...'2222'];
        code[position] = String.fromCharCode(point);
        const value = code.join('');
        if (ROOM_CODE.test(value) !== isRoomCode(value)) throw new Error(`Room alphabet drift: ${JSON.stringify(value)}`);
      }
    }
    expect([...ROOM_ALPHABET].every(char => ROOM_CODE.test(char.repeat(ROOM_CODE_LENGTH)))).toBe(true);
  });

  it('matches network room-code length restrictions', () => {
    for (let length = 0; length < 12; length++) {
      expect(ROOM_CODE.test('A'.repeat(length))).toBe(isRoomCode('A'.repeat(length)));
    }
  });
});

// Rendering-state tests use small element doubles; browser layout and native
// keyboard/clipboard behavior are checked separately in Playwright.
function element() {
  const attributes = new Map<string, string>();
  return {
    value: '', textContent: '', hidden: false, disabled: false,
    dataset: {} as Record<string, string>, focus: vi.fn(),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    getAttribute: (key: string) => attributes.get(key),
    removeAttribute: (key: string) => attributes.delete(key),
  };
}

function harness() {
  vi.stubGlobal('navigator', {});
  const nodes = new Map<string, ReturnType<typeof element>>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id)!;
  };
  const state = {
    get, entry: element(), lobby: element(), codeInput: get('online-code'), nameInput: get('lobby-name'),
    swatches: COLORS.map(() => element()), rows: [], humanSlots: new Set<number>(),
    roster: null, phase: 'idle', error: '', notice: '', profileDirty: false, pendingProfile: null,
    composingName: false, destroyed: false, selectedColor: COLORS[0], actionVersion: 0,
    onProfile: vi.fn(),
  };
  const ui = Object.assign(Object.create(LobbyUI.prototype), state) as LobbyUI;
  return {
    ui, get, name: state.nameInput, swatches: state.swatches, onProfile: state.onProfile,
    edit(value: string) {
      state.nameInput.value = value;
      (ui as unknown as { editName(): void }).editName();
    },
    submit() { (ui as unknown as { submitProfile(): void }).submitProfile(); },
    select(color: number) { Object.assign(ui, { selectedColor: color, profileDirty: true }); },
  };
}

const roster: RosterView = {
  roomCode: 'AB2X', localSlot: 0,
  players: [{ slot: 0, name: 'HOST', color: COLORS[0], kind: 'host', connected: true }],
};

describe('LobbyUI render state', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['idle', 'closed'] as const)('preserves errors when render(%s) follows showError', phase => {
    const { ui, get } = harness();
    ui.render(roster, 'lobby');
    ui.showError({ reason: 'host_lost' });
    const message = get('lobby-status').textContent;
    ui.render(null, phase);
    expect(get('online-status').textContent).toBe(message);
    ui.clearError();
    ui.render(null, phase);
    ui.showError({ reason: 'host_lost' });
    expect(get('online-status').textContent).toBe(message);
  });

  it('retains a transport error across connecting → idle → closed', () => {
    const { ui, get } = harness();
    ui.render(null, 'connecting');
    ui.showError({ code: 'ice_failed' });
    ui.render(null, 'closed');
    expect(get('online-status').textContent).toContain('Wi-Fi');
    expect(get('online-status').dataset.error).toBe('true');
  });

  it('does not display a failure for voluntary leave', () => {
    const { ui, get } = harness();
    ui.showError('host_lost');
    ui.showError({ reason: 'left' });
    ui.render(null, 'idle');
    expect(get('online-status').dataset.error).toBe('false');
    expect(get('online-status').textContent).toBe('');
  });

  it('keeps submitted drafts until acknowledged and does not overwrite newer edits', () => {
    const { ui, edit, submit, name, onProfile } = harness();
    ui.render(roster, 'lobby');
    edit('NEW');
    ui.render(roster, 'lobby');
    expect(name.value).toBe('NEW');
    submit();
    expect(onProfile).toHaveBeenCalledWith('NEW', COLORS[0]);
    ui.render(roster, 'lobby');
    expect(name.value).toBe('NEW');
    edit('NEWER');
    ui.render({ ...roster, players: [{ ...roster.players[0], name: 'NEW' }] }, 'lobby');
    expect(name.value).toBe('NEWER');
    submit();
    ui.render({ ...roster, players: [{ ...roster.players[0], name: 'NEWER' }] }, 'lobby');
    ui.render(roster, 'lobby');
    expect(name.value).toBe('HOST'); // Acknowledged edits no longer mask session updates.
  });

  it('does not replace an in-progress IME composition', () => {
    const { ui, name, submit, onProfile } = harness();
    ui.render(roster, 'lobby');
    Object.assign(ui, { composingName: true });
    name.value = '変換中';
    ui.render(roster, 'lobby');
    expect(name.value).toBe('変換中');
    submit();
    expect(onProfile).not.toHaveBeenCalled();
  });

  it('preserves whitespace typed after submission when the earlier profile is acknowledged', () => {
    const { ui, edit, submit, name } = harness();
    ui.render(roster, 'lobby');
    edit('NEW');
    submit();
    edit('NEW ');
    ui.render({ ...roster, players: [{ ...roster.players[0], name: 'NEW' }] }, 'lobby');
    expect(name.value).toBe('NEW ');
  });

  it('shows the actual color when the host refused a color now held by another player', () => {
    const { ui, swatches, select, submit, onProfile } = harness();
    const guest = { slot: 1, name: 'GUEST', color: COLORS[2], kind: 'guest' as const, connected: true };
    ui.render(roster, 'lobby');
    select(COLORS[2]);
    submit();
    expect(onProfile).toHaveBeenCalledWith('HOST', COLORS[2]);
    ui.render({ ...roster, players: [...roster.players, guest] }, 'lobby');
    expect(swatches[0].getAttribute('aria-pressed')).toBe('true');
    expect(swatches[2].getAttribute('aria-pressed')).toBe('false');
    expect((ui as unknown as { profileDirty: boolean }).profileDirty).toBe(false);
  });

  it('clears a validation error on re-entering the lobby but keeps transport errors', () => {
    const { ui, get, edit, submit } = harness();
    ui.render(roster, 'lobby');
    edit(' ');
    submit();
    expect(get('lobby-status').dataset.error).toBe('true');
    ui.render(null, 'countdown');
    ui.render(roster, 'lobby');
    expect(get('lobby-status').dataset.error).toBe('false');
    ui.showError('broker_lost');
    ui.render(null, 'countdown');
    ui.render(roster, 'lobby');
    expect(get('lobby-status').textContent).toContain('接続サーバー');
  });

  it.each(['countdown', 'racing', 'results'] as const)('treats lobby → %s → lobby with the same roster as re-entry', phase => {
    const { ui, get, name, edit, submit } = harness();
    ui.render(roster, 'lobby');
    edit(' ');
    submit();
    expect(get('lobby-status').dataset.error).toBe('true');
    ui.render(roster, phase); // main.ts reports race start / results with the session roster
    ui.render(roster, 'lobby');
    expect(get('lobby-status').dataset.error).toBe('false');
    expect(get('lobby-status').textContent).toBe('');
    expect(name.value).toBe('HOST');
    expect(name.getAttribute('aria-invalid')).toBeUndefined();
  });

  it('keeps selected color and pressed state through invalid-name and stale-roster updates', () => {
    const { ui, name, swatches, edit, select, submit, onProfile } = harness();
    ui.render(roster, 'lobby');
    edit(' ');
    select(COLORS[2]);
    submit();
    ui.render(roster, 'lobby');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(swatches[2].getAttribute('aria-pressed')).toBe('true');
    expect(swatches[0].getAttribute('aria-pressed')).toBe('false');
    expect(onProfile).not.toHaveBeenCalled();
    edit('NEW');
    submit();
    ui.render(roster, 'lobby');
    expect(swatches[2].getAttribute('aria-pressed')).toBe('true');
    expect(onProfile).toHaveBeenCalledWith('NEW', COLORS[2]);
  });
});

describe('LobbyUI course view model', () => {
  const courses = TRACK_IDS.map(id => ({ id, name: getTrack(id).def.name }));

  it('gives the host an editable selector and the guest read-only text for the same course', () => {
    const host = courseView(courses, 'neon', 'host');
    const guest = courseView(courses, 'neon', 'guest');
    expect(host).toEqual({ editable: true, index: 3, label: '04 NEON NIGHTLINE' });
    expect(guest).toEqual({ ...host, editable: false });
  });

  it.each(TRACK_IDS.map((id, index) => [id, index] as const))('numbers %s by registry order', (id, index) => {
    expect(courseView(courses, id, 'guest')).toMatchObject({ index, label: `0${index + 1} ${getTrack(id).def.name}` });
  });

  it.each(['', 'unknown', 'MEADOW', '__proto__'])('marks an unknown course %j without guessing one', id => {
    expect(courseView(courses, id, 'guest')).toEqual({ editable: false, index: -1, label: '不明なコース' });
    expect(courseView(courses, id, 'host')).toEqual({ editable: true, index: -1, label: '不明なコース' });
    expect(courseView([], 'meadow', 'guest').index).toBe(-1);
  });
});
