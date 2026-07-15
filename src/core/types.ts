/** Shared types across the app. */

export type GBAButton =
  | 'A'
  | 'B'
  | 'L'
  | 'R'
  | 'START'
  | 'SELECT'
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT';

export const GBA_BUTTONS: readonly GBAButton[] = [
  'A', 'B', 'L', 'R', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT',
] as const;

export type ButtonState = Record<GBAButton, boolean>;

export function emptyButtonState(): ButtonState {
  return {
    A: false, B: false, L: false, R: false,
    START: false, SELECT: false,
    UP: false, DOWN: false, LEFT: false, RIGHT: false,
  };
}

export type AppState = 'OFF' | 'INSERTING' | 'BOOTING' | 'PLAYING' | 'EJECTING' | 'ERROR';

/** Default key bindings, keyed by KeyboardEvent.code (layout independent). */
export const DEFAULT_KEYMAP: Record<string, GBAButton> = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  KeyW: 'UP',
  KeyS: 'DOWN',
  KeyA: 'LEFT',
  KeyD: 'RIGHT',
  KeyK: 'A',
  KeyJ: 'B',
  KeyQ: 'L',
  KeyE: 'R',
  Enter: 'START',
  ShiftLeft: 'SELECT',
  ShiftRight: 'SELECT',
};

/** Short display label for a KeyboardEvent.code, used on the 3D keycap hints. */
export function codeToLabel(code: string): string {
  const map: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Enter', Space: 'Space',
    ShiftLeft: 'Shift', ShiftRight: 'Shift',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
    AltLeft: 'Alt', AltRight: 'Alt',
    MetaLeft: 'Cmd', MetaRight: 'Cmd',
    Backspace: '⌫', Tab: 'Tab', Escape: 'Esc',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  return code;
}
