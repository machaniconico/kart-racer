import { getRank, TOTAL_LAPS } from '../sim/laps';
import { getFinishTimeRemaining, isRaceTimedOut } from '../sim/race';
import { getTrack, TRACK_IDS } from '../sim/tracks';
import type { ItemType, KartState, RaceState, Track, TrackId } from '../sim/types';
import { ROULETTE_TIME } from '../sim/items';
import { emptyItemIcon as emptyItem, icon, itemIcon, itemName, itemShortName, createRouletteView, stepRoulette } from './itemIcons';
import { createInkOverlay, update as updateInkOverlay } from './inkOverlay';

type Screen = 'title' | 'lobby' | 'race' | 'results';
type Mode = 'solo' | 'host' | 'guest';

const arrow = icon('<path d="M4 12h15M13 5l7 7-7 7"/>');
const volume = icon('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path class="sound-wave" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sound-cross" d="m16 9 6 6m0-6-6 6"/>');
const pauseIcon = icon('<path d="M8 5v14M16 5v14"/>');
const driftIcon = icon('<path d="m7 3 8 5-4 5 6 4M7 21h10M4 8l4 2m-4 4 3 1"/>');

export function formatTime(seconds: number): string {
  const hundredths = Math.max(0, Math.floor(seconds * 100));
  return `${String(Math.floor(hundredths / 6000)).padStart(2, '0')}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}

/** Two-digit course number shown in the title strip, e.g. 01 for the first course. */
export function courseNumber(trackId: string): string {
  const index = TRACK_IDS.indexOf(trackId as TrackId);
  return index < 0 ? '--' : String(index + 1).padStart(2, '0');
}

const courseOptions = TRACK_IDS.map((id, index) => `<label class="course-option"><input type="radio" name="course" value="${id}" aria-label="${courseNumber(id)} ${getTrack(id).def.name}"${index === 0 ? ' checked' : ''}><span aria-hidden="true">${courseNumber(id)}</span></label>`).join('');

export function formatResultTime(state: RaceState, kart: KartState): string {
  if (kart.finishTime !== null) return formatTime(kart.finishTime);
  return isRaceTimedOut(state) ? 'DNF · 未完走' : '走行中 · 推定順位';
}

/** DOM and 2D HUD only. The rendered world and simulation stay independent. */
export class GameUI {
  readonly canvas: HTMLCanvasElement;
  private readonly title: HTMLElement;
  /** Empty frame; the lobby UI mounts its own content here. */
  readonly lobby: HTMLElement;
  private readonly race: HTMLElement;
  private readonly results: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly map: HTMLCanvasElement;
  private readonly mapContext: CanvasRenderingContext2D | null;
  private trackPath = new Path2D();
  private mapTrack: Track | null = null;
  private readonly refs: Record<string, HTMLElement> = {};
  private screen: Screen = 'title';
  private paused = false;
  private previousFocus: HTMLElement | null = null;
  private lastItem: ItemType | null | undefined;
  private lastMapTick = -1;
  private mapScale = 1;
  private mapOffsetX = 0;
  private mapOffsetZ = 0;

  private inkMounted = false;
  /** Local kart's roulette presentation; decorative only, never fed back into the sim. */
  private readonly roulette = createRouletteView();
  private readonly reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  /** Fired for the local kart only: one 'tick' per icon switch and one 'stop' when the item is revealed. */
  onRoulette: ((kind: 'tick' | 'stop') => void) | null = null;

  constructor(private readonly root: HTMLElement, private localKartId: number) {
    // Placeholder until setCourse(); the first registered course is the default selection.
    const initialCourse = getTrack(TRACK_IDS[0]).def.name;
    root.innerHTML = `
      <canvas id="game-canvas" tabindex="-1" aria-label="${initialCourse} を走る3Dカートレース"></canvas>
      <header class="topbar">
        <div class="wordmark"><span class="flag-mark" aria-hidden="true"></span><span>POCKET CIRCUIT<span class="wordmark-edition">THE LITTLE RACING CLUB</span></span></div>
        <div class="utility-buttons">
          <button id="mute" class="utility-button sound-button" type="button" aria-label="サウンドをミュート" aria-pressed="false">${volume}<span id="sound-label">SOUND ON</span></button>
          <button id="pause-race" class="utility-button race-only" type="button" aria-label="一時停止">${pauseIcon}</button>
        </div>
      </header>

      <section id="title-screen" class="screen title-screen" aria-labelledby="game-title">
        <div class="title-content">
          <div class="eyebrow"><span class="live-dot"></span> SMALL KARTS. BIG ADVENTURES.</div>
          <h1 id="game-title">POCKET<br><span>CIRCUIT.</span></h1>
          <p class="title-tagline">曲がれ。風になれ。</p>
          <p class="title-description">丘を越えて、カーブを抜けて。<br>7台のライバルと、3周の小さな冒険。</p>
          <button id="start-race" class="primary-button start-button" type="button"><span>レースをはじめる</span>${arrow}</button>
          <div class="title-record"><span>PERSONAL BEST</span><strong id="title-best">まだ記録はありません</strong></div>
        </div>
        <aside class="title-help" aria-label="操作方法">
          <p class="help-heading">MAKE YOUR FIRST MOVE</p>
          <div class="keyboard-help"><p><span><kbd>WASD</kbd><span class="or-text">/</span><kbd>↑ ← ↓ →</kbd></span><span>走る・曲がる</span></p><p><kbd>SPACE</kbd><span>ドリフト</span></p><p><span><kbd>SHIFT</kbd><span class="or-text">/</span><kbd>E</kbd></span><span>アイテム</span></p></div>
          <p class="touch-help">左手で曲がる。右手でドリフト。<br>アクセルは自動でも、手動でも。</p>
          <p class="drift-tip">ドリフトをためて、離すとターボ。</p>
        </aside>
        <footer class="course-strip"><div><span id="course-index" class="course-index">01</span><span><small>THE CIRCUIT</small><strong id="course-name">${initialCourse}</strong></span></div><div class="course-picker"><small aria-hidden="true">SELECT COURSE</small><div id="course-select" class="course-select" role="radiogroup" aria-label="コースを選ぶ">${courseOptions}</div></div><div><small>ON THE GRID</small><strong>8 RACERS</strong></div><div><small>TO THE FINISH</small><strong>3 LAPS</strong></div><span class="course-footnote">A FRESH LITTLE ESCAPE.</span></footer>
      </section>

      <section id="lobby-screen" class="screen lobby-screen" aria-label="ロビー" hidden></section>

      <section id="race-screen" class="screen race-screen" aria-label="レース" hidden>
        <div class="race-position" aria-label="順位とラップ"><div class="position-group"><span class="hud-eyebrow">POSITION</span><div><strong id="position-value">8</strong><span id="position-total" class="position-total">/ 8</span></div></div><div class="lap-group"><span class="hud-eyebrow">LAP</span><strong><span id="lap-value">1</span><span class="lap-total"> / 3</span></strong></div></div>
        <div class="race-times"><div><span>TOTAL</span><strong id="total-time">00:00.00</strong></div><div><span>LAP</span><strong id="lap-time">00:00.00</strong></div><div class="best-lap-line"><span>BEST LAP</span><strong id="best-lap">—</strong></div></div>
        <div id="item-display" class="item-display"><div id="item-hud-icon" class="item-icon">${emptyItem}</div><div><span class="hud-eyebrow">YOUR ITEM</span><strong id="item-name">ボックスを取ろう</strong><span class="item-key"><kbd>SHIFT</kbd> / <kbd>E</kbd> で使う</span></div></div>
        <div id="countdown-display" class="countdown-display" role="status" aria-live="polite" hidden>3</div>
        <div class="race-notices"><p id="finish-countdown" class="finish-countdown" role="timer" hidden></p><p id="wrong-way" class="wrong-way" role="status" hidden>↶ 逆走しています</p><p id="race-status" class="race-status" hidden></p><p id="net-status" class="race-status" role="status" hidden></p></div>
        <p id="item-announce" class="item-announce" role="status" aria-live="polite"></p>
        <div class="speed-display"><strong id="speed-value">0</strong><span>km/h</span><div id="drift-meter" class="drift-meter" data-stage="0"><div class="drift-meter-label"><span id="drift-label">MINI TURBO</span><span class="drift-levels">Ⅰ / Ⅱ</span></div><div class="drift-track"><div id="drift-fill" class="drift-fill"></div><i class="drift-threshold"></i></div></div></div>
        <div class="minimap"><span id="minimap-course">${initialCourse}</span><canvas id="minimap-canvas" width="360" height="256" aria-label="コース全体図。明るい枠のマーカーがあなたです。"></canvas><span class="map-you"><i></i>YOU</span></div>
        <div class="touch-controls" aria-label="タッチ操作">
          <div class="steering-area"><button id="auto-accelerate" class="auto-button" type="button" aria-pressed="false"><span class="auto-indicator"></span>自動アクセル</button><div id="steering-pad" class="steering-pad" aria-label="左右にドラッグしてハンドル操作"><span class="steering-label">STEER</span><span class="steering-arrow left">‹</span><span class="steering-arrow right">›</span><div id="steering-knob" class="steering-knob"><span></span></div></div></div>
          <div class="touch-actions"><button id="accelerate" class="touch-button accelerate-button" type="button" aria-label="アクセルを踏む">${icon('<path d="m6 14 6-6 6 6m-12 5 6-6 6 6"/>')}<span>アクセル</span></button><button id="brake" class="touch-button brake-button" type="button" aria-label="ブレーキを踏む">${icon('<path d="M6 8h12M6 15h12"/>')}<span>ブレーキ</span></button><button id="drift" class="touch-button drift-button" type="button" aria-label="長押ししてドリフト。離すとミニターボ">${driftIcon}<span>ドリフト</span></button><button id="use-item" class="touch-button item-button" type="button" aria-label="所持アイテムを使う"><span id="item-button-icon">${emptyItem}</span><span id="item-button-name">ITEM</span></button></div>
        </div>
      </section>

      <section id="results-screen" class="screen results-screen" aria-labelledby="results-heading" hidden>
        <div class="results-content">
          <div class="results-heading-row"><div><span id="results-course" class="eyebrow">${initialCourse} · ${TOTAL_LAPS} LAPS</span><h2 id="results-heading">FINISH!</h2></div><span id="result-position" class="result-position">1<span>位</span></span></div>
          <div class="finish-summary"><div><span>YOUR TIME</span><strong id="finish-time">00:00.00</strong></div><span id="new-record" class="record-badge" hidden>NEW BEST!</span><div class="finish-best"><span>PERSONAL BEST</span><strong id="finish-best">—</strong></div></div>
          <ol id="leaderboard" class="leaderboard" aria-label="レース順位"></ol>
          <p id="result-laps" class="result-laps"></p>
          <div class="result-actions"><button id="retry-race" class="primary-button" type="button"><span id="retry-label">もう一度走る</span>${arrow}</button><button id="back-title" class="secondary-button" type="button">タイトルへ</button></div>
        </div>
      </section>

      <section id="pause-dialog" class="modal-overlay" hidden><div class="pause-content" role="dialog" aria-modal="true" aria-labelledby="pause-heading"><span id="pause-eyebrow" class="eyebrow">TAKE A BREATHER</span><h2 id="pause-heading">ひとやすみ。</h2><p id="pause-message">レースはここで待っています。</p><button id="resume-race" class="primary-button" type="button"><span id="resume-label">レースをつづける</span>${arrow}</button><button id="quit-race" class="secondary-button" type="button">タイトルへ戻る</button><span class="pause-shortcut"><kbd>ESC</kbd> で<span id="pause-shortcut-label">再開</span></span></div></section>
      <section id="net-dialog" class="modal-overlay error-overlay" hidden><div class="pause-content" role="alertdialog" aria-modal="true" aria-labelledby="net-heading"><span class="eyebrow">CONNECTION LOST</span><h2 id="net-heading">接続が切れました</h2><p id="net-message"></p><button id="net-dialog-ok" class="primary-button" type="button">タイトルへ戻る</button></div></section>
      <p id="host-notice" class="host-notice" role="note" hidden>ホスト中 · この画面を閉じたり切り替えたりしないでください</p>
      <section id="error-dialog" class="modal-overlay error-overlay" hidden><div class="pause-content" role="alertdialog" aria-modal="true" aria-labelledby="error-heading"><span class="eyebrow">A SMALL PIT STOP</span><h2 id="error-heading">スタートできませんでした</h2><p id="error-message"></p><button id="reload-page" class="primary-button" type="button">ページを再読み込み</button></div></section>
    `;
    this.canvas = this.get<HTMLCanvasElement>('game-canvas');
    this.title = this.get('title-screen');
    this.lobby = this.get('lobby-screen');
    this.race = this.get('race-screen');
    this.results = this.get('results-screen');
    this.pause = this.get('pause-dialog');
    this.map = this.get<HTMLCanvasElement>('minimap-canvas');
    this.mapContext = this.map.getContext('2d');
    this.pause.addEventListener('keydown', (event) => this.trapFocus(event));
    this.root.addEventListener('mousedown', (event) => {
      if (this.isPlaying() && event.target instanceof Element && event.target.closest('button')) {
        event.preventDefault();
      }
    });
    this.root.addEventListener('click', (event) => {
      if (this.isPlaying() && event.target instanceof Element && event.target.closest('button')) {
        this.canvas.focus({ preventScroll: true });
      }
    });
    this.show('title');
  }

  show(screen: Screen): void {
    if (screen !== 'race') updateInkOverlay(0);
    this.screen = screen;
    this.root.dataset.screen = screen;
    this.title.hidden = screen !== 'title';
    this.lobby.hidden = screen !== 'lobby';
    this.race.hidden = screen !== 'race';
    this.results.hidden = screen !== 'results';
    this.setPaused(false);
    if (screen === 'race') {
      this.lastItem = undefined;
      this.lastMapTick = -1;
      this.resetRoulette();
      this.canvas.focus({ preventScroll: true });
    } else if (screen !== 'lobby') {
      requestAnimationFrame(() => {
        if (this.screen === screen && !this.paused && this.get('error-dialog').hidden) {
          const retry = this.get('retry-race').hidden ? 'back-title' : 'retry-race';
          this.get(screen === 'title' ? 'start-race' : retry).focus({ preventScroll: true });
        }
      });
    }
  }

  /** Online play relabels pause as a leave confirmation and result actions as lobby/room actions. */
  setMode(mode: Mode, localKartId = 0): void {
    this.localKartId = localKartId;
    this.lastItem = undefined;
    this.lastMapTick = -1;
    this.resetRoulette();
    this.root.dataset.mode = mode;
    const online = mode !== 'solo';
    this.text('pause-eyebrow', online ? 'ONLINE RACE' : 'TAKE A BREATHER');
    this.text('pause-heading', online ? 'レースを退出しますか？' : 'ひとやすみ。');
    this.text('pause-message', mode === 'host' ? 'レースは止まりません。退出するとルームが閉じ、全員のレースが終わります。'
      : mode === 'guest' ? 'レースは止まりません。退出すると、あなたのカートは CPU が走らせます。' : 'レースはここで待っています。');
    this.text('resume-label', online ? 'レースにもどる' : 'レースをつづける');
    this.text('quit-race', online ? '退出する' : 'タイトルへ戻る');
    this.text('pause-shortcut-label', online ? 'もどる' : '再開');
    this.text('retry-label', mode === 'host' ? '再戦（ロビーへ）' : 'もう一度走る');
    this.get('retry-race').hidden = mode === 'guest';
    this.text('back-title', mode === 'host' ? 'ルームを閉じる' : mode === 'guest' ? '退出する' : 'タイトルへ');
    this.get('host-notice').hidden = mode !== 'host';
    this.setNetStatus(null);
  }

  /** Guest-only connection notice inside the race HUD, e.g. a stalled host. */
  setNetStatus(message: string | null): void {
    this.get('net-status').hidden = message === null;
    this.text('net-status', message ?? '');
  }

  showDisconnected(message: string): void {
    this.setPaused(false);
    this.text('net-message', message);
    this.get('net-dialog').hidden = false;
    this.get('net-dialog-ok').focus({ preventScroll: true });
  }

  hideDisconnected(): void {
    this.get('net-dialog').hidden = true;
  }

  setPaused(paused: boolean): void {
    const wasPaused = this.paused;
    this.paused = paused;
    this.pause.hidden = !paused;
    this.race.inert = paused;
    this.get('pause-race').setAttribute('aria-expanded', String(paused));
    this.root.classList.toggle('is-paused', paused);
    if (paused) {
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.get('resume-race').focus({ preventScroll: true });
    } else if (wasPaused && this.screen === 'race') {
      (this.previousFocus ?? this.canvas).focus({ preventScroll: true });
    }
  }

  update(state: RaceState): void {
    const player = state.karts.find((kart) => kart.id === this.localKartId);
    if (!this.inkMounted) {
      createInkOverlay(this.root);
      this.inkMounted = true;
    }
    updateInkOverlay(player?.effects.inkTime ?? 0);
    if (!player) return;
    this.setCourseLabels(state.trackId);
    this.text('position-value', String(getRank(state, this.localKartId)));
    this.text('position-total', `/ ${state.karts.length}`);
    this.text('lap-value', String(Math.min(TOTAL_LAPS, player.lap + 1)));
    this.text('total-time', formatTime(player.finishTime ?? state.time));
    this.text('lap-time', formatTime(Math.max(0, state.time - player.lapStartTime)));
    this.text('best-lap', player.lapTimes.length > 0 ? formatTime(Math.min(...player.lapTimes)) : '—');
    this.text('speed-value', String(Math.round(Math.abs(player.speed) * 3.6)));

    const countdown = this.get('countdown-display');
    const counting = state.phase === 'countdown';
    countdown.hidden = !counting && !(state.phase === 'racing' && state.time < 0.8);
    const countText = counting ? String(Math.min(3, Math.max(1, Math.ceil(state.countdown)))) : 'GO!';
    this.text('countdown-display', countText);
    countdown.classList.toggle('is-go', !counting);
    const remaining = getFinishTimeRemaining(state);
    this.get('finish-countdown').hidden = remaining === null || state.phase !== 'racing';
    this.text('finish-countdown', remaining === null ? '' : `レース終了まで ${Math.ceil(remaining)}秒`);
    this.get('wrong-way').hidden = !player.wrongWay && player.lapValid;
    this.text('wrong-way', player.wrongWay ? '↶ 逆走しています' : 'コースアウト · この周回は無効です');
    const status = this.get('race-status');
    status.hidden = player.spinTime <= 0 && player.boostTime <= 0;
    this.text('race-status', player.spinTime > 0 ? 'SPIN!' : 'DASH!');
    status.dataset.type = player.spinTime > 0 ? 'spin' : 'boost';

    const stage = player.driftTime >= 1.5 ? 2 : player.driftTime >= 0.65 ? 1 : 0;
    this.get('drift-meter').dataset.stage = String(stage);
    this.get('drift-meter').classList.toggle('is-drifting', player.driftTime > 0);
    this.get('drift-fill').style.transform = `scaleX(${Math.min(1, player.driftTime / 1.5)})`;
    this.text('drift-label', stage === 2 ? 'TURBO Ⅱ READY' : stage === 1 ? 'TURBO Ⅰ READY' : 'MINI TURBO');

    this.updateItem(player);
    if (state.tick !== this.lastMapTick && (state.tick % 4 === 0 || this.lastMapTick < 0)) {
      this.lastMapTick = state.tick;
      this.drawMap(state);
    }
  }

  /** HUD item slot and touch ITEM button, including the local kart's item roulette. */
  private updateItem(player: KartState): void {
    const remaining = player.item ? player.effects.rouletteTime : 0;
    const step = stepRoulette(this.roulette, remaining, this.reducedMotion?.matches ?? false, ROULETTE_TIME);
    const art = this.roulette.item ? itemIcon(this.roulette.item) : emptyItem;
    if (step === 'start') {
      this.lastItem = undefined;
      this.text('item-announce', '');
      this.text('item-name', 'ルーレット中…');
      this.text('item-button-name', 'STOP');
      this.setItemArt(art, true);
      this.setRolling(true);
      const button = this.get<HTMLButtonElement>('use-item');
      button.disabled = false;
      button.setAttribute('aria-label', 'ルーレットを止める');
    } else if (step === 'switch' || step === 'restyle') {
      this.setItemArt(art, true);
      if (step === 'switch') this.onRoulette?.('tick');
    }
    if (remaining > 0) return;
    const revealed = step === 'stop' && player.item !== null;
    if (step === 'stop') {
      this.setRolling(false);
      this.lastItem = undefined;
    }
    if (this.lastItem !== player.item) {
      this.lastItem = player.item;
      this.text('item-name', player.item ? itemName(player.item) : 'ボックスを取ろう');
      this.text('item-button-name', player.item ? itemShortName(player.item) : 'ITEM');
      this.setItemArt(player.item ? itemIcon(player.item) : emptyItem, player.item !== null);
      // Fresh SVG nodes start the pop (or the reduced-motion fade) only on a roulette stop.
      this.get('item-hud-icon').classList.toggle('is-revealed', revealed);
      this.get('item-button-icon').classList.toggle('is-revealed', revealed);
      const button = this.get<HTMLButtonElement>('use-item');
      button.disabled = player.item === null;
      if (button.disabled) {
        button.classList.remove('is-pressed');
        button.dispatchEvent(new Event('control-disabled'));
      }
      button.setAttribute('aria-label', player.item ? `${itemName(player.item)}を使う` : 'アイテムを持っていません');
    }
    if (revealed && player.item) {
      this.text('item-announce', `${itemName(player.item)}を手に入れた`);
      this.onRoulette?.('stop');
    }
  }

  private setItemArt(art: string, hasItem: boolean): void {
    const hud = this.get('item-hud-icon');
    const button = this.get('item-button-icon');
    hud.innerHTML = art;
    button.innerHTML = art;
    hud.classList.toggle('has-item', hasItem);
  }

  private setRolling(rolling: boolean): void {
    this.get('item-display').classList.toggle('is-rolling', rolling);
    this.get('use-item').classList.toggle('is-rolling', rolling);
    this.get('item-hud-icon').classList.remove('is-revealed');
    this.get('item-button-icon').classList.remove('is-revealed');
  }

  private resetRoulette(): void {
    Object.assign(this.roulette, createRouletteView());
    this.setRolling(false);
    this.text('item-announce', '');
  }

  showResults(state: RaceState, best: number | null, isRecord: boolean): void {
    const player = state.karts.find((kart) => kart.id === this.localKartId);
    if (!player) return;
    const rank = getRank(state, this.localKartId);
    const didFinish = player.finishTime !== null;
    this.text('results-course', `${getTrack(state.trackId).def.name} · ${TOTAL_LAPS} LAPS`);
    this.text('results-heading', didFinish ? 'FINISH!' : 'RACE OVER');
    this.get('result-position').innerHTML = `${rank}<span>位</span>`;
    this.text('finish-time', didFinish ? formatTime(player.finishTime!) : 'DNF');
    this.text('finish-best', best === null ? '—' : formatTime(best));
    this.get('new-record').hidden = !isRecord || !didFinish;
    const list = this.get('leaderboard');
    list.replaceChildren();
    const order = [...state.karts].sort((a, b) => getRank(state, a.id) - getRank(state, b.id));
    for (const [index, kart] of order.entries()) {
      const row = document.createElement('li');
      row.className = kart.id === this.localKartId ? 'leaderboard-row is-player' : 'leaderboard-row';
      const position = document.createElement('span');
      position.className = 'leaderboard-position';
      position.textContent = String(index + 1).padStart(2, '0');
      const swatch = document.createElement('i');
      swatch.className = 'racer-swatch';
      swatch.style.backgroundColor = `#${kart.color.toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'racer-name';
      name.textContent = kart.name;
      if (kart.id === this.localKartId) {
        const badge = document.createElement('small');
        badge.textContent = 'YOU';
        name.append(badge);
      }
      const time = document.createElement('span');
      time.className = 'racer-time';
      time.textContent = formatResultTime(state, kart);
      row.append(position, swatch, name, time);
      list.append(row);
    }
    const lapResults = player.lapTimes.map((time, index) => `LAP ${index + 1}  ${formatTime(time)}`);
    if (!didFinish) lapResults.push(`未完走 · ${player.lap} / ${TOTAL_LAPS} 周完了`);
    this.text('result-laps', lapResults.join('   /   '));
    this.setBest(best);
    this.show('results');
  }

  /** Title course selection: radio state, course strip and the best time for that course. */
  setCourse(trackId: TrackId, best: number | null): void {
    for (const input of this.get('course-select').querySelectorAll<HTMLInputElement>('input[name="course"]')) {
      input.checked = input.value === trackId;
    }
    this.text('course-index', courseNumber(trackId));
    this.text('course-name', getTrack(trackId).def.name);
    this.setCourseLabels(trackId);
    this.setBest(best);
  }

  setBest(best: number | null): void {
    this.text('title-best', best === null ? 'まだ記録はありません' : formatTime(best));
  }

  setMuted(muted: boolean): void {
    const button = this.get('mute');
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', muted ? 'サウンドをオンにする' : 'サウンドをミュート');
    button.classList.toggle('is-muted', muted);
    this.text('sound-label', muted ? 'SOUND OFF' : 'SOUND ON');
  }

  showError(message: string): void {
    this.text('error-message', message);
    this.get('error-dialog').hidden = false;
    this.get('reload-page').focus({ preventScroll: true });
  }

  /** Minimap heading and the 3D canvas name follow the course being shown. */
  private setCourseLabels(trackId: TrackId): void {
    const name = getTrack(trackId).def.name;
    this.text('minimap-course', name);
    const label = `${name} を走る3Dカートレース`;
    if (this.canvas.getAttribute('aria-label') !== label) this.canvas.setAttribute('aria-label', label);
  }

  private isPlaying(): boolean {
    return this.screen === 'race' && !this.paused && this.get('error-dialog').hidden && this.get('net-dialog').hidden;
  }

  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    const cached = this.refs[id];
    if (cached) return cached as T;
    const element = this.root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing UI element: ${id}`);
    this.refs[id] = element;
    return element;
  }

  private text(id: string, value: string): void {
    const element = this.get(id);
    if (element.textContent !== value) element.textContent = value;
  }

  private trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const first = this.get('resume-race');
    const last = this.get('quit-race');
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private prepareMap(track: Track): void {
    this.mapTrack = track;
    this.trackPath = new Path2D();
    if (track.samples.length === 0) return;
    const minX = Math.min(...track.samples.map((point) => point.x));
    const maxX = Math.max(...track.samples.map((point) => point.x));
    const minZ = Math.min(...track.samples.map((point) => point.z));
    const maxZ = Math.max(...track.samples.map((point) => point.z));
    this.mapScale = Math.min(144 / (maxX - minX), 99 / (maxZ - minZ));
    this.mapOffsetX = 90 - (minX + maxX) / 2 * this.mapScale;
    this.mapOffsetZ = 64 - (minZ + maxZ) / 2 * this.mapScale;
    track.samples.forEach((point, index) => {
      const x = point.x * this.mapScale + this.mapOffsetX;
      const y = point.z * this.mapScale + this.mapOffsetZ;
      if (index === 0) this.trackPath.moveTo(x, y);
      else this.trackPath.lineTo(x, y);
    });
    this.trackPath.closePath();
  }

  private drawMap(state: RaceState): void {
    const track = getTrack(state.trackId);
    if (this.mapTrack !== track) this.prepareMap(track);
    const context = this.mapContext;
    if (!context) return;
    context.setTransform(2, 0, 0, 2, 0, 0);
    context.clearRect(0, 0, 180, 128);
    context.lineJoin = 'round';
    context.strokeStyle = 'rgba(9, 39, 31, .9)';
    context.lineWidth = 11;
    context.stroke(this.trackPath);
    context.strokeStyle = 'rgba(255, 255, 255, .7)';
    context.lineWidth = 5;
    context.stroke(this.trackPath);
    const start = track.samples[0];
    if (start) {
      const x = start.x * this.mapScale + this.mapOffsetX;
      const y = start.z * this.mapScale + this.mapOffsetZ;
      context.beginPath();
      context.moveTo(x - start.nx * 5, y - start.nz * 5);
      context.lineTo(x + start.nx * 5, y + start.nz * 5);
      context.strokeStyle = '#d8ff75';
      context.lineWidth = 2;
      context.stroke();
    }
    const karts = [...state.karts].sort((a, b) => Number(a.id === this.localKartId) - Number(b.id === this.localKartId));
    for (const kart of karts) {
      const x = kart.x * this.mapScale + this.mapOffsetX;
      const y = kart.z * this.mapScale + this.mapOffsetZ;
      context.beginPath();
      if (kart.id === this.localKartId) {
        context.save();
        context.translate(x, y);
        context.rotate(Math.PI - kart.heading);
        context.moveTo(0, -6);
        context.lineTo(4.5, 4);
        context.lineTo(0, 2);
        context.lineTo(-4.5, 4);
        context.closePath();
        context.restore();
      } else context.arc(x, y, 3.4, 0, Math.PI * 2);
      context.fillStyle = `#${kart.color.toString(16).padStart(6, '0')}`;
      context.strokeStyle = kart.id === this.localKartId ? '#ffffff' : '#173d35';
      context.lineWidth = kart.id === this.localKartId ? 1.8 : 1;
      context.fill();
      context.stroke();
    }
  }
}
