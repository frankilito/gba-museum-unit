import type { AppState } from './types';

/**
 * Central state machine:
 *   OFF → INSERTING → BOOTING → PLAYING → EJECTING → OFF
 *                              ↘ ERROR ↗ (ERROR → EJECTING → OFF)
 */
const TRANSITIONS: Record<AppState, AppState[]> = {
  OFF: ['INSERTING'],
  INSERTING: ['BOOTING', 'OFF', 'ERROR'],
  BOOTING: ['PLAYING', 'ERROR', 'EJECTING'],
  PLAYING: ['EJECTING', 'ERROR'],
  EJECTING: ['OFF', 'ERROR'],
  ERROR: ['EJECTING', 'OFF'],
};

type Listener = (to: AppState, from: AppState) => void;

export class AppStateMachine {
  private _state: AppState = 'OFF';
  private listeners = new Set<Listener>();

  get state(): AppState {
    return this._state;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  can(to: AppState): boolean {
    return TRANSITIONS[this._state].includes(to);
  }

  /** Throws on illegal transitions — callers must drive the machine correctly. */
  transition(to: AppState): void {
    if (to === this._state) return;
    if (!this.can(to)) {
      throw new Error(`Illegal state transition ${this._state} → ${to}`);
    }
    const from = this._state;
    this._state = to;
    for (const fn of this.listeners) fn(to, from);
  }
}
