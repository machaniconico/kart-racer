import './style.css';
import { AudioEngine } from './audio/AudioEngine';
import { Controls } from './input/Controls';
import { GhostPlayer } from './ghost/player';
import { CHECKPOINT_INTERVAL, GhostRecorder } from './ghost/record';
import { loadBestLap, loadGhost, saveBestLap, saveGhost } from './ghost/storage';
import { GuestSession } from './net/guestSession';
import { HostSession, RendererRebuild } from './net/hostSession';
import { generateRoomCode } from './net/roomCode';
import type { Transport } from './net/transport';
import type { ImpairingTransport, ImpairmentProfile } from './net/impairedLink';
import { GameRenderer } from './render/GameRenderer';
import { kartRotationZ } from './render/kartRoll';
import { captureRenderSnapshot } from './render/snapshot';
import type { RenderSnapshot } from './render/snapshot';
import { createGrandPrix, CUPS, isComplete, nextTrack, recordRace, standings } from './gp/grandPrix';
import type { GrandPrix } from './gp/grandPrix';
import { createRace, FIXED_DT, getAIInput, getTrack, projectToTrack, rollAt, sampleTrack, slopeAt, stepRace, surfaceHeightAt, TRACK_IDS } from './sim';
import { widthAt } from './sim/corridor';
import { DEFAULT_LAPS, isLapCount } from './sim/laps';
import { isCpuLevel } from './sim';
import type { CpuLevel, InputFrame, InputSource, RaceState, TrackId } from './sim';
import { GameUI } from './ui/GameUI';
import type { PlayMode } from './ui/GameUI';
import { GrandPrixUI } from './ui/GrandPrixUI';
import { LobbyUI } from './ui/LobbyUI';
import { loadBest, loadCpuLevel, loadMuted, loadSensitivity, loadSteerAssist, saveBest, saveCpuLevel, saveMuted, saveSensitivity, saveSteerAssist } from './storage';

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
let soloLaps = DEFAULT_LAPS;
const PLAY_MODES: readonly PlayMode[] = ['race', 'gp', 'timeattack'];
/** Title play mode; not persisted. */
let playMode: PlayMode = 'race';
let cpuLevel: CpuLevel = loadCpuLevel();
ui.setCpuLevel(cpuLevel);
let cupId: string = CUPS[0].id;
/** The Grand Prix in progress; only in memory, so a reload or return to title discards it. */
let gp: GrandPrix | null = null;
const gpUi = new GrandPrixUI(root, { onNext: gpNext });
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

function seed(): number {
  try { return crypto.getRandomValues(new Uint32Array(1))[0]; }
  catch { return Date.now() >>> 0; }
}

let state = createRace(seed(), { trackId: course, laps: soloLaps, cpuLevel });
ui.setCourse(course, loadBest(course, getTrack(course).def.layoutVersion ?? 1, state.laps));
const cpuSource: InputSource = { sample: getAIInput };
const soloSources: InputSource[] = state.karts.map((kart) => kart.id === 0 ? controls : cpuSource);
// The host swaps in HostSession.inputSource(slot); solo keeps controls + CPU.
let inputSources = soloSources;
let previous = captureRenderSnapshot(state);
let rendererBuilds = 0;
let screen: 'title' | 'lobby' | 'race' | 'results' | 'standings' = 'title';
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
/** Debug builds only: the current session's transport wrapper and the profile set through __kartDebug.net.impair. */
let impairing: ImpairingTransport | null = null;
let impairment: ImpairmentProfile | null = null;
/** Guest: times the current session went from not stalled to stalled (debug counter, reset per session). */
let stallCount = 0;
let wasStalled = false;
/** Each online session (host or guest) and the return to solo starts the stall counter over. */
function resetStallCount(): void {
  stallCount = 0;
  wasStalled = false;
}
/** Longest gap between consecutive rAF timestamps since the last reset (debug, always measured). */
let frameGapMax = 0;
let frameGapLast: number | null = null;
// Time attack only: the kart-0 input recorder and the best run's replay.
let recorder: GhostRecorder | null = null;
let lastCheckpointTick = -1;
let ghost: GhostPlayer | null = null;
let ghostPrevious: RenderSnapshot | null = null;
// Fall respawns on every tick of the latest frame that stepped (state.events only holds the last
// tick), kept through frames that run no tick. Valid only with the `previous` they were taken for.
let respawned = new Set<number>();
let respawnedFor: RenderSnapshot | null = null;
let ghostRespawned = false;
let ghostRecordTime: number | null = null;
/** Invalidates a pending create/join when the player cancels or leaves. */
let netGeneration = 0;
/** A create/join is awaiting the transport (no session object exists yet). */
let pendingNet = false;
/** Online "leave?" confirmation; unlike pause it never stops the simulation. */
let leaving = false;
let guestAlpha = 1;
/** Defers lobby rebuilds and gates drawing on the GPU so net polling continues (C-010, M6-07). */
const rendererRebuild = new RendererRebuild();

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
  if (playMode === 'gp') {
    gp = createGrandPrix(cupId, soloLaps, cpuLevel);
    clearTimeAttack();
    inputSources = soloSources;
    launch(createRace(seed(), { trackId: nextTrack(gp)!, laps: soloLaps, cpuLevel }));
  } else if (playMode === 'timeattack') {
    gp = null;
    const raceSeed = seed();
    const next = createRace(raceSeed, { trackId: course, laps: soloLaps, karts: 1, itemBoxes: false });
    const layout = getTrack(course).def.layoutVersion ?? 1;
    recorder = new GhostRecorder({ trackId: course, layout, laps: soloLaps, seed: raceSeed });
    recorder.checkpoint(next.tick, next);
    lastCheckpointTick = next.tick;
    const record = loadGhost(course, layout, soloLaps);
    ghost = null;
    ghostRecordTime = null;
    if (record) {
      try {
        ghost = new GhostPlayer(record);
        ghostRecordTime = record.time;
      } catch (error) { console.warn('The saved ghost could not be replayed.', error); }
    }
    ghostPrevious = ghost && captureRenderSnapshot(ghost.state);
    inputSources = [controls];
    launch(next);
    renderer?.setRoster(next.karts);
    renderer?.setGhost(ghost !== null);
  } else {
    gp = null;
    clearTimeAttack();
    inputSources = soloSources;
    launch(createRace(seed(), { trackId: course, laps: soloLaps, cpuLevel }));
  }
}

function clearTimeAttack(): void {
  recorder = null;
  lastCheckpointTick = -1;
  ghost = null;
  ghostPrevious = null;
  ghostRecordTime = null;
  renderer?.setGhost(false);
}

/** Time attack's title record line; the other modes keep loadBest from setCourse / setLaps. */
function showTimeAttackBest(): void {
  if (playMode !== 'timeattack') return;
  const layout = getTrack(course).def.layoutVersion ?? 1;
  ui.setTimeAttackBest(loadGhost(course, layout, soloLaps)?.time ?? null, loadBestLap(course, layout));
}

/** Results -> Grand Prix standings. */
function showStandings(): void {
  if (!gp || screen !== 'results' || fatal) return;
  gpUi.render(gp, localId);
  gpUi.show();
  ui.show('standings');
  screen = 'standings';
}

/** Standings -> next race, or back to the title after the podium. */
function gpNext(): void {
  if (!gp || screen !== 'standings' || fatal) return;
  const trackId = nextTrack(gp);
  if (isComplete(gp) || trackId === null) { title(); return; }
  gpUi.hide();
  launch(createRace(seed(), { trackId, laps: gp.laps, cpuLevel: gp.cpuLevel }));
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
  // Online rooms may switch item boxes off; solo modes always keep the item HUD (time attack hides it itself).
  ui.setItems(mode === 'solo' || ((host ?? guest)?.settings.items ?? true));
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
    resetStallCount();
    lobby.render(null, 'idle');
  }
  ui.hideDisconnected();
  clearTimeAttack();
  gp = null;
  gpUi.hide();
  leaving = false;
  screen = 'title';
  paused = false;
  accumulator = 0;
  const previousKarts = state.karts.length;
  state = createRace(seed(), { trackId: titleTrack(), laps: soloLaps, cpuLevel });
  previous = captureRenderSnapshot(state);
  if (renderer && !fatal && renderer.getTrackId() !== state.trackId) recreateRenderer(localId);
  else if (wasOnline || previousKarts !== state.karts.length) renderer?.setRoster(state.karts);
  controls.setEnabled(false);
  audio.suspend();
  ui.setPaused(false);
  ui.setCourse(course, loadBest(course, getTrack(course).def.layoutVersion ?? 1, state.laps));
  showTimeAttackBest();
  ui.show('title');
}

function selectCourse(id: TrackId): void {
  if (screen !== 'title' || fatal || id === course || !TRACK_IDS.includes(id)) return;
  course = id;
  // The title background shows the selected course.
  state = createRace(seed(), { trackId: course, laps: soloLaps, cpuLevel });
  previous = captureRenderSnapshot(state);
  if (renderer && renderer.getTrackId() !== state.trackId) recreateRenderer(localId);
  ui.setCourse(course, loadBest(course, getTrack(course).def.layoutVersion ?? 1, state.laps));
  showTimeAttackBest();
}

/** Title background: the selected course, or the cup's first course in Grand Prix. */
function titleTrack(): TrackId {
  return playMode === 'gp' ? CUPS.find((cup) => cup.id === cupId)!.tracks[0] : course;
}

function showTitleTrack(): void {
  if (state.trackId === titleTrack()) return;
  state = createRace(seed(), { trackId: titleTrack(), laps: soloLaps, cpuLevel });
  previous = captureRenderSnapshot(state);
  if (renderer && !fatal && renderer.getTrackId() !== state.trackId) recreateRenderer(localId);
}

function setPlayMode(next: PlayMode): void {
  if (screen !== 'title' || fatal || !PLAY_MODES.includes(next)) return;
  playMode = next;
  for (const input of root.querySelectorAll<HTMLInputElement>('#mode-select input')) input.checked = input.value === next;
  ui.setPlayMode(next);
  if (next === 'timeattack') showTimeAttackBest();
  else ui.setLaps(soloLaps, loadBest(course, getTrack(course).def.layoutVersion ?? 1, soloLaps));
  showTitleTrack();
}

function setCpuLevel(level: CpuLevel): void {
  if (screen !== 'title' || fatal || !isCpuLevel(level)) return;
  cpuLevel = level;
  saveCpuLevel(level);
  ui.setCpuLevel(level);
}

function setCup(id: string): void {
  if (screen !== 'title' || fatal || !CUPS.some((cup) => cup.id === id)) return;
  cupId = id;
  ui.setCup(id);
  if (playMode === 'gp') showTitleTrack();
}

function finish(): void {
  screen = 'results';
  controls.setEnabled(false);
  audio.finishRace();
  const time = state.karts.find((kart) => kart.id === localId)?.finishTime ?? null;
  if (recorder) {
    finishTimeAttack();
    ui.show('results');
    return;
  }
  const previousBest = loadBest(state.trackId, getTrack(state.trackId).def.layoutVersion ?? 1, state.laps);
  // Online races never update the personal best.
  const isRecord = mode === 'solo' && time !== null && (previousBest === null || time < previousBest);
  if (isRecord) saveBest(state.trackId, time, getTrack(state.trackId).def.layoutVersion ?? 1, state.laps);
  if (mode !== 'solo') lobby.render((host ?? guest)?.roster ?? null, 'results');
  if (gp && mode === 'solo') gp = recordRace(gp, state);
  ui.showResults(state, isRecord ? time : previousBest, isRecord);
  ui.show('results');
}

/** Time attack never touches best.v4: it keeps its own record (the ghost) and best lap. */
function finishTimeAttack(): void {
  const layout = getTrack(state.trackId).def.layoutVersion ?? 1;
  const record = recorder!.finish(state);
  recorder = null;
  const previousBest = loadGhost(state.trackId, layout, state.laps)?.time ?? null;
  const isRecord = record !== null && (previousBest === null || record.time < previousBest);
  if (isRecord) saveGhost(record);
  const lapTimes = state.karts[0]!.lapTimes;
  const lap = lapTimes.length > 0 ? Math.min(...lapTimes) : null;
  const previousLap = loadBestLap(state.trackId, layout);
  const isLapRecord = lap !== null && (previousLap === null || lap < previousLap);
  if (isLapRecord) saveBestLap(state.trackId, layout, lap);
  ui.showResults(state, isRecord ? record.time : previousBest, isRecord, { bestLap: isLapRecord ? lap : previousLap, isLapRecord });
}

const bind = (id: string, handler: () => void) => root.querySelector(`#${id}`)?.addEventListener('click', handler);
/** Recreates the local-kart-bound renderer/audio when the guest slot differs. */
function setLocal(next: typeof mode, id: number): void {
  mode = next;
  // Online is always a plain race (its CPU level / CPU fill / items come from the lobby settings);
  // returning to solo restores the title's selected mode.
  // Before setMode so the retry label follows the restored play mode.
  if (next !== 'solo') {
    gp = null;
    gpUi.hide();
  }
  ui.setPlayMode(next === 'solo' ? playMode : 'race');
  ui.setMode(next, id);
  if (id === localId) return;
  localId = id;
  audio.dispose();
  audio = new AudioEngine(id);
  audio.setMuted(muted);
  if (next === 'guest') void audio.unlock();
  recreateRenderer(id);
}

/**
 * Rebuilds the renderer for the current state's course and the given local kart on the same WebGLRenderer.
 * Order matters: build the new scene and draw it once while the old scene still holds its programs, then
 * dispose the old scene. Disposing first would drop program usedTimes to 0 and force a full recompile.
 * disposeScene() keeps itemVisuals' module-scope shared materials (see GameRenderer.disposeScene).
 */
function recreateRenderer(id: number): void {
  if (!renderer || fatal) return;
  rendererBuilds++;
  // Kept although the WebGLRenderer is now reused (so its unpack state is three's own): resetting
  // to the defaults three assumes is harmless and guards against anything else touching the context.
  const gl = renderer.renderer.getContext();
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const old = renderer;
  let next: GameRenderer | undefined;
  try {
    next = new GameRenderer(ui.canvas, state, id, { webgl: old.renderer });
    // Draw once now so any remaining shader compilation happens inside this one main-thread stall.
    next.update(state, captureRenderSnapshot(state), 1, 0, rendererScreen());
    // The current GameRenderer always owns the WebGLRenderer, so HMR/page-exit dispose() frees it.
    old.transferRendererTo(next);
    renderer = next;
    old.disposeScene();
    const gl2 = renderer.renderer.getContext();
    if (gl2 instanceof WebGL2RenderingContext) {
      // Drawing before this fence signals would block the main thread on the GPU.
      const fence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl2.flush();
      if (fence) rendererRebuild.waitFor(() => {
        // A non-blocking status read.
        if (!gl2.isContextLost() && gl2.getSyncParameter(fence, gl2.SYNC_STATUS) !== gl2.SIGNALED) return false;
        gl2.deleteSync(fence);
        return true;
      });
    }
  } catch (error) {
    // Exactly one GameRenderer owns the WebGLRenderer: old before the transfer, next after it.
    if (renderer === old) {
      next?.disposeScene();
      old.dispose();
    } else {
      renderer?.dispose();
    }
    renderer = undefined;
    console.error('The 3D renderer could not restart.', error);
    fail('3D 表示を開始できませんでした。ページを再読み込みしてください。');
  }
  // The rebuild blocked PONG/snapshot handling; it must not read as host silence.
  guest?.excuseStall();
}

/** GameRenderer has no standings view; it keeps the results camera there. */
function rendererScreen(): 'title' | 'lobby' | 'race' | 'results' {
  return screen === 'standings' ? 'results' : screen;
}

/** One fixed simulation tick; frame() and the debug advance() both go through here. */
function stepOnce(inputs: InputFrame[]): void {
  if (recorder) {
    // Time attack: kart 0 drives the quantized input the ghost will replay. quantizeInput does not clamp.
    const own = inputs[0]!;
    inputs = [recorder.push({ ...own, steer: Math.max(-1, Math.min(1, own.steer)), throttle: Math.max(0, Math.min(1, own.throttle)) }), ...inputs.slice(1)];
  }
  stepRace(state, inputs);
  if (recorder && state.tick % CHECKPOINT_INTERVAL === 0 && state.tick > lastCheckpointTick) {
    recorder.checkpoint(state.tick, state);
    lastCheckpointTick = state.tick;
  }
  if (ghost) {
    ghostPrevious = captureRenderSnapshot(ghost.state);
    ghost.step();
    if (ghost.state.events.some((event) => event.type === 'fall' && event.kartId === 0)) ghostRespawned = true;
  }
  // Every tick: HostSession counts ticks to schedule snapshots.
  if (mode === 'host') host?.afterTick(state);
}

async function loadTransport(): Promise<Transport> {
  // Keep peerjs out of the single-player initial chunk.
  const { PeerJsTransport } = await import('./net/peerjsTransport');
  const transport = new PeerJsTransport();
  // Statically false in production, so the impairment module is never bundled there.
  if (import.meta.env.DEV || import.meta.env.VITE_KART_DEBUG === '1') {
    const { ImpairingTransport } = await import('./net/impairedLink');
    impairing = new ImpairingTransport(transport);
    impairing.setProfile(impairment);
    return impairing;
  }
  return transport;
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
  resetStallCount();
  session.setCourse(course);
  // The title's CPU level seeds the room; the host changes it in the lobby.
  session.setCpuLevel(cpuLevel);
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
  resetStallCount();
  session.onChange(() => { if (guest === session) guestChanged(session); });
  await session.join(code);
}

function guestChanged(session: GuestSession): void {
  if (session.stalled && !wasStalled) stallCount++;
  wasStalled = session.stalled;
  switch (session.phase) {
    case 'lobby':
      if (screen === 'lobby') {
        // The race's local kart ID follows the lobby roster/CPU fill. Rebinding here, in the lobby, keeps the
        // renderer rebuild out of the countdown (start-dash window); with CPU fill it always equals the slot.
        if (session.localKartId !== localId) setLocal('guest', session.localKartId);
        renderLobby();
      } else {
        // Set the course first so the slot change below builds the right renderer once.
        prepareCourse(session.course, false);
        setLocal('guest', session.localKartId);
        enterLobby();
      }
      break;
    case 'countdown':
      if (screen === 'lobby' && !fatal) {
        // The lobby already bound the renderer to this kart ID; rebinding now would stall the countdown.
        if (session.localKartId !== localId) {
          console.warn(`Renderer rebound at race start (kart ${localId} -> ${session.localKartId}); the lobby did not prepare it.`);
          setLocal('guest', session.localKartId);
        }
        launch(session.frame()?.state ?? state);
        renderer?.setRoster(session.raceRoster);
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
 * Rebuilding blocks the main thread (rAF and net polling) for a moment; the lobby tolerates that.
 * The rebuild waits for the next frame so the course message or change event that triggered it
 * finishes first: its DOM update and sends are not held behind the stall. */
function prepareCourse(id: TrackId, rebuild = true): void {
  if (state.trackId !== id) {
    state = createRace(seed(), { trackId: id });
    previous = captureRenderSnapshot(state);
  }
  if (rebuild && renderer && !fatal && renderer.getTrackId() !== id) rendererRebuild.request();
}

function renderLobby(): void {
  const session = host ?? guest;
  if (!session) return;
  if (screen === 'lobby') prepareCourse(session.course);
  lobby.render(session.roster, 'lobby');
  lobby.setCourse(session.course, host ? 'host' : 'guest');
  lobby.setLaps(session.laps, host ? 'host' : 'guest');
  lobby.setSettings(session.settings, host ? 'host' : 'guest');
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
  onLaps: (laps) => {
    host?.setLaps(laps);
    renderLobby();
  },
  // A refused change (outside the lobby) re-renders the host's actual settings.
  onCpuLevel: (level) => {
    host?.setCpuLevel(level);
    renderLobby();
  },
  onCpuFill: (fill) => {
    host?.setCpuFill(fill);
    renderLobby();
  },
  onItems: (items) => {
    host?.setItems(items);
    renderLobby();
  },
  onCourse: (id) => {
    if (host && TRACK_IDS.includes(id as TrackId)) host.setCourse(id as TrackId);
    renderLobby(); // A refused change restores the host's actual course.
  },
}, TRACK_IDS.map((id) => ({ id, name: getTrack(id).def.name })));

root.querySelector('#course-select')?.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement) selectCourse(event.target.value as TrackId);
});

root.querySelector('#laps-select')?.addEventListener('change', (event) => {
  if (!(event.target instanceof HTMLInputElement) || screen !== 'title' || fatal) return;
  const laps = Number(event.target.value);
  if (!isLapCount(laps)) return;
  soloLaps = laps;
  state = createRace(seed(), { trackId: titleTrack(), laps: soloLaps, cpuLevel });
  previous = captureRenderSnapshot(state);
  ui.setLaps(laps, loadBest(course, getTrack(course).def.layoutVersion ?? 1, state.laps));
  showTimeAttackBest();
});

root.querySelector('#mode-select')?.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement) setPlayMode(event.target.value as PlayMode);
});

root.querySelector('#cup-select')?.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement) setCup(event.target.value);
});

root.querySelector('#cpu-select')?.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement) setCpuLevel(event.target.value as CpuLevel);
});

bind('start-race', start);
// Grand Prix: the results' primary action leads to the standings instead of a retry.
bind('retry-race', () => { if (mode === 'host') rematch(); else if (mode === 'solo') { if (gp) showStandings(); else start(); } });
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
  if (frameGapLast !== null) frameGapMax = Math.max(frameGapMax, now - frameGapLast);
  frameGapLast = now;
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
        respawned = new Set(view.respawned);
        respawnedFor = previous;
        audio.playEvents(state.events);
        ui.noteEvents(state.events);
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
    let stepped = false;
    while (accumulator >= FIXED_DT && state.phase !== 'finished') {
      if (!stepped) { respawned = new Set(); ghostRespawned = false; stepped = true; }
      previous = captureRenderSnapshot(state);
      const inputs: InputFrame[] = state.karts.map((kart) => inputSources[kart.id].sample(state, kart.id));
      stepOnce(inputs);
      for (const event of state.events) if (event.type === 'fall') respawned.add(event.kartId);
      audio.playEvents(state.events);
      ui.noteEvents(state.events);
      accumulator -= FIXED_DT;
    }
    if (stepped) respawnedFor = previous;
    audio.update(state);
    ui.update(state);
    if (state.phase === 'finished') finish();
  } else {
    host?.frame(); // Keeps RTT probes running in the lobby and results.
    guest?.frame(); // A connecting guest (still solo mode) needs its timeout/PING too.
  }
  const draw = rendererRebuild.frame(() => {
    if (screen === 'lobby' && renderer && !fatal && renderer.getTrackId() !== state.trackId) recreateRenderer(localId);
  });
  if (!fatal && renderer && draw) {
    const alpha = mode === 'guest' ? guestAlpha : accumulator / FIXED_DT;
    const drawAlpha = screen === 'race' && !paused ? alpha : 1;
    const showGhost = ghost && !ghost.diverged && screen === 'race';
    renderer.updateGhost(showGhost ? ghost!.state.karts[0]! : null, showGhost ? ghostPrevious?.karts[0] ?? null : null, drawAlpha, paused ? 0 : elapsed,
      ghostRespawned && respawnedFor === previous);
    renderer.update(state, previous, drawAlpha, paused ? 0 : elapsed, rendererScreen(),
      respawnedFor === previous ? respawned : new Set());
  }
  frameId = requestAnimationFrame(frame);
}

ui.show('title');
frameId = requestAnimationFrame(frame);

// This bridge is compiled away unless development or the explicit E2E mode enables it.
function createDebugBridge() {
  return {
    modules: { createRace, captureRenderSnapshot, getTrack, FIXED_DT, rollAt, sampleTrack, slopeAt },
    get state(): RaceState { return state; },
    get screen() { return screen; },
    get paused() { return paused; },
    get rendererInfo() { return renderer?.renderer.info; },
    get renderer() { return renderer; },
    get cameraPosition() { return renderer?.getCameraPosition(); },
    get cameraGroundY() {
      if (!renderer) return undefined;
      const player = state.karts.find(kart => kart.id === localId)!;
      const track = getTrack(state.trackId);
      const cam = renderer.getCameraPosition();
      const p = projectToTrack(track, cam.x, cam.z, player.trackDistance);
      const { wallHalfWidth } = widthAt(track, p.distance);
      const offset = Math.max(-wallHalfWidth, Math.min(wallHalfWidth, p.offset));
      return surfaceHeightAt(track, p.distance, offset);
    },
    get playerRoll() {
      const player = state.karts.find(kart => kart.id === localId)!;
      return kartRotationZ(getTrack(state.trackId), player.trackDistance);
    },
    get mode() { return mode; },
    /** Selected course: the room's course online, otherwise the title selection. */
    get course(): TrackId { return (host ?? guest)?.course ?? course; },
    render: {
      get courseGroup() { return renderer?.courseGroup; },
      get drawCalls() { return renderer?.getDrawCalls() ?? 0; },
      get triangles() { return renderer?.renderer.info.render.triangles ?? 0; },
      get trackId() { return renderer?.getTrackId() ?? null; },
      /** Renderer rebuilds so far (recreateRenderer calls); e2e checks none happens at race start. */
      get builds() { return rendererBuilds; },
      get programCount() { return renderer?.programCount ?? null; },
      get ghost() { return renderer ? { visible: renderer.ghostVisible, wheelSpin: renderer.ghostWheelSpin } : null; },
    },
    selectCourse,
    get playMode() { return playMode; },
    get cpuLevel() { return cpuLevel; },
    get ghost() {
      return ghost && {
        active: !ghost.diverged && !ghost.finished, diverged: ghost.diverged, tick: ghost.state.tick,
        speed: ghost.state.karts[0]!.speed, finished: ghost.finished, finishTime: ghost.finishTime, recordTime: ghostRecordTime,
      };
    },
    timeAttackRecord(trackId: TrackId, laps: number) {
      if (!TRACK_IDS.includes(trackId)) return null;
      const record = loadGhost(trackId, getTrack(trackId).def.layoutVersion ?? 1, laps);
      return record && { time: record.time, ticks: record.ticks };
    },
    get gp() { return gp && { cupId: gp.cupId, raceIndex: gp.raceIndex, standings: standings(gp) }; },
    setPlayMode,
    setCpuLevel,
    setCup,
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
      /** Guest: times this session became stalled; reset when a new session joins. */
      get stallCount() { return stallCount; },
      /** Guest: current (adaptive) interpolation delay and render-time regressions. */
      get renderDelayMs() { return guest?.renderDelayMs ?? null; },
      get jitterStats() { return guest?.latenessStats ?? null; },
      get renderTimeRegressions() { return guest?.renderTimeRegressions ?? null; },
      /** Impairs the current and later transports' links; null restores a clean link. */
      async impair(profile: ImpairmentProfile | null) {
        if (!(import.meta.env.DEV || import.meta.env.VITE_KART_DEBUG === '1')) return;
        const { ImpairingTransport } = await import('./net/impairedLink');
        // setProfile validates and throws on an invalid profile, so nothing invalid is stored for later
        // transports. Without a live wrapper, an unattached one validates (it never touches its inner transport).
        (impairing ?? new ImpairingTransport(null as unknown as Transport)).setProfile(profile);
        // A copy, so later caller mutations cannot reach transports created afterwards.
        impairment = profile && { ...profile, bursts: profile.bursts && { ...profile.bursts } };
      },
      /** Blocks the main thread (a simulated hitch), capped at 10 s. */
      busyWait(ms: number) {
        const end = performance.now() + Math.min(Math.max(ms, 0), 10_000);
        while (performance.now() < end) { /* spin */ }
      },
      /** Prediction correction still being blended out, and the last replay length. */
      get correction() {
        if (!guest) return null;
        const { x, y, z } = guest.visualOffset;
        return { x, y, z, meters: Math.hypot(x, y, z), replayTicks: guest.replayTicks };
      },
    },
    frameGap: {
      get maxMs() { return frameGapMax; },
      reset() { frameGapMax = 0; },
    },
    start,
    clearItems() {
      state.projectiles = [];
      state.traps = [];
      for (const kart of state.karts) kart.item = null;
    },
    advance(ticks: number, autopilot = false) {
      for (let i = 0; i < Math.min(ticks, 60 * 600) && state.phase !== 'finished'; i++) {
        stepOnce(state.karts.map((kart) => autopilot || kart.id > 0 ? getAIInput(state, kart.id) : controls.sample(state, kart.id)));
      }
      previous = captureRenderSnapshot(state);
      if (ghost) ghostPrevious = captureRenderSnapshot(ghost.state);
      ui.update(state);
      if (state.phase === 'finished' && screen === 'race') finish();
    },
  };
}

export type KartDebug = ReturnType<typeof createDebugBridge>;

if (import.meta.env.DEV || import.meta.env.VITE_KART_DEBUG === '1') {
  Object.assign(window, { __kartDebug: createDebugBridge() });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  cancelAnimationFrame(frameId);
  host?.close();
  guest?.close();
  lobby.destroy();
  gpUi.destroy();
  controls.dispose();
  audio.dispose();
  renderer?.dispose();
  perf?.dispose();
});
