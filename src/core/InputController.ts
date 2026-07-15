import {
  DEFAULT_KEYMAP,
  emptyButtonState,
  GBA_BUTTONS,
  codeToLabel,
  type ButtonState,
  type GBAButton,
} from './types';

export type EdgeListener = (button: GBAButton, pressed: boolean) => void;

/**
 * Single source of truth for all GBA input.
 *
 * Keyboard, pointer presses on the 3D buttons and the touch overlay all funnel
 * into pressSource()/releaseSource(). The resulting ButtonState is read by the
 * render loop every frame and applied to both the emulator core and the 3D
 * button animations in the same frame — no parallel listeners, no stuck keys.
 *
 * Per-button source sets give correct ref-counting (W + ArrowUp both held,
 * release one → still pressed). window blur / visibilitychange / pointercancel
 * release everything.
 */
export class InputController {
  readonly state: ButtonState = emptyButtonState();

  private sources = new Map<GBAButton, Set<string>>();
  private edgeListeners = new Set<EdgeListener>();
  private hintListeners = new Set<() => void>();

  /** code → button. User remaps replace the default for that button. */
  private keymap: Record<string, GBAButton> = { ...DEFAULT_KEYMAP };

  /** Master gate: the app disables input during INSERTING / EJECTING / ERROR. */
  enabled = true;

  private frameId = -1;
  /** Debug: last frame in which each edge fired (for same-frame assertions). */
  readonly lastEdgeFrame: Record<string, number> = {};

  constructor() {
    for (const b of GBA_BUTTONS) this.sources.set(b, new Set());

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseAll);
  }

  /** Called once per render frame so edge records carry a frame number. */
  tickFrame(frameId: number): void {
    this.frameId = frameId;
  }

  onEdge(fn: EdgeListener): () => void {
    this.edgeListeners.add(fn);
    return () => this.edgeListeners.delete(fn);
  }

  onHintToggle(fn: () => void): () => void {
    this.hintListeners.add(fn);
    return () => this.hintListeners.delete(fn);
  }

  // ---- sources ----

  /** Press from any source (keyboard code, pointer id, touch id…). Idempotent. */
  pressSource(sourceId: string, button: GBAButton): void {
    if (!this.enabled) return;
    const set = this.sources.get(button)!;
    if (set.has(sourceId)) return; // e.g. keydown auto-repeat: state only, no re-edge
    set.add(sourceId);
    if (set.size === 1) this.setEdge(button, true);
  }

  releaseSource(sourceId: string, button: GBAButton): void {
    const set = this.sources.get(button)!;
    if (!set.delete(sourceId)) return;
    if (set.size === 0) this.setEdge(button, false);
  }

  /** Release one button from every source (used when pointer leaves a 3D button). */
  releaseButton(button: GBAButton): void {
    const set = this.sources.get(button)!;
    if (set.size === 0) return;
    set.clear();
    this.setEdge(button, false);
  }

  releaseAll = (): void => {
    for (const b of GBA_BUTTONS) this.releaseButton(b);
  };

  private setEdge(button: GBAButton, pressed: boolean): void {
    if (this.state[button] === pressed) return;
    this.state[button] = pressed;
    this.lastEdgeFrame[`${button}:${pressed ? 'down' : 'up'}`] = this.frameId;
    for (const fn of this.edgeListeners) fn(button, pressed);
  }

  // ---- keyboard ----

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      for (const fn of this.hintListeners) fn();
      return;
    }
    // No game input while a dialog (settings/credits) is open or while
    // typing into a field — the keys belong to the UI then.
    if (document.querySelector('dialog[open]')) return;
    if (e.target instanceof HTMLInputElement) return;
    const button = this.keymap[e.code];
    if (!button) return;
    // Prevent page scroll on arrows/space.
    e.preventDefault();
    if (e.repeat) return; // held key: state stays, no animation replay
    this.pressSource(`key:${e.code}`, button);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const button = this.keymap[e.code];
    if (!button) return;
    this.releaseSource(`key:${e.code}`, button);
  };

  // ---- keymap / labels ----

  getKeymap(): Record<string, GBAButton> {
    return { ...this.keymap };
  }

  /** Primary (shortest label) key currently bound to a button, for keycap hints. */
  primaryLabel(button: GBAButton): string {
    let best: string | null = null;
    for (const [code, b] of Object.entries(this.keymap)) {
      if (b !== button) continue;
      const label = codeToLabel(code);
      if (best === null || label.length < best.length) best = label;
    }
    return best ?? '—';
  }

  rebind(button: GBAButton, code: string): void {
    // Remove any existing binding to this code, and previous primary binding of the button.
    delete this.keymap[code];
    for (const [c, b] of Object.entries(this.keymap)) {
      if (b === button) delete this.keymap[c];
    }
    this.keymap[code] = button;
  }

  resetKeymap(): void {
    this.keymap = { ...DEFAULT_KEYMAP };
  }

  loadKeymap(map: Record<string, GBAButton>): void {
    // Merge onto defaults for buttons not covered by the saved map.
    const savedButtons = new Set(Object.values(map));
    const merged: Record<string, GBAButton> = { ...map };
    for (const [code, b] of Object.entries(DEFAULT_KEYMAP)) {
      if (!savedButtons.has(b)) merged[code] = b;
    }
    this.keymap = merged;
  }
}
