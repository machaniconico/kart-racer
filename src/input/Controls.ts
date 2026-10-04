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
  private touchMode: boolean;
  private enabled = false;
  private auto = false;
  private touchAuto = true;
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { action: TouchAction; element: HTMLElement }>();
  private readonly listeners: Array<() => void> = [];
  private readonly pad: HTMLElement | null;
  private readonly knob: HTMLElement | null;
  private readonly autoButton: HTMLButtonElement | null;
  private steering = 0;
  private itemQueued = false;

  constructor(private readonly root: HTMLElement) {
    this.touchMode = window.matchMedia?.('(pointer: coarse)').matches === true;
    this.auto = this.isTouch;
    this.pad = root.querySelector<HTMLElement>('#steering-pad');
    this.knob = root.querySelector<HTMLElement>('#steering-knob');
    this.autoButton = root.querySelector<HTMLButtonElement>('#auto-accelerate');
    root.classList.toggle('touch-device', this.isTouch);

    this.listen(window, 'keydown', this.onKeyDown as EventListener);
    this.listen(window, 'keyup', this.onKeyUp as EventListener);
    this.listen(window, 'blur', () => this.reset());
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.reset();
    });
    this.listen(root, 'pointerdown', ((event: PointerEvent) => {
      if (event.pointerType === 'touch') this.setTouchMode(true);
    }) as EventListener, { capture: true });
    this.listen(root, 'contextmenu', (event) => {
      if (this.enabled) event.preventDefault();
    });
    // touch-action handles Pointer Events; these also cover older WebKit gestures.
    this.listen(root, 'touchmove', ((event: TouchEvent) => {
      const scrollable = event.target instanceof Element && event.target.closest('.results-content');
      if (event.cancelable && (!scrollable || event.touches.length !== 1)) event.preventDefault();
    }) as EventListener, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      this.listen(root, type, (event) => {
        if (event.cancelable) event.preventDefault();
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
        // Pointer presses are held via this.pointers. Keyboard/AT activation is a one-tick pulse.
        if (this.enabled && (event as MouseEvent).detail === 0) this.itemQueued = true;
      });
    }
    if (this.autoButton) {
      this.listen(this.autoButton, 'click', () => this.setAutoAccelerate(!this.auto));
    }
    this.applyAutoAccelerate(this.auto);
  }

  get isTouch(): boolean {
    return this.touchMode;
  }

  get autoAccelerate(): boolean {
    return this.auto;
  }

  setAutoAccelerate(value: boolean): void {
    this.touchAuto = value;
    this.applyAutoAccelerate(value);
  }

  private applyAutoAccelerate(value: boolean): void {
    this.auto = value;
    this.autoButton?.setAttribute('aria-pressed', String(value));
    this.autoButton?.classList.toggle('active', value);
  }

  setEnabled(value: boolean): void {
    if (this.enabled === value) return;
    this.enabled = value;
    this.reset();
  }

  sample(state: RaceState, _kartId: number): InputFrame {
    const gamepad = this.readGamepad();

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
      useItem: this.itemQueued || this.itemHeld() || gamepad.useItem,
    };
    this.itemQueued = false;
    return frame;
  }

  reset(): void {
    this.keys.clear();
    this.itemQueued = false;
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
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
  }

  private listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    this.setTouchMode(false);
    this.applyAutoAccelerate(false);
    if (!this.enabled || !GAME_KEYS.has(event.code)) return;
    event.preventDefault();
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.enabled && GAME_KEYS.has(event.code)) event.preventDefault();
    this.keys.delete(event.code);
  };

  private setTouchMode(value: boolean): void {
    if (this.touchMode === value) return;
    this.reset();
    this.touchMode = value;
    this.root.classList.toggle('touch-device', value);
    this.applyAutoAccelerate(value ? this.touchAuto : false);
  }

  private bindPointer(element: HTMLElement | null, action: TouchAction): void {
    if (!element) return;
    this.listen(element, 'control-disabled', () => {
      for (const [pointerId, pointer] of this.pointers) {
        if (pointer.element !== element) continue;
        this.pointers.delete(pointerId);
        try {
          if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
        } catch { /* The pointer may already have ended. */ }
      }
      element.classList.remove('is-pressed');
      if (action === 'item') this.itemQueued = false;
    });
    this.listen(element, 'pointerdown', ((event: PointerEvent) => {
      if (!this.enabled || element.matches(':disabled') || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (action === 'steer' && this.hasPointer('steer')) return;
      this.pointers.set(event.pointerId, { action, element });
      element.classList.add('is-pressed');
      try { element.setPointerCapture(event.pointerId); } catch { /* Capture is best effort. */ }
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

  private itemHeld(): boolean {
    for (const key of ITEM_KEYS) if (this.keys.has(key)) return true;
    return this.hasPointer('item');
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
