import { getRank, TOTAL_LAPS } from '../sim/laps';
import { getFinishTimeRemaining, isRaceTimedOut } from '../sim/race';
import { TRACK_SAMPLES } from '../sim/track';
import type { ItemType, KartState, RaceState } from '../sim/types';

type Screen = 'title' | 'race' | 'results';

const icon = (body: string, className = ''): string => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const arrow = icon('<path d="M4 12h15M13 5l7 7-7 7"/>');
const volume = icon('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path class="sound-wave" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sound-cross" d="m16 9 6 6m0-6-6 6"/>');
const pauseIcon = icon('<path d="M8 5v14M16 5v14"/>');
const driftIcon = icon('<path d="m7 3 8 5-4 5 6 4M7 21h10M4 8l4 2m-4 4 3 1"/>');
const itemIcons: Record<ItemType, string> = {
  dash: icon('<path d="m14 2-9 12h7l-2 8 9-12h-7l2-8Z"/>'),
  trap: icon('<path d="M5 16 12 4l7 12H5Z"/><path d="M3 20h18M12 9v3m0 3h.01"/>'),
  bolt: icon('<path d="m4 16 12-12 4 4-12 12H4v-4ZM13 7l4 4M3 6l3-3m12 18 3-3"/>'),
};
const emptyItem = icon('<path d="M6 4h12l3 8-9 9-9-9 3-8Z"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>');
const itemNames: Record<ItemType, string> = { dash: 'ソニックダッシュ', trap: 'ポップトラップ', bolt: 'リコシェボルト' };
const itemShortNames: Record<ItemType, string> = { dash: 'ダッシュ', trap: 'トラップ', bolt: 'ボルト' };

export function formatTime(seconds: number): string {
  const hundredths = Math.max(0, Math.floor(seconds * 100));
  return `${String(Math.floor(hundredths / 6000)).padStart(2, '0')}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}

export function formatResultTime(state: RaceState, kart: KartState): string {
  if (kart.finishTime !== null) return formatTime(kart.finishTime);
  return isRaceTimedOut(state) ? 'DNF · 未完走' : '走行中 · 推定順位';
}

/** DOM and 2D HUD only. The rendered world and simulation stay independent. */
export class GameUI {
  readonly canvas: HTMLCanvasElement;
  private readonly title: HTMLElement;
  private readonly race: HTMLElement;
  private readonly results: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly map: HTMLCanvasElement;
  private readonly mapContext: CanvasRenderingContext2D | null;
  private readonly trackPath = new Path2D();
  private readonly refs: Record<string, HTMLElement> = {};
  private screen: Screen = 'title';
  private paused = false;
  private previousFocus: HTMLElement | null = null;
  private lastItem: ItemType | null | undefined;
  private lastMapTick = -1;
  private mapScale = 1;
  private mapOffsetX = 0;
  private mapOffsetZ = 0;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <canvas id="game-canvas" tabindex="-1" aria-label="緑の丘を走る3Dカートレース"></canvas>
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
          <p class="title-description">丘を越えて、カーブを抜けて。<br>5台のライバルと、3周の小さな冒険。</p>
          <button id="start-race" class="primary-button start-button" type="button"><span>レースをはじめる</span>${arrow}</button>
          <div class="title-record"><span>PERSONAL BEST</span><strong id="title-best">まだ記録はありません</strong></div>
        </div>
        <aside class="title-help" aria-label="操作方法">
          <p class="help-heading">MAKE YOUR FIRST MOVE</p>
          <div class="keyboard-help"><p><span><kbd>WASD</kbd><span class="or-text">/</span><kbd>↑ ← ↓ →</kbd></span><span>走る・曲がる</span></p><p><kbd>SPACE</kbd><span>ドリフト</span></p><p><span><kbd>SHIFT</kbd><span class="or-text">/</span><kbd>E</kbd></span><span>アイテム</span></p></div>
          <p class="touch-help">左手で曲がる。右手でドリフト。<br>アクセルは自動でも、手動でも。</p>
          <p class="drift-tip">ドリフトをためて、離すとターボ。</p>
        </aside>
        <footer class="course-strip"><div><span class="course-index">01</span><span><small>THE CIRCUIT</small><strong>MEADOW LOOP</strong></span></div><div><small>ON THE GRID</small><strong>6 RACERS</strong></div><div><small>TO THE FINISH</small><strong>3 LAPS</strong></div><span class="course-footnote">A FRESH LITTLE ESCAPE.</span></footer>
      </section>

      <section id="race-screen" class="screen race-screen" aria-label="レース" hidden>
        <div class="race-position" aria-label="順位とラップ"><div class="position-group"><span class="hud-eyebrow">POSITION</span><div><strong id="position-value">6</strong><span class="position-total">/ 6</span></div></div><div class="lap-group"><span class="hud-eyebrow">LAP</span><strong><span id="lap-value">1</span><span class="lap-total"> / 3</span></strong></div></div>
        <div class="race-times"><div><span>TOTAL</span><strong id="total-time">00:00.00</strong></div><div><span>LAP</span><strong id="lap-time">00:00.00</strong></div><div class="best-lap-line"><span>BEST LAP</span><strong id="best-lap">—</strong></div></div>
        <div class="item-display"><div id="item-hud-icon" class="item-icon">${emptyItem}</div><div><span class="hud-eyebrow">YOUR ITEM</span><strong id="item-name">ボックスを取ろう</strong><span class="item-key"><kbd>SHIFT</kbd> / <kbd>E</kbd> で使う</span></div></div>
        <div id="countdown-display" class="countdown-display" role="status" aria-live="polite" hidden>3</div>
        <div class="race-notices"><p id="finish-countdown" class="finish-countdown" role="timer" hidden></p><p id="wrong-way" class="wrong-way" role="status" hidden>↶ 逆走しています</p><p id="race-status" class="race-status" hidden></p></div>
        <div class="speed-display"><strong id="speed-value">0</strong><span>km/h</span><div id="drift-meter" class="drift-meter" data-stage="0"><div class="drift-meter-label"><span id="drift-label">MINI TURBO</span><span class="drift-levels">Ⅰ / Ⅱ</span></div><div class="drift-track"><div id="drift-fill" class="drift-fill"></div><i class="drift-threshold"></i></div></div></div>
        <div class="minimap"><span>MEADOW LOOP</span><canvas id="minimap-canvas" width="360" height="256" aria-label="コース全体図。明るい枠のマーカーがあなたです。"></canvas><span class="map-you"><i></i>YOU</span></div>
        <div class="touch-controls" aria-label="タッチ操作">
          <div class="steering-area"><button id="auto-accelerate" class="auto-button" type="button" aria-pressed="false"><span class="auto-indicator"></span>自動アクセル</button><div id="steering-pad" class="steering-pad" aria-label="左右にドラッグしてハンドル操作"><span class="steering-label">STEER</span><span class="steering-arrow left">‹</span><span class="steering-arrow right">›</span><div id="steering-knob" class="steering-knob"><span></span></div></div></div>
          <div class="touch-actions"><button id="accelerate" class="touch-button accelerate-button" type="button" aria-label="アクセルを踏む">${icon('<path d="m6 14 6-6 6 6m-12 5 6-6 6 6"/>')}<span>アクセル</span></button><button id="brake" class="touch-button brake-button" type="button" aria-label="ブレーキを踏む">${icon('<path d="M6 8h12M6 15h12"/>')}<span>ブレーキ</span></button><button id="drift" class="touch-button drift-button" type="button" aria-label="長押ししてドリフト。離すとミニターボ">${driftIcon}<span>ドリフト</span></button><button id="use-item" class="touch-button item-button" type="button" aria-label="所持アイテムを使う"><span id="item-button-icon">${emptyItem}</span><span id="item-button-name">ITEM</span></button></div>
        </div>
      </section>

      <section id="results-screen" class="screen results-screen" aria-labelledby="results-heading" hidden>
        <div class="results-content">
          <div class="results-heading-row"><div><span class="eyebrow">MEADOW LOOP · 3 LAPS</span><h2 id="results-heading">FINISH!</h2></div><span id="result-position" class="result-position">1<span>位</span></span></div>
          <div class="finish-summary"><div><span>YOUR TIME</span><strong id="finish-time">00:00.00</strong></div><span id="new-record" class="record-badge" hidden>NEW BEST!</span><div class="finish-best"><span>PERSONAL BEST</span><strong id="finish-best">—</strong></div></div>
          <ol id="leaderboard" class="leaderboard" aria-label="レース順位"></ol>
          <p id="result-laps" class="result-laps"></p>
          <div class="result-actions"><button id="retry-race" class="primary-button" type="button"><span>もう一度走る</span>${arrow}</button><button id="back-title" class="secondary-button" type="button">タイトルへ</button></div>
        </div>
      </section>

      <section id="pause-dialog" class="modal-overlay" hidden><div class="pause-content" role="dialog" aria-modal="true" aria-labelledby="pause-heading"><span class="eyebrow">TAKE A BREATHER</span><h2 id="pause-heading">ひとやすみ。</h2><p>レースはここで待っています。</p><button id="resume-race" class="primary-button" type="button"><span>レースをつづける</span>${arrow}</button><button id="quit-race" class="secondary-button" type="button">タイトルへ戻る</button><span class="pause-shortcut"><kbd>ESC</kbd> で再開</span></div></section>
      <div class="orientation-hint" role="note">${icon('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="m20 7 2 3-2 3M4 17l-2-3 2-3"/>')}<span>横にしてね<span>横画面なら、もっと走りやすい。</span></span></div>
      <section id="error-dialog" class="modal-overlay error-overlay" hidden><div class="pause-content" role="alertdialog" aria-modal="true" aria-labelledby="error-heading"><span class="eyebrow">A SMALL PIT STOP</span><h2 id="error-heading">スタートできませんでした</h2><p id="error-message"></p><button id="reload-page" class="primary-button" type="button">ページを再読み込み</button></div></section>
    `;
    this.canvas = this.get<HTMLCanvasElement>('game-canvas');
    this.title = this.get('title-screen');
    this.race = this.get('race-screen');
    this.results = this.get('results-screen');
    this.pause = this.get('pause-dialog');
    this.map = this.get<HTMLCanvasElement>('minimap-canvas');
    this.mapContext = this.map.getContext('2d');
    this.prepareMap();
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
    this.screen = screen;
    this.root.dataset.screen = screen;
    this.title.hidden = screen !== 'title';
    this.race.hidden = screen !== 'race';
    this.results.hidden = screen !== 'results';
    this.setPaused(false);
    if (screen === 'race') {
      this.lastItem = undefined;
      this.lastMapTick = -1;
      this.canvas.focus({ preventScroll: true });
    } else {
      requestAnimationFrame(() => {
        if (this.screen === screen && !this.paused && this.get('error-dialog').hidden) {
          this.get(screen === 'title' ? 'start-race' : 'retry-race').focus({ preventScroll: true });
        }
      });
    }
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
    const player = state.karts.find((kart) => kart.id === 0);
    if (!player) return;
    this.text('position-value', String(getRank(state, 0)));
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

    if (this.lastItem !== player.item) {
      this.lastItem = player.item;
      this.text('item-name', player.item ? itemNames[player.item] : 'ボックスを取ろう');
      this.text('item-button-name', player.item ? itemShortNames[player.item] : 'ITEM');
      const art = player.item ? itemIcons[player.item] : emptyItem;
      this.get('item-hud-icon').innerHTML = art;
      this.get('item-button-icon').innerHTML = art;
      this.get('item-hud-icon').classList.toggle('has-item', player.item !== null);
      const button = this.get<HTMLButtonElement>('use-item');
      button.disabled = player.item === null;
      if (button.disabled) {
        button.classList.remove('is-pressed');
        button.dispatchEvent(new Event('control-disabled'));
      }
      button.setAttribute('aria-label', player.item ? `${itemNames[player.item]}を使う` : 'アイテムを持っていません');
    }
    if (state.tick !== this.lastMapTick && (state.tick % 4 === 0 || this.lastMapTick < 0)) {
      this.lastMapTick = state.tick;
      this.drawMap(state);
    }
  }

  showResults(state: RaceState, best: number | null, isRecord: boolean): void {
    const player = state.karts.find((kart) => kart.id === 0);
    if (!player) return;
    const rank = getRank(state, 0);
    const didFinish = player.finishTime !== null;
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
      row.className = kart.id === 0 ? 'leaderboard-row is-player' : 'leaderboard-row';
      const position = document.createElement('span');
      position.className = 'leaderboard-position';
      position.textContent = String(index + 1).padStart(2, '0');
      const swatch = document.createElement('i');
      swatch.className = 'racer-swatch';
      swatch.style.backgroundColor = `#${kart.color.toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'racer-name';
      name.textContent = kart.name;
      if (kart.id === 0) {
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

  private isPlaying(): boolean {
    return this.screen === 'race' && !this.paused && this.get('error-dialog').hidden;
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

  private prepareMap(): void {
    if (TRACK_SAMPLES.length === 0) return;
    const minX = Math.min(...TRACK_SAMPLES.map((point) => point.x));
    const maxX = Math.max(...TRACK_SAMPLES.map((point) => point.x));
    const minZ = Math.min(...TRACK_SAMPLES.map((point) => point.z));
    const maxZ = Math.max(...TRACK_SAMPLES.map((point) => point.z));
    this.mapScale = Math.min(144 / (maxX - minX), 99 / (maxZ - minZ));
    this.mapOffsetX = 90 - (minX + maxX) / 2 * this.mapScale;
    this.mapOffsetZ = 64 - (minZ + maxZ) / 2 * this.mapScale;
    TRACK_SAMPLES.forEach((point, index) => {
      const x = point.x * this.mapScale + this.mapOffsetX;
      const y = point.z * this.mapScale + this.mapOffsetZ;
      if (index === 0) this.trackPath.moveTo(x, y);
      else this.trackPath.lineTo(x, y);
    });
    this.trackPath.closePath();
  }

  private drawMap(state: RaceState): void {
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
    const start = TRACK_SAMPLES[0];
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
    const karts = [...state.karts].sort((a, b) => Number(a.id === 0) - Number(b.id === 0));
    for (const kart of karts) {
      const x = kart.x * this.mapScale + this.mapOffsetX;
      const y = kart.z * this.mapScale + this.mapOffsetZ;
      context.beginPath();
      if (kart.id === 0) {
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
      context.strokeStyle = kart.id === 0 ? '#ffffff' : '#173d35';
      context.lineWidth = kart.id === 0 ? 1.8 : 1;
      context.fill();
      context.stroke();
    }
  }
}
