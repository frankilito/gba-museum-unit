import { GBA_BUTTONS, codeToLabel, type GBAButton } from '../core/types';
import type { InputController } from '../core/InputController';
import type { SaveStore } from '../core/SaveStore';

/** Thin DOM layer: key hint, toast, settings (key remap), credits, touch zones. */

const BUTTON_LABELS: Record<GBAButton, string> = {
  A: 'A',
  B: 'B',
  L: 'L',
  R: 'R',
  START: 'Start',
  SELECT: 'Select',
  UP: 'Up',
  DOWN: 'Down',
  LEFT: 'Left',
  RIGHT: 'Right',
};

export class Overlay {
  private hint = document.getElementById('keyhint')!;
  private toastEl = document.getElementById('toast')!;
  private toastTimer = 0;
  private fadeTimer = 0;
  private hintVisible = true;

  constructor(
    private input: InputController,
    private store: SaveStore,
    private onKeymapChange: () => void,
  ) {
    this.renderHint();
    this.initSettings();
    this.initCredits();
    this.initTouchZones();
    input.onHintToggle(() => this.toggleHint());
  }

  // ---------- hint ----------

  renderHint(): void {
    const km = this.input.getKeymap();
    const label = (b: GBAButton): string => {
      const codes = Object.entries(km)
        .filter(([, btn]) => btn === b)
        .map(([c]) => codeToLabel(c));
      return codes.join(' / ') || '—';
    };
    const move = [label('UP'), label('DOWN'), label('LEFT'), label('RIGHT')]
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' ');
    this.hint.innerHTML =
      `Move <kbd>${move}</kbd> · ` +
      `A <kbd>${label('A')}</kbd> B <kbd>${label('B')}</kbd> · ` +
      `L <kbd>${label('L')}</kbd> R <kbd>${label('R')}</kbd> · ` +
      `Start <kbd>${label('START')}</kbd> Select <kbd>${label('SELECT')}</kbd> · ` +
      `<kbd>?</kbd> help`;
  }

  /** Show the hint, then fade after 3s of play. */
  showHintWithFade(): void {
    window.clearTimeout(this.fadeTimer);
    this.hintVisible = true;
    this.hint.classList.remove('faded');
    this.fadeTimer = window.setTimeout(() => {
      this.hintVisible = false;
      this.hint.classList.add('faded');
    }, 3000);
  }

  private toggleHint(): void {
    this.hintVisible = !this.hintVisible;
    this.hint.classList.toggle('faded', !this.hintVisible);
  }

  // ---------- toast ----------

  toast(msg: string, ms = 2600): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  // ---------- settings ----------

  private initSettings(): void {
    const dlg = document.getElementById('dlg-settings') as HTMLDialogElement;
    const grid = document.getElementById('rebind-grid')!;
    document.getElementById('btn-settings')!.addEventListener('click', () => {
      this.renderRebindGrid(grid);
      dlg.showModal();
    });
    document.getElementById('btn-settings-close')!.addEventListener('click', () => dlg.close());
    document.getElementById('btn-rebind-reset')!.addEventListener('click', () => {
      this.input.resetKeymap();
      void this.store.putConfig('keymap', this.input.getKeymap());
      this.onKeymapChange();
      this.renderRebindGrid(grid);
    });
  }

  private renderRebindGrid(grid: HTMLElement): void {
    grid.innerHTML = '';
    for (const b of GBA_BUTTONS) {
      const row = document.createElement('div');
      row.className = 'rebind-row';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = BUTTON_LABELS[b];
      const btn = document.createElement('button');
      btn.className = 'keycap-btn';
      btn.textContent = this.input.primaryLabel(b);
      btn.addEventListener('click', () => this.startListening(b, btn, grid));
      row.append(label, btn);
      grid.appendChild(row);
    }
  }

  private startListening(button: GBAButton, btn: HTMLButtonElement, grid: HTMLElement): void {
    btn.classList.add('listening');
    btn.textContent = 'press a key…';
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onKey, true);
      if (e.code !== 'Escape') {
        this.input.rebind(button, e.code);
        void this.store.putConfig('keymap', this.input.getKeymap());
        this.onKeymapChange();
      }
      this.renderRebindGrid(grid);
    };
    window.addEventListener('keydown', onKey, true);
  }

  // ---------- credits ----------

  private initCredits(): void {
    const dlg = document.getElementById('dlg-credits') as HTMLDialogElement;
    document.getElementById('btn-credits')!.addEventListener('click', () => dlg.showModal());
    document.getElementById('btn-credits-close')!.addEventListener('click', () => dlg.close());
    document.getElementById('credits-body')!.innerHTML = `
      <p>This is an unofficial interactive experiment. It is not affiliated with, endorsed by,
      or sponsored by Nintendo. “Game Boy Advance” is a trademark of its respective owner.</p>

      <h3>Emulator core</h3>
      <ul>
        <li><b>mGBA</b> © Jeffrey Pfau — MPL-2.0 · <a href="https://mgba.io" target="_blank" rel="noreferrer">mgba.io</a></li>
        <li>WASM build <b>@thenick775/mgba-wasm 2.4.1</b> (MPL-2.0) from the
        <a href="https://github.com/thenick775/gbajs3" target="_blank" rel="noreferrer">gbajs3</a> project —
        vendored in <code>public/cores/</code>, no runtime CDN.</li>
      </ul>

      <h3>Bundled homebrew cartridges (MIT License)</h3>
      <ul>
        <li><b>CASCADE7</b> — Mick Schroeder ·
        <a href="https://github.com/mick-schroeder/gba-cascade7" target="_blank" rel="noreferrer">source</a></li>
        <li><b>GBArcade v0.1.4</b> — Emma Britton ·
        <a href="https://github.com/emmabritton/gba_gbarcade" target="_blank" rel="noreferrer">source</a> ·
        <a href="https://emmatothemax.itch.io/gbarcade" target="_blank" rel="noreferrer">itch.io</a></li>
      </ul>

      <h3>3D console model</h3>
      <ul>
        <li>This work is based on <b>"Gameboy Advance - Zelda Concept" by yassineCGI</b>,
        licensed under <b>CC-BY-4.0</b> ·
        <a href="https://sketchfab.com/3d-models/gameboy-advance-zelda-concept-2c77feea6c1a42d0b20adea68d09b756" target="_blank" rel="noreferrer">Sketchfab page</a> ·
        downloaded 2026-07-13 · original format FBX + 4K PBR.</li>
        <li class="fine">Adaptations: split into named parts, indigo repaint (Zelda artwork removed),
        power slider + volume wheel added, screen island replaced at runtime, normalized to
        144.5&nbsp;mm / Y-up. A commercial candidate (warfalker, CGTrader #4518038) was not used:
        it costs $10 and was not purchased.</li>
      </ul>

      <h3>Rendering &amp; infrastructure</h3>
      <ul>
        <li>three.js (MIT) — rendering; the cartridge pouch and cartridges are original procedural models.</li>
        <li>coi-serviceworker v0.1.7 (MIT) — enables cross-origin isolation on static hosts.</li>
        <li>All button / insert / power sounds are synthesized at runtime with WebAudio — original, no samples.</li>
      </ul>

      <h3>Your ROMs</h3>
      <p class="fine">No commercial ROMs and no GBA BIOS are bundled or downloadable here. To play a
      commercial title, use one of the two <b>LOAD YOUR ROM</b> slots and import a backup you legally own —
      each slot keeps its own cartridge, and both are restored from IndexedDB on your next visit.
      Imported files are read with the File API and stored only in this browser's IndexedDB — they are
      never uploaded, analyzed, or telemetered. This site collects no ROM data, filenames, saves, or
      input telemetry.</p>
    `;
  }

  // ---------- touch assist ----------

  private initTouchZones(): void {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const hidden = localStorage.getItem('touchzones:hidden') === '1';
    if (!coarse || hidden) return;

    const root = document.createElement('div');
    root.id = 'touch-zones';
    root.innerHTML = `
      <div class="tz" id="tz-dpad">MOVE</div>
      <div class="tz" id="tz-a">A</div>
      <div class="tz" id="tz-b">B</div>
      <div class="tz" id="tz-close">✕</div>
    `;
    document.body.appendChild(root);

    const dpad = root.querySelector('#tz-dpad') as HTMLDivElement;
    const activeDirs = new Map<number, GBAButton[]>();
    const computeDirs = (e: PointerEvent): GBAButton[] => {
      const r = dpad.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dead = r.width * 0.16;
      const dirs: GBAButton[] = [];
      if (dx < -dead) dirs.push('LEFT');
      else if (dx > dead) dirs.push('RIGHT');
      if (dy < -dead) dirs.push('UP');
      else if (dy > dead) dirs.push('DOWN');
      return dirs;
    };
    const syncDirs = (id: number, dirs: GBAButton[]): void => {
      const prev = activeDirs.get(id) ?? [];
      for (const d of prev) if (!dirs.includes(d)) this.input.releaseSource(`tz:${id}`, d);
      for (const d of dirs) if (!prev.includes(d)) this.input.pressSource(`tz:${id}`, d);
      activeDirs.set(id, dirs);
      dpad.classList.toggle('active', dirs.length > 0);
    };
    dpad.addEventListener('pointerdown', (e) => {
      dpad.setPointerCapture(e.pointerId);
      syncDirs(e.pointerId, computeDirs(e));
    });
    dpad.addEventListener('pointermove', (e) => {
      if (activeDirs.has(e.pointerId)) syncDirs(e.pointerId, computeDirs(e));
    });
    const endDpad = (e: PointerEvent): void => {
      syncDirs(e.pointerId, []);
      activeDirs.delete(e.pointerId);
    };
    dpad.addEventListener('pointerup', endDpad);
    dpad.addEventListener('pointercancel', endDpad);

    for (const [zoneId, button] of [['tz-a', 'A'], ['tz-b', 'B']] as const) {
      const zone = root.querySelector(`#${zoneId}`) as HTMLDivElement;
      zone.addEventListener('pointerdown', (e) => {
        zone.setPointerCapture(e.pointerId);
        this.input.pressSource(`tz:${zoneId}:${e.pointerId}`, button);
        zone.classList.add('active');
      });
      const release = (e: PointerEvent): void => {
        this.input.releaseSource(`tz:${zoneId}:${e.pointerId}`, button);
        zone.classList.remove('active');
      };
      zone.addEventListener('pointerup', release);
      zone.addEventListener('pointercancel', release);
    }

    (root.querySelector('#tz-close') as HTMLDivElement).addEventListener('click', () => {
      root.remove();
      localStorage.setItem('touchzones:hidden', '1');
    });
  }
}
