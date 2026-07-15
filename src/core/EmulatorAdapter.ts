import { emptyButtonState, GBA_BUTTONS, type ButtonState, type GBAButton } from './types';

/**
 * EmulatorAdapter — the only code that knows about the emulator library.
 *
 * Wraps the self-hosted mGBA WASM core (@thenick775/mgba-wasm 2.4.1, MPL-2.0,
 * vendored in public/cores/). One long-lived Module instance is kept for the
 * app lifetime; ROM switching is quitGame() + loadGame(), which avoids the
 * AudioContext / wasm-memory churn of recreating instances.
 *
 * The core renders GBA-native 240×160 RGBA into the provided <canvas> itself
 * (SDL2 putImageData). That canvas is parked off-screen (never display:none,
 * which would stall the rAF-driven emulation loop and audio scheduling) and
 * is used directly as a THREE.CanvasTexture source.
 */

/** GBAButton → mGBA input name. NOTE: unknown names silently press 'a' in the core — always go through this map. */
const MGBA_BUTTON: Record<GBAButton, string> = {
  A: 'a',
  B: 'b',
  L: 'l',
  R: 'r',
  START: 'start',
  SELECT: 'select',
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
};

interface MgbaFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
}

interface MgbaModule {
  FS: MgbaFS;
  SDL2?: { audioContext?: AudioContext };
  saveName?: string;
  gameName?: string;
  loadGame(romPath: string): boolean;
  quitGame(): void;
  quitMgba(): void;
  quickReload(): void;
  pauseGame(): void;
  resumeGame(): void;
  pauseAudio(): void;
  resumeAudio(): void;
  buttonPress(name: string): void;
  buttonUnpress(name: string): void;
  toggleInput(enabled: boolean): void;
  FSInit(): Promise<void>;
  FSSync(): Promise<void>;
  filePaths(): { gamePath: string; savePath: string; saveStatePath: string };
  getSave(): Uint8Array | null;
  saveState(slot: number): boolean;
  loadState(slot: number): boolean;
  setVolume(percent: number): void;
  setCoreSettings(settings: Record<string, number | boolean>): void;
  addCoreCallbacks(callbacks: {
    saveDataUpdatedCallback?: (() => void) | null;
    videoFrameEndedCallback?: (() => void) | null;
    coreCrashedCallback?: (() => void) | null;
  }): void;
  version?: { projectVersion?: string; gitCommit?: string };
}

type MgbaFactory = (opts: { canvas: HTMLCanvasElement }) => Promise<MgbaModule>;

let gluePromise: Promise<MgbaFactory> | null = null;

function loadGlue(): Promise<MgbaFactory> {
  if (!gluePromise) {
    if (!window.crossOriginIsolated) {
      return Promise.reject(
        new Error(
          'Cross-origin isolation is not active (the mGBA core needs COOP/COEP for its threads). ' +
            'On a static host this is fixed by the bundled COI service worker after one reload.',
        ),
      );
    }
    // Resolve against the document so Vite's relative base ('./') works on sub-path deploys.
    const url = new URL('cores/mgba.js', document.baseURI).href;
    gluePromise = (import(/* @vite-ignore */ url) as Promise<{ default: MgbaFactory }>).then(
      (m) => m.default,
    );
  }
  return gluePromise;
}

export interface FlushResult {
  /** Raw SRAM bytes, or null when the ROM has no save hardware / never wrote. */
  sram: Uint8Array | null;
  /** Save-state snapshot bytes (always produced when a game is loaded). */
  state: Uint8Array | null;
}

let getContextPatched = false;

/**
 * Force preserveDrawingBuffer on the emulator canvas's WebGL context so the
 * frame contents survive compositing and can be used as a texture source.
 * The patch only intercepts the one canvas the core renders into.
 */
function patchGetContextForCanvas(target: HTMLCanvasElement): void {
  if (getContextPatched) return;
  getContextPatched = true;
  const orig = HTMLCanvasElement.prototype.getContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function (
    this: HTMLCanvasElement,
    type: string,
    attrs?: CanvasRenderingContext2DSettings | WebGLContextAttributes,
  ) {
    if (this === target && (type === 'webgl2' || type === 'webgl')) {
      attrs = { ...(attrs as WebGLContextAttributes), preserveDrawingBuffer: true };
    }
    return orig.call(this, type as '2d', attrs as never);
  };
}

type FrameListener = () => void;

export class EmulatorAdapter {
  readonly canvas: HTMLCanvasElement;

  private module: MgbaModule | null = null;
  private romPath: string | null = null;
  private romKey: string | null = null; // content hash → unique file names in the core FS
  private gameRunning = false;
  private paused = false;

  /** Buttons currently applied to the core (diffed by syncButtons). */
  private applied: ButtonState = emptyButtonState();

  private frameId = -1;
  /** Debug: render-frame in which each button edge was applied to the core. */
  readonly lastApplyFrame: Record<string, number> = {};

  private frameListeners = new Set<FrameListener>();
  private crashListeners = new Set<(msg: string) => void>();
  private saveWriteListeners = new Set<() => void>();

  /** Number of video frames presented by the core (debug / tests). */
  frameCount = 0;

  private firstFrameResolvers: Array<() => void> = [];

  private constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /**
   * Create the adapter. Must be called from a user gesture so the SDL2
   * AudioContext is allowed to start.
   */
  static async create(canvas: HTMLCanvasElement): Promise<EmulatorAdapter> {
    // The core's SDL2 renderer uses a WebGL2 context on this canvas. Without
    // preserveDrawingBuffer the buffer is cleared after compositing, so our
    // per-frame texImage2D readback would see black. Patch getContext — scoped
    // strictly to this one canvas element — before the core grabs its context.
    patchGetContextForCanvas(canvas);

    const factory = await loadGlue();
    const module = await factory({ canvas });
    await module.FSInit();
    module.toggleInput(false); // we own all input; no SDL key listeners
    module.setVolume(1);

    const adapter = new EmulatorAdapter(canvas);
    adapter.module = module;
    adapter.installCallbacks();
    return adapter;
  }

  private installCallbacks(): void {
    const m = this.module!;
    m.addCoreCallbacks({
      videoFrameEndedCallback: () => {
        this.frameCount++;
        for (const fn of this.frameListeners) fn();
        if (this.firstFrameResolvers.length > 0) {
          const resolvers = this.firstFrameResolvers.splice(0);
          for (const r of resolvers) r();
        }
      },
      saveDataUpdatedCallback: () => {
        for (const fn of this.saveWriteListeners) fn();
      },
      coreCrashedCallback: () => {
        this.gameRunning = false;
        for (const fn of this.crashListeners) fn('The emulator core crashed while running this ROM.');
      },
    });
  }

  onFrame(fn: FrameListener): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  onCrash(fn: (msg: string) => void): () => void {
    this.crashListeners.add(fn);
    return () => this.crashListeners.delete(fn);
  }

  /** Fires when the running game writes to its save memory. */
  onSaveWrite(fn: () => void): () => void {
    this.saveWriteListeners.add(fn);
    return () => this.saveWriteListeners.delete(fn);
  }

  get isRunning(): boolean {
    return this.gameRunning && !this.paused;
  }

  get coreVersion(): string {
    return this.module?.version?.projectVersion ?? 'unknown';
  }

  /**
   * Load and start a ROM. `key` must be unique per ROM (content hash) — it
   * names the files in the core FS, so SRAM/state files never collide.
   * `sram` (if given) is pre-seeded as the game's save memory before boot.
   * Resolves on the first rendered frame; rejects on load failure/timeout.
   */
  async loadRom(key: string, bytes: Uint8Array, sram: Uint8Array | null): Promise<void> {
    const m = this.requireModule();
    if (this.gameRunning) {
      try {
        m.quitGame();
      } catch {
        /* core tolerates quit without game */
      }
      this.gameRunning = false;
    }

    const paths = m.filePaths();
    const romPath = `${paths.gamePath}/${key}.gba`;
    m.FS.writeFile(romPath, bytes);
    if (sram && sram.length > 0) {
      m.FS.writeFile(`${paths.savePath}/${key}.sav`, sram);
    }

    const firstFrame = this.waitFirstFrame();
    let ok = false;
    try {
      ok = m.loadGame(romPath);
    } catch (err) {
      throw new Error(`Core rejected the ROM: ${String(err)}`);
    }
    if (!ok) throw new Error('Core failed to load the ROM.');

    // The C side only applies callbacks while a core exists (renderer->core),
    // so the registration from create() was dropped. Re-register now that the
    // game is loaded — this is what makes frame/save/crash callbacks fire.
    this.installCallbacks();

    // Controlled lifecycle: no rewind ring buffer, no auto save-states — we
    // snapshot SRAM/state ourselves on eject. Keeps memory flat across switches.
    try {
      m.setCoreSettings({
        rewindEnable: false,
        autoSaveStateEnable: false,
        restoreAutoSaveStateOnLoad: false,
      });
    } catch {
      /* settings are best-effort */
    }

    this.romPath = romPath;
    this.romKey = key;
    this.gameRunning = true;
    this.paused = false;
    this.applied = emptyButtonState();

    await firstFrame; // throws on timeout → caller routes to ERROR
  }

  private waitFirstFrame(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.firstFrameResolvers = this.firstFrameResolvers.filter((r) => r !== done);
        reject(new Error('Timed out waiting for the first video frame.'));
      }, 15000);
      const done = (): void => {
        window.clearTimeout(timer);
        resolve();
      };
      this.firstFrameResolvers.push(done);
    });
  }

  pause(): void {
    if (!this.module || !this.gameRunning || this.paused) return;
    this.module.pauseGame();
    try {
      this.module.pauseAudio();
    } catch {
      /* audio may not be initialized yet */
    }
    this.paused = true;
  }

  resume(): void {
    if (!this.module || !this.gameRunning || !this.paused) return;
    this.module.resumeGame();
    try {
      this.module.resumeAudio();
    } catch {
      /* ignore */
    }
    void this.resumeAudioContext();
    this.paused = false;
  }

  async reset(): Promise<void> {
    if (!this.module || !this.gameRunning) return;
    this.module.quickReload();
    this.applied = emptyButtonState();
  }

  press(button: GBAButton): void {
    if (!this.module || !this.gameRunning || this.paused) return;
    this.module.buttonPress(MGBA_BUTTON[button]);
    this.applied[button] = true;
  }

  release(button: GBAButton): void {
    if (!this.module || !this.gameRunning) return;
    this.module.buttonUnpress(MGBA_BUTTON[button]);
    this.applied[button] = false;
  }

  /**
   * Diff the single-source-of-truth ButtonState against what the core has and
   * apply edges. Called once per render frame, right before the 3D button
   * animations read the same state → input and animation change in one frame.
   */
  syncButtons(state: ButtonState): void {
    if (!this.module || !this.gameRunning || this.paused) return;
    for (const b of GBA_BUTTONS) {
      if (state[b] === this.applied[b]) continue;
      if (state[b]) this.module.buttonPress(MGBA_BUTTON[b]);
      else this.module.buttonUnpress(MGBA_BUTTON[b]);
      this.applied[b] = state[b];
      this.lastApplyFrame[`${b}:${state[b] ? 'down' : 'up'}`] = this.frameId;
    }
  }

  /** Called once per render frame so apply records carry a frame number. */
  tickFrame(frameId: number): void {
    this.frameId = frameId;
  }

  /**
   * Save-state snapshot of the running game (core slot 0), for the manual
   * SAVE button. Returns null when nothing is running or the core refuses —
   * callers must report honestly instead of faking success.
   */
  async saveStateSnapshot(): Promise<Uint8Array | null> {
    if (!this.module || !this.gameRunning || !this.romKey) return null;
    const m = this.module;
    try {
      if (m.saveState(0)) {
        return m.FS.readFile(`${m.filePaths().saveStatePath}/${this.romKey}.ss0`);
      }
    } catch {
      /* core rejected the snapshot */
    }
    return null;
  }

  /**
   * Restore a snapshot taken by saveStateSnapshot(). Writes it into the core's
   * slot-0 state file, then asks the core to load it. Returns the core's own
   * verdict — false means the state was rejected.
   */
  async loadStateSnapshot(bytes: Uint8Array): Promise<boolean> {
    if (!this.module || !this.gameRunning || !this.romKey || bytes.length === 0) return false;
    const m = this.module;
    try {
      m.FS.writeFile(`${m.filePaths().saveStatePath}/${this.romKey}.ss0`, bytes);
      return m.loadState(0);
    } catch {
      return false;
    }
  }

  /** Snapshot SRAM + a save state, then persist the core FS to IndexedDB. */
  async flushSave(): Promise<FlushResult> {
    const m = this.requireModule();
    let sram: Uint8Array | null = null;
    let state: Uint8Array | null = null;

    if (this.gameRunning || this.romPath) {
      try {
        sram = m.getSave();
      } catch {
        sram = null; // no save hardware / never written → do not fake success
      }
      if (this.gameRunning) {
        try {
          if (m.saveState(0) && this.romKey) {
            state = m.FS.readFile(`${m.filePaths().saveStatePath}/${this.romKey}.ss0`);
          }
        } catch {
          state = null;
        }
      }
      try {
        await m.FSSync();
      } catch {
        /* IDBFS sync is best-effort during teardown */
      }
    }
    return { sram: sram && sram.length > 0 ? sram : null, state };
  }

  /** Tear down the current game but keep the runtime (used on eject). */
  unload(): void {
    if (!this.module) return;
    if (this.gameRunning) {
      try {
        this.module.quitGame();
      } catch {
        /* ignore */
      }
    }
    this.gameRunning = false;
    this.paused = false;
    this.romPath = null;
    this.romKey = null;
    this.applied = emptyButtonState();
  }

  setMuted(muted: boolean): void {
    try {
      this.module?.setVolume(muted ? 0 : 1);
    } catch {
      /* ignore */
    }
  }

  async resumeAudioContext(): Promise<void> {
    try {
      const ctx = this.module?.SDL2?.audioContext;
      if (ctx && ctx.state !== 'running') await ctx.resume();
    } catch {
      /* audio init may lag behind loadGame */
    }
  }

  async destroy(): Promise<void> {
    if (!this.module) return;
    try {
      await this.flushSave();
    } catch {
      /* ignore */
    }
    try {
      if (this.gameRunning) this.module.quitGame();
      this.module.quitMgba();
    } catch {
      /* runtime may already be gone */
    }
    this.module = null;
    this.gameRunning = false;
    this.frameListeners.clear();
    this.crashListeners.clear();
    this.saveWriteListeners.clear();
  }

  private requireModule(): MgbaModule {
    if (!this.module) throw new Error('EmulatorAdapter not initialized');
    return this.module;
  }
}
