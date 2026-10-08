import './style.css';
import { AudioEngine } from './audio/AudioEngine';
import { Controls } from './input/Controls';
import { GuestSession } from './net/guestSession';
import { HostSession } from './net/hostSession';
import { generateRoomCode } from './net/roomCode';
import type { Transport } from './net/transport';
import { GameRenderer } from './render/GameRenderer';
import { captureRenderSnapshot } from './render/snapshot';
import { createRace, FIXED_DT, getAIInput, getTrack, stepRace, TRACK_IDS } from './sim';
import type { InputFrame, InputSource, RaceState, TrackId } from './sim';
import { GameUI } from './ui/GameUI';
import { LobbyUI } from './ui/LobbyUI';
import { loadBest, loadMuted, loadSensitivity, loadSteerAssist, saveBest, saveMuted, saveSensitivity, saveSteerAssist } from './storage';

const root = document.querySelector<HTMLDivElement>('#app')!;
const ui = new GameUI(root, 0);
const perf = new URLSearchParams(window.location.search).get('perf') === '1' ? createPerfReadout() : null;

function createPerfReadout() {
  const element = document.createElement('div');
  element.id = 'perf-readout';
  element.style.cssText = 'position:fixed;top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));z-index:100;pointer-events:none;padding:4px 7px;border-radius:4px;background:#102529e6;color:#fff;font:11px/1.4 monospace;white-space:nowrap';
  document.body.append(element);
  let previousTime: number | null = null;
  let total = 0, count = 0, maximum = 0, lastPaint = 0;
  const reset = () => {
    previousTime = null;
    total = count = maximum = lastPaint = 0;
    element.textContent = '平均 — ms · 最大 — ms';
  };
  const onVisibility = () => { previousTime = null; };
  document.addEventListener('visibilitychange', onVisibility);
  reset();
  return {
    reset,
    sample(now: number) {
      if (document.hidden) { previousTime = null; return; }
      if (previousTime !== null) {
        // Use real frame intervals: the simulation's 100 ms clamp hides stalls.
        const milliseconds = Math.max(0, now - previousTime);
        total += milliseconds;
        count++;
        maximum = Math.max(maximum, milliseconds);
        if (now - lastPaint >= 500) {
          element.textContent = `平均 ${(total / count).toFixed(1)} ms · 最大 ${maximum.toFixed(1)} ms`;
          lastPaint = now;
        }
      }
      previousTime = now;
    },
    dispose() {
      document.removeEventListener('visibilitychange', onVisibility);
      element.remove();
    },
  };
}

const controls = new Controls(root);
root.classList.toggle('touch-device', controls.isTouch);
let audio = new AudioEngine(0);
// GameUI tracks only the local kart, so other racers' roulettes stay silent online.
ui.onRoulette = (kind) => audio.playRoulette(kind);
/** Title selection; solo races and new rooms start on this course. */
let course: TrackId = 'meadow';
let muted = loadMuted();
audio.setMuted(muted);
ui.setMuted(muted);
let sensitivity = loadSensitivity();
controls.setSteerSensitivity(sensitivity);
ui.setSensitivity(sensitivity);
const savedAssist = loadSteerAssist();
if (savedAssist !== null) controls.setSteerAssist(savedAssist);
ui.setSteerAssist(controls.steerAssist);
root.addEventListener('input-device-change', () => ui.setSteerAssist(controls.steerAssist));
ui.setCourse(course, loadBest(course, getTrack(course).def.layoutVersion ?? 1));

function seed(): number {
  try { return crypto.getRandomValues(new Uint32Array(1))[0]; }
  catch { return Date.now() >>> 0; }
}

let state = createRace(seed());
const cpuSource: InputSource = { sample: getAIInput };
const soloSources: InputSource[] = state.karts.map((kart) => kart.id === 0 ? controls : cpuSource);
// The host swaps in HostSession.inputSource(slot); solo keeps controls + CPU.
let inputSources = soloSources;
let previous = captureRenderSnapshot(state);
let screen: 'title' | 'lobby' | 'race' | 'results' = 'title';
let paused = false;
let accumulator = 0;
let lastTime = performance.now();
let frameId = 0;
let disposed = false;
let renderer: GameRenderer | undefined;
let fatal = false;
// Online play. solo is the original single-player path; the others only add branches.
let mode: 'solo' | 'host' | 'guest' = 'solo';
let localId = 0;
let host: HostSession | null = null;
let guest: GuestSession | null = null;
/** Invalidates a pending create/join when the player cancels or leaves. */
let netGeneration = 0;
/** A create/join is awaiting the transport (no session object exists yet). */
let pendingNet = false;
/** Online "leave?" confirmation; unlike pause it never stops the simulation. */
let leaving = false;
let guestAlpha = 1;

function fail(message: string): void {
  fatal = true;
  controls.setEnabled(false);
  audio.suspend();
  ui.showError(message);
}

try {
  renderer = new GameRenderer(ui.canvas, state, 0);
} catch (error) {
  console.error('The 3D renderer could not start.', error);
  fail('3D 表示を開始できませんでした。WebGL に対応したブラウザで、ハードウェアアクセラレーションを有効にして再読み込みしてください。');
}

function start(): void {
  if (fatal) return;
  cancelOnline(); // A room being created or joined must not take over the solo race.
  launch(createRace(seed(), { trackId: course }));
}

function launch(next: RaceState): void {
  perf?.reset();
  state = next;
  // GameRenderer is bound to one course; a different course needs a new renderer first.
  if (renderer && !fatal && renderer.getTrackId() !== state.trackId) {
    // Online, prepareCourse() builds it in the lobby; a rebuild here stalls the countdown.
    if (mode !== 'solo') console.warn(`Renderer rebuilt at race start (${renderer.getTrackId()} -> ${state.trackId}); the lobby did not prepare it.`);
    recreateRenderer(localId);
  }
  if (mode !== 'solo') renderer?.setRoster(next.karts);
  leaving = false;
  previous = captureRenderSnapshot(state);
  accumulator = 0;
  lastTime = performance.now();
  // Leaving the lobby phase lets LobbyUI treat the next lobby visit as re-entry.
  if (mode !== 'solo') lobby.render((host ?? guest)?.roster ?? null, 'countdown');
  screen = 'race';
  paused = false;
  ui.setPaused(false);
  ui.show('race');
  ui.update(state);
  controls.reset();
  controls.setEnabled(true);
  // Unlock from the user's gesture; do not delay the simulation on audio permission.
  const startingRace = state;
  void audio.unlock().then(() => {
    if (state !== startingRace || screen !== 'race' || paused || fatal) return;
    audio.update(state);
    if (state.countdown > 2) audio.playEvents([{ type: 'countdown', kartId: -1, value: 3 }]);
  });
  ui.canvas.focus({ preventScroll: true });
}

function pause(value: boolean): void {
  if (mode !== 'solo') { confirmLeave(value); return; }
  if (screen !== 'race' || fatal || paused === value) return;
  paused = value;
  accumulator = 0;
  lastTime = performance.now();
  controls.setEnabled(!value);
  ui.setPaused(value);
  if (value) audio.suspend();
  else {
    void audio.unlock();
    ui.canvas.focus({ preventScroll: true });
  }
}

function confirmLeave(value: boolean): void {
  if (screen !== 'race' || fatal || leaving === value) return;
  leaving = value;
  controls.setEnabled(!value);
  ui.setPaused(value);
}

function title(): void {
  const wasOnline = mode !== 'solo';
  if (wasOnline) {
    inputSources = soloSources;
    setLocal('solo', 0);
    lobby.render(null, 'idle');
  }
  ui.hideDisconnected();
  leaving = false;
  screen = 'title';
  paused = false;
  accumulator = 0;
  state = createRace(seed(), { trackId: course });
  previous = captureRenderSnapshot(state);
  if (renderer && !fatal && renderer.getTrackId() !== state.trackId) recreateRenderer(localId);
  else if (wasOnline) renderer?.setRoster(state.karts);
  controls.setEnabled(false);
  audio.suspend();
  ui.setPaused(false);
  ui.setCourse(course, loadBest(course, getTrack(course).def.layoutVersion ?? 1));
  ui.show('title');
}

function selectCourse(id: TrackId): void {
  if (screen !== 'title' || fatal || id === course || !TRACK_IDS.includes(id)) return;
  course = id;
  // The title background shows the selected course.
  state = createRace(seed(), { trackId: course });
  previous = captureRenderSnapshot(state);
  if (renderer && renderer.getTrackId() !== state.trackId) recreateRenderer(localId);
  ui.setCourse(course, loadBest(course, getTrack(course).def.layoutVersion ?? 1));
}

function finish(): void {
  screen = 'results';
  controls.setEnabled(false);
  audio.finishRace();
  const time = state.karts.find((kart) => kart.id === localId)?.finishTime ?? null;
  const previousBest = loadBest(state.trackId, getTrack(state.trackId).def.layoutVersion ?? 1);
  // Online races never update the personal best.
  const isRecord = mode === 'solo' && time !== null && (previousBest === null || time < previousBest);
  if (isRecord) saveBest(state.trackId, time, getTrack(state.trackId).def.layoutVersion ?? 1);
  if (mode !== 'solo') lobby.render((host ?? guest)?.roster ?? null, 'results');
  ui.showResults(state, isRecord ? time : previousBest, isRecord);
  ui.show('results');
}

const bind = (id: string, handler: () => void) => root.querySelector(`#${id}`)?.addEventListener('click', handler);
/** Recreates the local-kart-bound renderer/audio when the guest slot differs. */
function setLocal(next: typeof mode, id: number): void {
  mode = next;
  ui.setMode(next, id);
  if (id === localId) return;
  localId = id;
  audio.dispose();
  audio = new AudioEngine(id);
  audio.setMuted(muted);
  if (next === 'guest') void audio.unlock();
  recreateRenderer(id);
}

/** Disposes and rebuilds the renderer for the current state's course and the given local kart. */
function recreateRenderer(id: number): void {
  if (!renderer || fatal) return;
  // The new renderer shares the canvas context and assumes default unpack state.
  const gl = renderer.renderer.getContext();
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  renderer.dispose();
  try {
    renderer = new GameRenderer(ui.canvas, state, id);
    // Draw once now so shader compilation happens inside this one main-thread stall.
    renderer.update(state, captureRenderSnapshot(state), 1, 0, screen);
  } catch (error) {
    renderer = undefined;
    console.error('The 3D renderer could not restart.', error);
    fail('3D 表示を開始できませんでした。ページを再読み込みしてください。');
  }
  // The rebuild blocked PONG/snapshot handling; it must not read as host silence.
  guest?.excuseStall();
}

async function loadTransport(): Promise<Transport> {
  // Keep peerjs out of the single-player initial chunk.
  const { PeerJsTransport } = await import('./net/peerjsTransport');
  return new PeerJsTransport();
}

async function createRoom(): Promise<void> {
  const generation = ++netGeneration;
  pendingNet = true;
  let session: HostSession;
  try {
    const transport = await loadTransport();
    if (generation !== netGeneration) return;
    session = await HostSession.create(transport, { roomCode: generateRoomCode(), hostInput: controls });
  } catch (error) {
    if (generation !== netGeneration) return; // Cancelled: a late failure is not shown.
    pendingNet = false;
    throw error;
  }
  if (generation !== netGeneration) { session.close(); return; }
  pendingNet = false;
  host = session;
  session.setCourse(course);
  setLocal('host', 0);
  session.onChange(() => { if (host === session && screen === 'lobby') renderLobby(); });
  // Guests already connected keep playing; only new joins are impossible.
  session.onBrokerLost(() => { if (host === session) lobby.showError('broker_lost'); });
  enterLobby();
}

async function joinRoom(code: string): Promise<void> {
  const generation = ++netGeneration;
  pendingNet = true;
  let transport: Transport;
  try { transport = await loadTransport(); }
  catch (error) {
    if (generation !== netGeneration) return;
    pendingNet = false;
    throw error;
  }
  if (generation !== netGeneration) return;
  pendingNet = false;
  const session = new GuestSession(transport);
  guest = session;
  session.onChange(() => { if (guest === session) guestChanged(session); });
  await session.join(code);
}

function guestChanged(session: GuestSession): void {
  switch (session.phase) {
    case 'lobby':
      if (screen === 'lobby') renderLobby();
      else {
        // Set the course first so the slot change below builds the right renderer once.
        prepareCourse(session.course, false);
        setLocal('guest', session.localSlot);
        enterLobby();
      }
      break;
    case 'countdown':
      if (screen === 'lobby' && !fatal) {
        launch(session.frame()?.state ?? state);
        renderer?.setRoster([...session.roster.players].sort((a, b) => a.slot - b.slot));
      }
      break;
    case 'results': {
      const final = session.finalState;
      if (screen === 'race' && final) {
        state = final;
        previous = captureRenderSnapshot(state);
        finish();
      }
      break;
    }
    case 'closed': {
      guest = null;
      const reason = session.reason;
      if (reason === 'left') break;
      if (screen === 'title') { lobby.showError(reason); break; }
      controls.setEnabled(false);
      audio.suspend();
      ui.showDisconnected(reason === 'host_lost' || reason === 'timeout'
        ? 'ホストとの接続が切れました。タイトルに戻ります。'
        : '接続が終了しました。タイトルに戻ります。');
      break;
    }
  }
  ui.setNetStatus(session.stalled && screen === 'race' ? 'ホストが離席中…' : null);
}

function enterLobby(): void {
  screen = 'lobby';
  paused = false;
  leaving = false;
  accumulator = 0;
  controls.setEnabled(false);
  audio.suspend();
  ui.show('lobby');
  renderLobby();
}

/** Lobby: builds the room's course as soon as it is known, so race_start never rebuilds the renderer.
 * Rebuilding blocks the main thread (rAF and net polling) for a moment; the lobby tolerates that. */
function prepareCourse(id: TrackId, rebuild = true): void {
  if (state.trackId !== id) {
    state = createRace(seed(), { trackId: id });
    previous = captureRenderSnapshot(state);
  }
  if (rebuild && renderer && !fatal && renderer.getTrackId() !== id) recreateRenderer(localId);
}

function renderLobby(): void {
  const session = host ?? guest;
  if (!session) return;
  if (screen === 'lobby') prepareCourse(session.course);
  lobby.render(session.roster, 'lobby');
  lobby.setCourse(session.course, host ? 'host' : 'guest');
}

function startOnline(): void {
  if (!host || fatal || screen !== 'lobby') return;
  const session = host;
  const next = session.startRace(seed());
  inputSources = next.karts.map((kart) => session.inputSource(kart.id));
  launch(next);
}

function rematch(): void {
  if (!host) return;
  host.returnToLobby();
  enterLobby();
}

/** Closes any session and invalidates create/join calls still awaiting the transport. */
function cancelOnline(): void {
  const active = pendingNet || !!host || !!guest;
  netGeneration++;
  pendingNet = false;
  const sessions = [host, guest];
  host = guest = null;
  for (const session of sessions) session?.close();
  if (active) lobby.render(null, 'idle');
}

function leaveOnline(): void {
  cancelOnline();
  title();
}

const exitToTitle = () => { if (mode === 'solo') title(); else leaveOnline(); };

const lobby = new LobbyUI(root, {
  onCreate: createRoom,
  onJoin: joinRoom,
  onLeave: leaveOnline,
  onStart: startOnline,
  onProfile: (name, color) => {
    if (host) {
      host.setProfile(name, color);
      renderLobby(); // A refused color produces no roster broadcast.
    } else guest?.updateProfile(name, color);
  },
  onCourse: (id) => {
    if (host && TRACK_IDS.includes(id as TrackId)) host.setCourse(id as TrackId);
    renderLobby(); // A refused change restores the host's actual course.
  },
}, TRACK_IDS.map((id) => ({ id, name: getTrack(id).def.name })));

root.querySelector('#course-select')?.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement) selectCourse(event.target.value as TrackId);
});

bind('start-race', start);
bind('retry-race', () => { if (mode === 'host') rematch(); else if (mode === 'solo') start(); });
bind('pause-race', () => pause(true));
bind('resume-race', () => pause(false));
bind('back-title', exitToTitle);
bind('quit-race', exitToTitle);
bind('net-dialog-ok', leaveOnline);
bind('reload-page', () => window.location.reload());
bind('mute', () => {
  muted = !muted;
  audio.setMuted(muted);
  ui.setMuted(muted);
  saveMuted(muted);
  if (!muted && screen === 'race' && !paused) void audio.unlock();
});

for (const id of ['assist-title', 'assist-pause']) {
  root.querySelector(`#${id}`)?.addEventListener('change', (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    controls.setSteerAssist(enabled);
    ui.setSteerAssist(enabled);
    saveSteerAssist(enabled);
  });
}

for (const id of ['sens-title', 'sens-pause']) {
  root.querySelector(`#${id}`)?.addEventListener('input', (event) => {
    sensitivity = Number((event.target as HTMLInputElement).value);
    controls.setSteerSensitivity(sensitivity);
    ui.setSensitivity(sensitivity);
    saveSensitivity(sensitivity);
  });
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && screen === 'race') { event.preventDefault(); pause(!(paused || leaving)); }
});
// Online play must keep running; the host only clamps the accumulator on return.
document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'solo') pause(true); });
window.addEventListener('blur', () => { if (mode === 'solo') pause(true); });
// iOS needs a gesture to start audio; a guest's race begins on a network message.
root.addEventListener('pointerdown', () => { if (mode === 'guest' && screen === 'lobby') void audio.unlock(); });
window.addEventListener('resize', () => renderer?.resize());
ui.canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  fail('3D 表示が中断されました。再読み込みして、もう一度レースをはじめてください。');
});

function frame(now: number): void {
  if (disposed) return;
  perf?.sample(now);
  const elapsed = Math.min(Math.max((now - lastTime) / 1000, 0), 0.1);
  lastTime = now;
  if (mode === 'guest') {
    const session = guest;
    if (!fatal && screen === 'race' && session) {
      accumulator += elapsed;
      // GuestSession paces its input ticks against the host clock. A tick can
      // close the session (host lost), which clears `guest` via onChange.
      while (accumulator >= FIXED_DT && guest === session) {
        session.tick(controls.sample(state, localId));
        accumulator -= FIXED_DT;
      }
      // frame() reads its own monotonic clock; never pass the rAF timestamp.
      const view = guest === session ? session.frame() : null;
      if (view) {
        state = view.state;
        previous = view.previous;
        guestAlpha = view.alpha;
        audio.playEvents(state.events);
        audio.update(state);
        ui.update(state);
      }
    } else session?.frame(); // Lobby/results: keeps PING and the 5 s host timeout running.
  } else if (!fatal && screen === 'race' && !paused) {
    // The host does not advance before the start time announced in race_start.
    const waiting = mode === 'host' && !!host && performance.now() < host.startAtHostTime;
    if (waiting) host?.frame();
    accumulator = waiting ? 0 : accumulator + elapsed;
    // No wall-clock variable step enters sim. Long background frames are paused/clamped.
    while (accumulator >= FIXED_DT && state.phase !== 'finished') {
      previous = captureRenderSnapshot(state);
      const inputs: InputFrame[] = state.karts.map((kart) => inputSources[kart.id].sample(state, kart.id));
      stepRace(state, inputs);
      // Every tick: HostSession counts ticks to schedule snapshots.
      if (mode === 'host') host?.afterTick(state);
      audio.playEvents(state.events);
      accumulator -= FIXED_DT;
    }
    audio.update(state);
    ui.update(state);
    if (state.phase === 'finished') finish();
  } else {
    host?.frame(); // Keeps RTT probes running in the lobby and results.
    guest?.frame(); // A connecting guest (still solo mode) needs its timeout/PING too.
  }
  if (!fatal && renderer) {
    const alpha = mode === 'guest' ? guestAlpha : accumulator / FIXED_DT;
    renderer.update(state, previous, screen === 'race' && !paused ? alpha : 1, paused ? 0 : elapsed, screen);
  }
  frameId = requestAnimationFrame(frame);
}

ui.show('title');
frameId = requestAnimationFrame(frame);

// This bridge is compiled away in production. It permits reproducible local browser QA.
if (import.meta.env.DEV) {
  const debug = {
    get state(): RaceState { return state; },
    get screen() { return screen; },
    get paused() { return paused; },
    get rendererInfo() { return renderer?.renderer.info; },
    get renderer() { return renderer; },
    get mode() { return mode; },
    /** Selected course: the room's course online, otherwise the title selection. */
    get course(): TrackId { return (host ?? guest)?.course ?? course; },
    render: {
      get drawCalls() { return renderer?.getDrawCalls() ?? 0; },
      get triangles() { return renderer?.renderer.info.render.triangles ?? 0; },
      get trackId() { return renderer?.getTrackId() ?? null; },
    },
    selectCourse,
    // PeerJsTransport appends its channels here (DEV only).
    net: {
      channels: [] as unknown[],
      rttMs: {} as Record<string, number>,
      get phase() { return (host ?? guest)?.phase ?? 'idle'; },
      get slot() { return localId; },
      get roster() { return (host ?? guest)?.roster ?? null; },
      /** Guest: RTT to the host. Host: RTT per guest slot. */
      get rtt() { return guest ? guest.rtt : host?.rtts ?? null; },
      get offset() { return guest?.offset ?? null; },
      get lead() { return guest?.lead ?? null; },
      get stalled() { return guest?.stalled ?? false; },
      /** Prediction correction still being blended out, and the last replay length. */
      get correction() {
        if (!guest) return null;
        const { x, y, z } = guest.visualOffset;
        return { x, y, z, meters: Math.hypot(x, y, z), replayTicks: guest.replayTicks };
      },
    },
    start,
    advance(ticks: number, autopilot = false) {
      for (let i = 0; i < Math.min(ticks, 60 * 600) && state.phase !== 'finished'; i++) {
        stepRace(state, state.karts.map((kart) => autopilot || kart.id > 0 ? getAIInput(state, kart.id) : controls.sample(state, kart.id)));
        if (mode === 'host') host?.afterTick(state);
      }
      previous = captureRenderSnapshot(state);
      ui.update(state);
      if (state.phase === 'finished' && screen === 'race') finish();
    },
  };
  Object.assign(window, { __kartDebug: debug });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  cancelAnimationFrame(frameId);
  host?.close();
  guest?.close();
  lobby.destroy();
  controls.dispose();
  audio.dispose();
  renderer?.dispose();
  perf?.dispose();
});
