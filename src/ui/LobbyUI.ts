import type { NetPhase, RosterView } from '../net/session';
import './lobby.css';

export interface LobbyUICallbacks {
  onStart: () => void;
  onLeave: () => void;
  onProfile: (name: string, color: number) => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onCourse: (id: string) => void;
}

/** Display data for one course; main.ts supplies it so the lobby stays free of sim code. */
export interface CourseOption { id: string; name: string }

export interface CourseView {
  /** Only the host gets the selector; guests see the course read-only. */
  editable: boolean;
  /** -1 when the selected ID is not in the known course list. */
  index: number;
  label: string;
}

export function courseView(courses: readonly CourseOption[], selectedId: string, role: 'host' | 'guest'): CourseView {
  const index = courses.findIndex(course => course.id === selectedId);
  const label = index < 0 ? '不明なコース' : `${String(index + 1).padStart(2, '0')} ${courses[index].name}`;
  return { editable: role === 'host', index, label };
}

// Kept presentation-local: the UI must not load transport, protocol, or sim code.
export const COLORS = [0xffbf38, 0xff5f80, 0x56d9c1, 0x8c7bff, 0x4dc6ff, 0xff854f, 0xf04a4a, 0xf4f4f0];
const COLOR_NAMES = ['イエロー', 'ピンク', 'ミント', 'パープル', 'ブルー', 'オレンジ', 'レッド', 'ホワイト'];
export const ROOM_CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
const ERROR_MESSAGES: Record<string, string> = {
  broker_unreachable: '接続サーバーに届きません。通信環境を確認して、もう一度お試しください。',
  room_not_found: 'ルームが見つかりません。コードとホストの接続を確認してください。',
  room_taken: 'このルームコードは使用中です。もう一度ルームを作成してください。',
  ice_failed: '相手と接続できません。Wi-Fiや回線を変えてお試しください。',
  timeout: '接続がタイムアウトしました。もう一度お試しください。',
  full: 'ルームは満員です。空きができてから参加してください。',
  in_race: 'レース中です。ロビーに戻ってから参加してください。',
  version: 'ゲームのバージョンが違います。ページを再読み込みしてください。',
  bad_name: '名前は1〜10文字で入力してください。空白だけの名前や使えない文字が含まれています。',
  host_lost: 'ホストとの接続が切れました。もう一度ルームに参加してください。',
  host_closed: 'ホストがルームを閉じました。別のルームに参加してください。',
  broker_lost: '接続サーバーとの接続が切れました。参加中のプレイヤーとは遊べますが、新しい参加はできません。',
};

export function isPlayerName(value: string): boolean {
  const wellFormed = (value as string & { isWellFormed?: () => boolean }).isWellFormed;
  return (wellFormed ? wellFormed.call(value) : !/[\uD800-\uDFFF]/u.test(value)) &&
    [...value].length <= 10 &&
    !/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u.test(value) &&
    [...value].some(char => /[\p{L}\p{N}\p{S}\p{P}]/u.test(char) &&
      !/[\u3164\u115f\u1160\uffa0\u2800]/u.test(char));
}

export function normalizeCode(value: string): string {
  return value.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();
}

export function pastedCode(value: string): string {
  // Boundaries avoid interpreting four letters inside a URL or ordinary word as a code.
  // Prefer a token with a digit ('TEAM AB2X'), else the last token: codes follow labels.
  const text = value.normalize('NFKC').toUpperCase();
  const tokens = [...text.matchAll(/(?:^|[^A-Z0-9])([2-9A-HJKMNP-Z](?:[\s-]*[2-9A-HJKMNP-Z]){3})(?![A-Z0-9])/g)]
    .map(match => match[1]);
  return normalizeCode([...tokens].reverse().find(token => /[2-9]/.test(token)) ?? tokens.at(-1) ?? text);
}

/** Mount after GameUI. The caller owns GameUI.show() and Controls.setEnabled(false).
 * Call render() on session changes; pass transport failures to showError().
 * Callbacks receive user intent only; no network or simulation runs here.
 */
export class LobbyUI {
  onStart?: LobbyUICallbacks['onStart'];
  onLeave?: LobbyUICallbacks['onLeave'];
  onProfile?: LobbyUICallbacks['onProfile'];
  onCreate?: LobbyUICallbacks['onCreate'];
  onJoin?: LobbyUICallbacks['onJoin'];
  onCourse?: LobbyUICallbacks['onCourse'];

  private readonly entry: HTMLElement;
  private readonly lobby: HTMLElement;
  private readonly listeners = new AbortController();
  private readonly codeInput: HTMLInputElement;
  private readonly nameInput: HTMLInputElement;
  private readonly swatches: HTMLButtonElement[];
  private readonly rows: HTMLElement[];
  private readonly titleHelp: HTMLElement | null;
  private readonly titleHelpAnchor = document.createComment('lobby-title-help');
  private readonly humanSlots = new Set<number>();
  private roster: RosterView | null = null;
  private phase: NetPhase = 'idle';
  private error = '';
  private validationError = false;
  private notice = '';
  private profileDirty = false;
  private pendingProfile: { name: string; draftName: string; color: number } | null = null;
  private composingName = false;
  private composingCode = false;
  private destroyed = false;
  private selectedColor = COLORS[0];
  private actionVersion = 0;

  constructor(root: HTMLElement, callbacks: Partial<LobbyUICallbacks> = {}, private readonly courses: readonly CourseOption[] = []) {
    Object.assign(this, callbacks);
    const title = root.querySelector<HTMLElement>('#title-screen');
    const lobby = root.querySelector<HTMLElement>('#lobby-screen');
    if (!title || !lobby) throw new Error('LobbyUI requires the GameUI title and lobby screens.');
    this.lobby = lobby;
    this.entry = document.createElement('section');
    this.entry.id = 'online-entry';
    this.entry.setAttribute('aria-labelledby', 'online-heading');
    this.entry.innerHTML = `
      <h2 id="online-heading">オンライン対戦</h2>
      <button id="online-cancel" type="button" hidden>接続をやめる</button>
      <div class="online-actions">
        <button id="online-create" type="button">ルーム作成</button>
        <form id="online-join-form" novalidate>
          <label for="online-code">ルームコード</label>
          <div class="online-join-controls">
            <input id="online-code" name="room" type="text" inputmode="text" maxlength="4"
              autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AB2X"
              aria-describedby="online-status">
            <button id="online-join" type="submit">参加</button>
          </div>
        </form>
      </div>
      <p id="online-status" class="lobby-status" role="status" aria-live="polite" aria-atomic="true"></p>`;
    root.append(this.entry);
    // Keep the existing solo instructions in flow with the entry panel, including
    // short landscape screens where two absolute panels would overlap.
    this.titleHelp = title.querySelector<HTMLElement>('.title-help');
    if (this.titleHelp) {
      this.titleHelp.before(this.titleHelpAnchor);
      this.entry.append(this.titleHelp);
    }
    this.lobby.innerHTML = `
      <div class="lobby-content">
        <header class="lobby-header">
          <div><p class="lobby-eyebrow">ONLINE / 8 RACERS</p><h2>ロビー</h2></div>
          <button id="lobby-leave" type="button">退出</button>
        </header>
        <div class="lobby-room">
          <div><span class="lobby-label">ルームコード</span><output id="lobby-code" aria-label="ルームコード">----</output></div>
          <div class="lobby-room-actions"><button id="lobby-copy" type="button">コピー</button><button id="lobby-share" type="button" hidden>共有</button></div>
        </div>
        <div class="lobby-body">
          <section class="lobby-grid" aria-label="参加者"><ol id="lobby-roster"></ol></section>
          <div class="lobby-side">
          <div class="lobby-course">
            <label for="lobby-course-select" class="lobby-label">コース</label>
            <select id="lobby-course-select"></select>
            <output id="lobby-course-name" aria-label="コース（ホストが選択）"></output>
          </div>
          <form id="lobby-profile" class="lobby-profile" novalidate>
            <label for="lobby-name">名前（10文字まで）</label>
            <input id="lobby-name" name="name" type="text" maxlength="20" autocomplete="nickname"
              aria-describedby="lobby-status" spellcheck="false">
            <fieldset class="lobby-palette"><legend>カートの色</legend><div class="lobby-swatches"></div></fieldset>
            <button id="lobby-profile-save" type="submit">名前を更新</button>
          </form>
          </div>
        </div>
        <footer class="lobby-footer">
          <p id="lobby-status" class="lobby-status" role="status" aria-live="polite" aria-atomic="true"></p>
          <div class="lobby-start-row"><p id="lobby-wait">ホストの開始を待っています</p><button id="lobby-start" type="button" hidden>スタート</button></div>
          <p class="lobby-note">ホストは画面を開いたままにしてください</p>
        </footer>
      </div>`;
    this.codeInput = this.get<HTMLInputElement>('online-code');
    // Native maxlength counts UTF-16 units; editName enforces ten code points.
    this.nameInput = this.get<HTMLInputElement>('lobby-name');
    this.rows = Array.from({ length: 8 }, (_, slot) => {
      const row = document.createElement('li');
      row.className = 'lobby-player';
      row.innerHTML = `<span class="lobby-slot">${slot + 1}</span><span class="lobby-color" aria-hidden="true"></span><span class="lobby-player-name"></span><span class="lobby-player-tags"></span>`;
      this.get('lobby-roster').append(row);
      return row;
    });
    this.swatches = COLORS.map((color, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lobby-swatch';
      button.style.setProperty('--kart-color', this.colorCSS(color));
      button.innerHTML = '<span aria-hidden="true"></span>';
      button.setAttribute('aria-label', COLOR_NAMES[index]);
      this.lobby.querySelector('.lobby-swatches')!.append(button);
      this.listen(button, 'click', () => {
        this.selectedColor = color;
        this.profileDirty = true;
        this.updateSelectedColor();
        this.submitProfile();
      });
      return button;
    });

    const courseSelect = this.get<HTMLSelectElement>('lobby-course-select');
    for (const course of courses) courseSelect.append(new Option(courseView(courses, course.id, 'host').label, course.id));
    this.listen(courseSelect, 'change', () => {
      if (this.phase === 'lobby' && this.localPlayer()?.kind === 'host') this.invoke(() => this.onCourse?.(courseSelect.value));
    });

    this.listen(this.get('online-create'), 'click', () => this.connect());
    this.listen(this.get('online-join-form'), 'submit', event => {
      event.preventDefault();
      if (this.composingCode) return;
      this.codeInput.value = normalizeCode(this.codeInput.value);
      if (!ROOM_CODE.test(this.codeInput.value)) {
        this.codeInput.setAttribute('aria-invalid', 'true');
        this.setMessage('コードは4文字の英数字です。0・1・I・L・Oは使えません。', true, true);
        this.codeInput.focus();
        return;
      }
      this.connect(this.codeInput.value);
    });
    const updateCode = () => {
      this.codeInput.value = normalizeCode(this.codeInput.value).slice(0, 4);
      this.codeInput.removeAttribute('aria-invalid');
    };
    this.listen(this.codeInput, 'input', event => {
      if (!(event as InputEvent).isComposing) updateCode();
    });
    this.listen(this.codeInput, 'compositionstart', () => { this.composingCode = true; });
    this.listen(this.codeInput, 'compositionend', () => {
      this.composingCode = false;
      updateCode();
    });
    this.listen(this.codeInput, 'paste', event => {
      const pasted = (event as ClipboardEvent).clipboardData?.getData('text');
      if (pasted === undefined) return;
      event.preventDefault();
      const code = pastedCode(pasted);
      if (ROOM_CODE.test(code)) this.codeInput.value = code;
      else this.codeInput.setRangeText(code, this.codeInput.selectionStart ?? 0,
        this.codeInput.selectionEnd ?? 0, 'end');
      updateCode();
    });
    this.listen(this.nameInput, 'compositionstart', () => {
      this.composingName = true;
      this.profileDirty = true;
    });
    this.listen(this.nameInput, 'compositionend', () => {
      this.composingName = false;
      this.editName();
    });
    this.listen(this.nameInput, 'input', () => {
      this.profileDirty = true;
      if (!this.composingName) this.editName();
    });
    this.listen(this.get('lobby-profile'), 'submit', event => {
      event.preventDefault();
      if (!this.composingName) this.submitProfile();
    });
    this.listen(this.get('lobby-start'), 'click', () => {
      if (this.phase === 'lobby' && this.localPlayer()?.kind === 'host') this.invoke(this.onStart);
    });
    for (const id of ['lobby-leave', 'online-cancel']) {
      this.listen(this.get(id), 'click', () => {
        this.actionVersion++;
        this.clearError();
        this.render(null, 'idle');
        this.invoke(this.onLeave);
        this.get('online-create').focus();
      });
    }
    this.listen(this.get('lobby-copy'), 'click', () => { void this.copyCode(); });
    this.listen(this.get('lobby-share'), 'click', () => { void this.shareCode(); });
    // Stop only events originating in our controls. Preserve native typing,
    // Tab/Enter activation and Escape handling; never install global handlers.
    for (const surface of [this.entry, this.lobby]) {
      for (const type of ['keydown', 'keyup']) {
        this.listen(surface, type, event => {
          if ((event as KeyboardEvent).key !== 'Escape') event.stopPropagation();
        });
      }
    }
    this.render(null, 'idle');
  }

  render(rosterView: RosterView | null, phase: NetPhase): void {
    if (this.destroyed) return;
    const entering = phase === 'lobby' && (this.phase !== 'lobby' ||
      this.roster?.localSlot !== rosterView?.localSlot || this.roster?.roomCode !== rosterView?.roomCode);
    if (phase !== this.phase) this.notice = '';
    // A rejected draft from an earlier visit must not greet the player after a race.
    if (entering && this.validationError) this.error = '';
    if (this.roster?.roomCode !== rosterView?.roomCode || !rosterView) this.humanSlots.clear();
    this.roster = rosterView;
    this.phase = phase;
    rosterView?.players.forEach(player => {
      if (player.kind !== 'cpu') this.humanSlots.add(player.slot);
    });
    this.entry.hidden = phase !== 'idle' && phase !== 'connecting' && phase !== 'closed';
    this.lobby.hidden = phase !== 'lobby';
    const connecting = phase === 'connecting';
    this.entry.setAttribute('aria-busy', String(connecting));
    for (const id of ['online-create', 'online-join']) this.get<HTMLButtonElement>(id).disabled = connecting;
    this.codeInput.disabled = connecting;
    this.get('online-cancel').hidden = !connecting;
    this.get('lobby-code').textContent = rosterView?.roomCode || '----';
    const local = this.localPlayer();
    const acknowledged = local && this.pendingProfile?.name === local.name && this.pendingProfile.color === local.color;
    // The host refused or replaced a color that another player now holds: show the real one.
    const colorRefused = local && this.pendingProfile?.name === local.name && this.pendingProfile.color !== local.color &&
      rosterView?.players.some(player => player.slot !== rosterView.localSlot && player.kind !== 'cpu' &&
        player.color === this.pendingProfile?.color);
    if (colorRefused && !this.composingName) {
      if (this.nameInput.value === this.pendingProfile?.draftName) this.profileDirty = false;
      this.selectedColor = local.color;
      this.pendingProfile = null;
    }
    if (acknowledged && this.nameInput.value === this.pendingProfile?.draftName && this.selectedColor === local.color && !this.composingName) {
      this.profileDirty = false;
    }
    if (entering || acknowledged) this.pendingProfile = null;
    if (local && (entering || (!this.profileDirty && !this.composingName))) {
      this.nameInput.value = local.name;
      this.selectedColor = local.color;
      this.profileDirty = false;
      this.nameInput.removeAttribute('aria-invalid');
    }
    for (const [slot, row] of this.rows.entries()) {
      const player = rosterView?.players.find(candidate => candidate.slot === slot);
      const disconnected = !!player && !player.connected && this.humanSlots.has(slot);
      row.dataset.local = String(slot === rosterView?.localSlot);
      row.dataset.disconnected = String(disconnected);
      row.querySelector<HTMLElement>('.lobby-color')!.style.setProperty('--kart-color', this.colorCSS(player?.color ?? COLORS[slot]));
      row.querySelector('.lobby-player-name')!.textContent = player?.name ?? `CPU ${slot + 1}`;
      row.querySelector('.lobby-player-tags')!.textContent = [
        player?.kind === 'host' ? 'ホスト' : '',
        slot === rosterView?.localSlot ? 'あなた' : '',
        !player || player.kind === 'cpu' ? 'CPU' : '',
        disconnected ? '切断' : '',
      ].filter(Boolean).join(' · ');
    }
    this.nameInput.disabled = !local || phase !== 'lobby';
    this.get<HTMLButtonElement>('lobby-profile-save').disabled = this.nameInput.disabled;
    this.swatches.forEach((button, index) => {
      const occupied = rosterView?.players.some(player => player.slot !== rosterView.localSlot &&
        player.kind !== 'cpu' && player.color === COLORS[index]);
      button.disabled = this.nameInput.disabled || !!occupied;
      button.setAttribute('aria-label', `${COLOR_NAMES[index]}${occupied ? '（使用中）' : ''}`);
      button.title = occupied ? 'ほかのプレイヤーが使用中です' : COLOR_NAMES[index];
    });
    this.updateSelectedColor();
    this.get('lobby-start').hidden = local?.kind !== 'host';
    this.get<HTMLButtonElement>('lobby-start').disabled = phase !== 'lobby' || !local?.connected;
    this.get('lobby-wait').hidden = local?.kind === 'host';
    this.get('lobby-share').hidden = typeof navigator.share !== 'function';
    for (const id of ['lobby-copy', 'lobby-share']) this.get<HTMLButtonElement>(id).disabled = !rosterView?.roomCode;
    this.updateStatus();
    if (entering) this.nameInput.focus({ preventScroll: true });
  }

  /** Shows the selected course: a selector for the host, read-only text for guests. */
  setCourse(selectedId: string, role: 'host' | 'guest'): void {
    if (this.destroyed) return;
    const view = courseView(this.courses, selectedId, role);
    const select = this.get<HTMLSelectElement>('lobby-course-select');
    const name = this.get('lobby-course-name');
    select.hidden = !view.editable;
    name.hidden = view.editable;
    if (name.textContent !== view.label) name.textContent = view.label;
    select.value = view.index < 0 ? '' : selectedId;
  }

  /** Accepts TransportError, a session close/rejection reason, or an unknown failure. */
  showError(error: unknown): void {
    if (this.destroyed) return;
    let code: unknown = error;
    if (error && typeof error === 'object') {
      code = 'code' in error ? error.code : 'reason' in error ? error.reason : undefined;
    }
    if (code === 'left') {
      this.clearError();
      return;
    }
    if (this.phase === 'connecting') this.render(null, 'idle');
    this.setMessage(typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
      ? ERROR_MESSAGES[code] : '接続に失敗しました。もう一度お試しください。');
  }

  clearError(): void {
    this.error = '';
    this.validationError = false;
    this.updateStatus();
  }

  destroy(): void {
    this.destroyed = true;
    this.actionVersion++;
    this.listeners.abort();
    if (this.titleHelp) this.titleHelpAnchor.replaceWith(this.titleHelp);
    this.entry.remove();
    this.lobby.replaceChildren();
    this.lobby.hidden = true;
  }

  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return (this.entry.querySelector(`#${id}`) ?? this.lobby.querySelector(`#${id}`)) as T;
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener, { signal: this.listeners.signal });
  }

  private colorCSS(color: number): string { return `#${color.toString(16).padStart(6, '0')}`; }

  private localPlayer() { return this.roster?.players.find(player => player.slot === this.roster?.localSlot); }

  private editName(): void {
    this.nameInput.value = [...this.nameInput.value].slice(0, 10).join('');
    this.profileDirty = true;
    this.nameInput.removeAttribute('aria-invalid');
  }

  private submitProfile(): void {
    if (this.phase !== 'lobby' || !this.localPlayer() || this.composingName) return;
    const name = this.nameInput.value;
    if (!isPlayerName(name)) {
      this.nameInput.setAttribute('aria-invalid', 'true');
      this.setMessage(ERROR_MESSAGES.bad_name, true, true);
      this.nameInput.focus();
      return;
    }
    this.profileDirty = true;
    this.pendingProfile = { name: name.trim(), draftName: name, color: this.selectedColor };
    this.clearError();
    this.invoke(() => this.onProfile?.(name.trim(), this.selectedColor));
  }

  private connect(code?: string): void {
    if (this.phase === 'connecting') return;
    this.actionVersion++;
    this.clearError();
    this.render(null, 'connecting');
    this.get('online-cancel').focus({ preventScroll: true });
    this.invoke(code === undefined ? this.onCreate : () => this.onJoin?.(code));
  }

  private updateSelectedColor(): void {
    this.swatches.forEach((button, index) => button.setAttribute('aria-pressed', String(COLORS[index] === this.selectedColor)));
  }

  private invoke(callback?: () => void): void {
    const version = this.actionVersion;
    try {
      Promise.resolve(callback?.()).catch(error => {
        if (!this.destroyed && version === this.actionVersion) this.showError(error);
      });
    } catch (error) { this.showError(error); }
  }

  private setMessage(message: string, error = true, validation = false): void {
    this.error = error ? message : '';
    this.validationError = error && validation;
    this.notice = error ? '' : message;
    this.updateStatus();
  }

  private updateStatus(): void {
    if (this.destroyed) return;
    const message = this.error || this.notice || (this.phase === 'connecting' ? 'ルームに接続中…' :
      this.phase === 'closed' ? '接続を終了しました。ルームを作成するか、コードで参加してください。' : '');
    for (const id of ['online-status', 'lobby-status']) {
      const status = this.get(id);
      if (status.textContent !== message) status.textContent = message;
      status.dataset.error = String(!!this.error);
    }
  }

  private async copyCode(): Promise<void> {
    const code = this.roster?.roomCode;
    if (!code) return;
    const version = this.actionVersion;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code);
      if (version === this.actionVersion && !this.destroyed) this.setMessage('ルームコードをコピーしました。', false);
    } catch {
      if (version !== this.actionVersion || this.destroyed) return;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(this.get('lobby-code'));
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.setMessage('コピーできませんでした。表示されたコードを選択してコピーしてください。');
    }
  }

  private async shareCode(): Promise<void> {
    const code = this.roster?.roomCode;
    if (!code || typeof navigator.share !== 'function') return;
    const version = this.actionVersion;
    try {
      await navigator.share({ title: 'POCKET CIRCUIT', text: `オンライン対戦のルームコード: ${code}` });
    } catch (error) {
      if (version !== this.actionVersion || this.destroyed || (error instanceof Error && error.name === 'AbortError')) return;
      this.setMessage('共有できませんでした。「コピー」でルームコードを送ってください。');
    }
  }
}
