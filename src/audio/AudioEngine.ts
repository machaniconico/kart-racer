import type { RaceEvent, RaceState } from '../sim/types';
import { playItemEvent, playRouletteSound, type SoundKit } from './itemSounds';

/** Small original WebAudio instruments; no audio files or network requests. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineOscillator: OscillatorNode | null = null;
  private engineHarmonic: OscillatorNode | null = null;
  private driftGain: GainNode | null = null;
  private driftFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly continuousSources: AudioScheduledSourceNode[] = [];
  private readonly effects = new Set<AudioScheduledSourceNode>();
  private muted = false;
  private disposed = false;
  private active = false;
  private resumePending = false;
  private lastResumeAttempt = -Infinity;

  private readonly kit: SoundKit = {
    tone: (...args) => this.tone(...args),
    noise: (...args) => this.noise(...args),
  };

  constructor(private readonly localKartId: number) {}

  /** Call directly from the Start/Retry/Resume button's user gesture. */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.context) this.initialize();
      if (this.context?.state === 'suspended') await this.context.resume();
    } catch {
      // Racing remains fully playable when audio is unavailable or blocked.
    }
  }

  setMuted(value: boolean): void {
    this.muted = value;
    if (this.context && this.master) {
      this.master.gain.setTargetAtTime(value || !this.active ? 0 : 0.45, this.context.currentTime, 0.03);
    }
  }

  update(state: RaceState): void {
    if (this.disposed || !this.context || !this.master) return;
    if (state.phase === 'finished') {
      this.finishRace();
      return;
    }
    const player = state.karts.find((kart) => kart.id === this.localKartId);
    if (!player) return;
    this.active = true;
    if (this.context.state === 'suspended' && !this.resumePending && performance.now() - this.lastResumeAttempt > 1000) {
      this.resumePending = true;
      this.lastResumeAttempt = performance.now();
      void this.context.resume().catch(() => {}).finally(() => { this.resumePending = false; });
    }
    const time = this.context.currentTime;
    const speed = Math.min(1.4, Math.abs(player.speed) / 42);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.45, time, 0.04);
    this.engineOscillator?.frequency.setTargetAtTime(48 + speed * 118, time, 0.1);
    this.engineHarmonic?.frequency.setTargetAtTime(96 + speed * 236, time, 0.1);
    this.engineGain?.gain.setTargetAtTime(state.phase === 'racing' ? 0.09 + speed * 0.045 : 0.045, time, 0.08);
    const drifting = player.driftTime > 0 && player.spinTime <= 0 && state.phase === 'racing';
    this.driftGain?.gain.setTargetAtTime(drifting ? 0.10 + Math.min(player.driftTime, 2) * 0.03 : 0, time, 0.04);
    this.driftFilter?.frequency.setTargetAtTime(650 + speed * 800 + player.driftTime * 160, time, 0.08);
  }

  playEvents(events: RaceEvent[]): void {
    if (!this.context || this.disposed || this.muted || !this.active || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    for (const event of events) {
      const affected = (event.type === 'explode' || event.type === 'ink' || event.type === 'storm') &&
        ((event.value ?? 0) & (1 << this.localKartId)) !== 0;
      if (event.kartId !== this.localKartId && event.type !== 'countdown' && event.type !== 'go' && !affected) continue;
      switch (event.type) {
        case 'countdown':
          this.tone(440, now, 0.13, 0.24, 'sine');
          break;
        case 'go':
          this.tone(880, now, 0.32, 0.24, 'triangle');
          this.tone(1320, now, 0.28, 0.1, 'sine');
          break;
        case 'pickup':
          this.tone(590, now, 0.10, 0.18, 'sine');
          this.tone(790, now + 0.07, 0.10, 0.18, 'sine');
          this.tone(1180, now + 0.14, 0.18, 0.18, 'sine');
          break;
        case 'hit':
          this.noise(now, 0.22, 0.32, 450);
          this.tone(210, now, 0.28, 0.20, 'sawtooth', 55);
          break;
        case 'boost':
          this.tone(190, now, 0.27, 0.12, 'triangle', 780);
          this.noise(now, 0.22, 0.12, 1800);
          break;
        case 'use':
          this.tone(620, now, 0.14, 0.13, 'triangle', 260);
          break;
        case 'lap':
          this.tone(660, now, 0.15, 0.17, 'triangle');
          this.tone(990, now + 0.10, 0.26, 0.17, 'triangle');
          break;
        case 'finish':
          for (const [index, frequency] of [523, 659, 784, 1046].entries()) {
            this.tone(frequency, now + index * 0.09, 0.30, 0.17, 'triangle');
          }
          break;
        default:
          playItemEvent(this.kit, event, now);
          break;
      }
    }
  }

  /** The local kart's item roulette only; GameUI drives it from the player's own rouletteTime. */
  playRoulette(kind: 'tick' | 'stop'): void {
    if (!this.context || this.disposed || this.muted || !this.active || this.context.state !== 'running') return;
    playRouletteSound(this.kit, kind, this.context.currentTime);
  }

  /** Stop the driving instruments without cutting off the final result melody. */
  finishRace(): void {
    this.active = false;
    if (!this.context) return;
    this.engineGain?.gain.setTargetAtTime(0, this.context.currentTime, 0.03);
    this.driftGain?.gain.setTargetAtTime(0, this.context.currentTime, 0.03);
  }

  suspend(): void {
    this.active = false;
    if (!this.context) return;
    this.master?.gain.cancelScheduledValues(this.context.currentTime);
    this.master?.gain.setValueAtTime(0, this.context.currentTime);
    this.engineGain?.gain.setValueAtTime(0, this.context.currentTime);
    this.driftGain?.gain.setValueAtTime(0, this.context.currentTime);
    for (const source of this.effects) {
      try { source.stop(); } catch { /* Already stopped sources are harmless. */ }
    }
    this.effects.clear();
    if (this.context.state === 'running') void this.context.suspend().catch(() => {});
  }

  dispose(): void {
    this.suspend();
    this.disposed = true;
    for (const source of this.continuousSources) {
      try { source.stop(); } catch { /* Dispose can follow a closed audio context. */ }
      source.disconnect();
    }
    this.continuousSources.length = 0;
    this.master?.disconnect();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.context = null;
  }

  private initialize(): void {
    const browser = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Context = browser.AudioContext ?? browser.webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    this.context = context;
    const master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);
    this.master = master;

    const engineGain = context.createGain();
    engineGain.gain.value = 0;
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 550;
    engineFilter.Q.value = 0.7;
    engineFilter.connect(engineGain);
    engineGain.connect(master);
    this.engineGain = engineGain;
    const engine = context.createOscillator();
    engine.type = 'sawtooth';
    engine.frequency.value = 48;
    engine.connect(engineFilter);
    engine.start();
    this.engineOscillator = engine;
    const harmonic = context.createOscillator();
    harmonic.type = 'triangle';
    harmonic.frequency.value = 96;
    const harmonicGain = context.createGain();
    harmonicGain.gain.value = 0.3;
    harmonic.connect(harmonicGain);
    harmonicGain.connect(engineFilter);
    harmonic.start();
    this.engineHarmonic = harmonic;
    this.continuousSources.push(engine, harmonic);

    const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = noise.getChannelData(0);
    let seed = 197705;
    for (let index = 0; index < samples.length; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      samples[index] = (seed >>> 0) / 0xffffffff * 2 - 1;
    }
    this.noiseBuffer = noise;
    const driftSource = context.createBufferSource();
    driftSource.buffer = noise;
    driftSource.loop = true;
    const driftFilter = context.createBiquadFilter();
    driftFilter.type = 'bandpass';
    driftFilter.frequency.value = 900;
    driftFilter.Q.value = 1.1;
    const driftGain = context.createGain();
    driftGain.gain.value = 0;
    driftSource.connect(driftFilter);
    driftFilter.connect(driftGain);
    driftGain.connect(master);
    driftSource.start();
    this.driftFilter = driftFilter;
    this.driftGain = driftGain;
    this.continuousSources.push(driftSource);
  }

  private tone(frequency: number, start: number, duration: number, volume: number, type: OscillatorType, endFrequency?: number): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency !== undefined) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(volume, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    this.effects.add(oscillator);
    oscillator.onended = () => {
      this.effects.delete(oscillator);
      oscillator.disconnect();
      envelope.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(start: number, duration: number, volume: number, frequency: number): void {
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(volume, start);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    this.effects.add(source);
    source.onended = () => {
      this.effects.delete(source);
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
    source.start(start);
    source.stop(start + duration);
  }
}
