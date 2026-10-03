import './style.css';
import { AudioEngine } from './audio/AudioEngine';
import { Controls } from './input/Controls';
import { GameRenderer } from './render/GameRenderer';
import { createRace, FIXED_DT, getAIInput, stepRace } from './sim';
import type { InputFrame, InputSource, Pose, RaceState } from './sim';
import { GameUI } from './ui/GameUI';
import { loadBest, loadMuted, saveBest, saveMuted } from './storage';

const root = document.querySelector<HTMLDivElement>('#app')!;
const ui = new GameUI(root);
const controls = new Controls(root);
root.classList.toggle('touch-device', controls.isTouch);
const audio = new AudioEngine();
let best = loadBest();
let muted = loadMuted();
audio.setMuted(muted);
ui.setMuted(muted);
ui.setBest(best);

function seed(): number {
  try { return crypto.getRandomValues(new Uint32Array(1))[0]; }
  catch { return Date.now() >>> 0; }
}

let state = createRace(seed());
const cpuSource: InputSource = { sample: getAIInput };
// A future network source can implement this same sample(state, kartId) boundary.
const inputSources: InputSource[] = state.karts.map((kart) => kart.id === 0 ? controls : cpuSource);
let previous: Pose[] = state.karts.map((kart) => ({ ...kart }));
let screen: 'title' | 'race' | 'results' = 'title';
let paused = false;
let accumulator = 0;
let lastTime = performance.now();
let frameId = 0;
let disposed = false;
let renderer: GameRenderer | undefined;
let fatal = false;

function fail(message: string): void {
  fatal = true;
  controls.setEnabled(false);
  audio.suspend();
  ui.showError(message);
}

try {
  renderer = new GameRenderer(ui.canvas, state);
} catch (error) {
  console.error('The 3D renderer could not start.', error);
  fail('3D 表示を開始できませんでした。WebGL に対応したブラウザで、ハードウェアアクセラレーションを有効にして再読み込みしてください。');
}

function start(): void {
  if (fatal) return;
  state = createRace(seed());
  previous = state.karts.map((kart) => ({ ...kart }));
  accumulator = 0;
  lastTime = performance.now();
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

function title(): void {
  screen = 'title';
  paused = false;
  accumulator = 0;
  state = createRace(seed());
  previous = state.karts.map((kart) => ({ ...kart }));
  controls.setEnabled(false);
  audio.suspend();
  ui.setPaused(false);
  ui.setBest(best);
  ui.show('title');
}

function finish(): void {
  screen = 'results';
  controls.setEnabled(false);
  audio.finishRace();
  const time = state.karts[0].finishTime ?? state.time;
  const isRecord = best === null || time < best;
  if (isRecord) { best = time; saveBest(time); }
  ui.showResults(state, best, isRecord);
  ui.show('results');
}

const bind = (id: string, handler: () => void) => root.querySelector(`#${id}`)?.addEventListener('click', handler);
bind('start-race', start);
bind('retry-race', start);
bind('pause-race', () => pause(true));
bind('resume-race', () => pause(false));
bind('back-title', title);
bind('quit-race', title);
bind('reload-page', () => window.location.reload());
bind('mute', () => {
  muted = !muted;
  audio.setMuted(muted);
  ui.setMuted(muted);
  saveMuted(muted);
  if (!muted && screen === 'race' && !paused) void audio.unlock();
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && screen === 'race') { event.preventDefault(); pause(!paused); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(true); });
window.addEventListener('blur', () => pause(true));
window.addEventListener('resize', () => renderer?.resize());
ui.canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  fail('3D 表示が中断されました。再読み込みして、もう一度レースをはじめてください。');
});

function frame(now: number): void {
  if (disposed) return;
  const elapsed = Math.min(Math.max((now - lastTime) / 1000, 0), 0.1);
  lastTime = now;
  if (!fatal && screen === 'race' && !paused) {
    accumulator += elapsed;
    // No wall-clock variable step enters sim. Long background frames are paused/clamped.
    while (accumulator >= FIXED_DT && state.phase !== 'finished') {
      previous = state.karts.map(({ x, y, z, heading }) => ({ x, y, z, heading }));
      const inputs: InputFrame[] = state.karts.map((kart) => inputSources[kart.id].sample(state, kart.id));
      stepRace(state, inputs);
      audio.playEvents(state.events);
      accumulator -= FIXED_DT;
    }
    audio.update(state);
    ui.update(state);
    if (state.phase === 'finished') finish();
  }
  if (!fatal && renderer) {
    renderer.update(state, previous, screen === 'race' && !paused ? accumulator / FIXED_DT : 1, paused ? 0 : elapsed, screen);
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
    start,
    advance(ticks: number, autopilot = false) {
      for (let i = 0; i < Math.min(ticks, 60 * 600) && state.phase !== 'finished'; i++) {
        stepRace(state, state.karts.map((kart) => autopilot || kart.id > 0 ? getAIInput(state, kart.id) : controls.sample(state, kart.id)));
      }
      previous = state.karts.map((kart) => ({ ...kart }));
      ui.update(state);
      if (state.phase === 'finished' && screen === 'race') finish();
    },
  };
  Object.assign(window, { __kartDebug: debug });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  cancelAnimationFrame(frameId);
  controls.dispose();
  audio.dispose();
  renderer?.dispose();
});
