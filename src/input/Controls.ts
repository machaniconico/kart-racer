import type { InputFrame, InputSource, RaceState } from '../sim/types';

type TouchAction = 'steer' | 'throttle' | 'brake' | 'drift' | 'item';

const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyE',
]);
const ITEM_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'KeyE']);

const neutral = (): InputFrame => ({
  steer: 0, throttle: 0, brake: false, drift: false, useItem: false,
});
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Converts every local input device into the same fixed-tick simulation input. */
export class Controls implements InputSource {
  readonly isTouch: boolean;

  private enabled = false;
  private auto = false;
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { action: TouchAction; element: HTMLElement }>();
  private readonly listeners: Array<() => void> = [];
  private readonly pad: HTMLElement | null;
  private readonly knob: HTMLElement | null;
  private readonly autoButton: HTMLButtonElement | null;
  private steering = 0;
  private itemQueued = false;
  private gamepadItemHeld = false;
  private readonly originalTouchAction: string;

  constructor(private readonly root: HTMLElement) {
    this.isTouch = window.matchMedia?.('(pointer: coarse)').matches === true || navigator.maxTouchPoints > 0;
    this.auto = this.isTouch;
    this.pad = root.querySelector<HTMLElement>('#steering-pad');
    this.knob = root.querySelector<HTMLElement>('#steering-knob');
    this.autoButton = root.querySelector<HTMLButtonElement>('#auto-accelerate');
    this.originalTouchAction = root.style.touchAction;

    this.listen(window, 'keydown', this.onKeyDown as EventListener);
    this.listen(window, 'keyup', this.onKeyUp as EventListener);
    this.listen(window, 'blur', () => this.reset());
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.reset();
    });
    this.listen(root, 'contextmenu', (event) => {
      if (this.enabled) event.preventDefault();
    });
    // touch-action handles Pointer Events; these also cover older WebKit gestures.
    for (const type of ['touchmove', 'gesturestart', 'gesturechange', 'gestureend']) {
      this.listen(root, type, (event) => {
        if (this.enabled && event.cancelable) event.preventDefault();
      }, { passive: false });
    }

    this.bindPointer(this.pad, 'steer');
    this.bindPointer(root.querySelector<HTMLElement>('#accelerate'), 'throttle');
    this.bindPointer(root.querySelector<HTMLElement>('#brake'), 'brake');
    this.bindPointer(root.querySelector<HTMLElement>('#drift'), 'drift');
    const itemButton = root.querySelector<HTMLElement>('#use-item');
    this.bindPointer(itemButton, 'item');
    if (itemButton) {
      this.listen(itemButton, 'click', (event) => {
        // Pointer presses were already queued on pointerdown. Preserve keyboard/AT activation.
        if (this.enabled && (event as MouseEvent).detail === 0) this.itemQueued = true;
      });
    }
    if (this.autoButton) {
      this.listen(this.autoButton, 'click', () => this.setAutoAccelerate(!this.auto));
    }
    this.setAutoAccelerate(this.auto);
  }

  get autoAccelerate(): boolean {
    return this.auto;
  }

  setAutoAccelerate(value: boolean): void {
    this.auto = value;
    this.autoButton?.setAttribute('aria-pressed', String(value));
    this.autoButton?.classList.toggle('active', value);
  }

  setEnabled(value: boolean): void {
    if (this.enabled === value) return;
    this.enabled = value;
    this.root.style.touchAction = value ? 'none' : this.originalTouchAction;
    this.reset();
  }

  sample(state: RaceState, _kartId: number): InputFrame {
    const gamepad = this.readGamepad();
    const gamepadItemPressed = gamepad.useItem && !this.gamepadItemHeld;
    this.gamepadItemHeld = gamepad.useItem;

    if (!this.enabled || state.phase !== 'racing') {
      this.itemQueued = false;
      return neutral();
    }

    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    const keyboardSteer = Number(right) - Number(left);
    const steer = keyboardSteer !== 0 ? keyboardSteer : (this.hasPointer('steer') ? this.steering : gamepad.steer);
    const brake = this.keys.has('ArrowDown') || this.keys.has('KeyS') || this.hasPointer('brake') || gamepad.brake;
    const accelerating = this.auto || this.keys.has('ArrowUp') || this.keys.has('KeyW') || this.hasPointer('throttle');
    const frame: InputFrame = {
      steer: clamp(steer, -1, 1),
      throttle: brake ? 0 : Math.max(Number(accelerating), gamepad.throttle),
      brake,
      drift: this.keys.has('Space') || this.hasPointer('drift') || gamepad.drift,
      useItem: this.itemQueued || gamepadItemPressed,
    };
    this.itemQueued = false;
    return frame;
  }

  reset(): void {
    this.keys.clear();
    this.itemQueued = false;
    this.gamepadItemHeld = false;
    const held = [...this.pointers.entries()];
    this.pointers.clear();
    for (const [pointerId, { element }] of held) {
      element.classList.remove('is-pressed');
      try {
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      } catch { /* The browser may already have cancelled the pointer. */ }
    }
    this.steering = 0;
    this.moveKnob(0, 0);
  }

  dispose(): void {
    this.enabled = false;
    this.reset();
    this.root.style.touchAction = this.originalTouchAction;
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
  }

  private listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || !GAME_KEYS.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    // Space activates focused utility buttons normally, including mute/pause/auto.
    if (event.code === 'Space' && target instanceof HTMLElement && target.closest('button') && target.getClientRects().length > 0) return;
    event.preventDefault();
    if (ITEM_KEYS.has(event.code) && !event.repeat && !this.keys.has(event.code)) this.itemQueued = true;
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.keys.has(event.code) && this.enabled) event.preventDefault();
    this.keys.delete(event.code);
  };

  private bindPointer(element: HTMLElement | null, action: TouchAction): void {
    if (!element) return;
    this.listen(element, 'pointerdown', ((event: PointerEvent) => {
      if (!this.enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (action === 'steer' && this.hasPointer('steer')) return;
      this.pointers.set(event.pointerId, { action, element });
      element.classList.add('is-pressed');
      try { element.setPointerCapture(event.pointerId); } catch { /* Capture is best effort. */ }
      if (action === 'item') this.itemQueued = true;
      if (action === 'steer') this.updateSteering(event);
    }) as EventListener);
    this.listen(element, 'pointermove', ((event: PointerEvent) => {
      if (this.pointers.get(event.pointerId)?.action === 'steer') this.updateSteering(event);
    }) as EventListener);
    const release = ((event: PointerEvent) => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer) return;
      this.pointers.delete(event.pointerId);
      if (![...this.pointers.values()].some((held) => held.element === element)) element.classList.remove('is-pressed');
      if (pointer.action === 'steer') {
        this.steering = 0;
        this.moveKnob(0, 0);
      }
    }) as EventListener;
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.listen(element, type, release);
  }

  private updateSteering(event: PointerEvent): void {
    if (!this.pad) return;
    const bounds = this.pad.getBoundingClientRect();
    const radius = Math.max(1, Math.min(bounds.width, bounds.height) * 0.36);
    let x = event.clientX - bounds.left - bounds.width / 2;
    let y = event.clientY - bounds.top - bounds.height / 2;
    const distance = Math.hypot(x, y);
    if (distance > radius) { x *= radius / distance; y *= radius / distance; }
    const raw = clamp(x / radius, -1, 1);
    this.steering = Math.abs(raw) < 0.04 ? 0 : raw;
    this.moveKnob(x, y);
  }

  private moveKnob(x: number, y: number): void {
    if (this.knob) this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  private hasPointer(action: TouchAction): boolean {
    for (const pointer of this.pointers.values()) if (pointer.action === action) return true;
    return false;
  }

  private readGamepad(): InputFrame {
    try {
      const pads = navigator.getGamepads?.();
      const pad = pads && [...pads].find((candidate) => candidate?.connected);
      if (!pad) return neutral();
      const value = (index: number): number => pad.buttons[index]?.value ?? 0;
      const pressed = (index: number): boolean => pad.buttons[index]?.pressed ?? false;
      const axis = pad.axes[0] ?? 0;
      const stick = Math.abs(axis) > 0.14 ? Math.sign(axis) * (Math.abs(axis) - 0.14) / 0.86 : 0;
      return {
        steer: clamp(pressed(14) || pressed(15) ? Number(pressed(15)) - Number(pressed(14)) : stick, -1, 1),
        throttle: clamp(Math.max(value(7), value(0)), 0, 1),
        brake: value(6) > 0.2 || pressed(1),
        drift: pressed(2),
        useItem: pressed(5) || pressed(3),
      };
    } catch {
      // Sandboxed documents and some browsers disable Gamepad API access.
      return neutral();
    }
  }
}
