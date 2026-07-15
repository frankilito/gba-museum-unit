import './styles.css';
import * as THREE from 'three';
import { AppStateMachine } from './core/AppStateMachine';
import { EmulatorAdapter } from './core/EmulatorAdapter';
import { InputController } from './core/InputController';
import { SaveStore } from './core/SaveStore';
import { hashRom } from './core/romHash';
import { validateRom } from './core/romHeader';
import type { GBAButton } from './core/types';
import { SfxEngine } from './audio/SfxEngine';
import { Scene3D } from './scene/Scene3D';
import { SLOT_APPROACH_POS } from './scene/HandheldModel';
import { CartridgeManager, UPLOAD_SLOTS, type CartDef } from './scene/CartridgeManager';
import { errorScreenTexture } from './scene/textures';
import { Overlay } from './ui/overlay';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const emuCanvas = document.getElementById('emu-canvas') as HTMLCanvasElement;

  const store = await SaveStore.open();
  const fsm = new AppStateMachine();
  const input = new InputController();
  const sfx = new SfxEngine();
  const scene3d = new Scene3D(canvas);
  const carts = new CartridgeManager(scene3d);

  // minimal loading state until the console GLB (shell/stand/LCD) is ready
  const bootStatus = document.getElementById('boot-status');
  scene3d.handheld.ready.finally(() => bootStatus?.classList.add('done'));

  // screen texture: GBA-native 240×160, nearest filtering, strict 3:2
  const screenTex = new THREE.CanvasTexture(emuCanvas);
  screenTex.magFilter = THREE.NearestFilter;
  screenTex.minFilter = THREE.NearestFilter;
  screenTex.generateMipmaps = false;
  screenTex.colorSpace = THREE.SRGBColorSpace;
  scene3d.handheld.setScreenTexture(screenTex);

  // saved keymap + keycap hints
  const savedKeymap = await store.getConfig<Record<string, GBAButton>>('keymap');
  if (savedKeymap) input.loadKeymap(savedKeymap);
  const applyKeyLabels = (): void => {
    scene3d.handheld.setKeyLabels({
      A: input.primaryLabel('A'),
      B: input.primaryLabel('B'),
      L: input.primaryLabel('L'),
      R: input.primaryLabel('R'),
      START: input.primaryLabel('START'),
      SELECT: input.primaryLabel('SELECT'),
      DPAD: `${input.primaryLabel('UP')}·${input.primaryLabel('LEFT')}·${input.primaryLabel('RIGHT')}·${input.primaryLabel('DOWN')}`,
    });
  };
  applyKeyLabels();

  const overlay = new Overlay(input, store, () => {
    applyKeyLabels();
    overlay.renderHint();
  });

  // restore the user's uploaded carts (two independent slots, local IndexedDB)
  const storedRoms = await store.listRoms();
  const slotMap = (await store.getConfig<Record<string, string>>('uploadSlots')) ?? {};
  for (const slotId of UPLOAD_SLOTS) {
    const hash = slotMap[slotId];
    const r = storedRoms.find((x) => x.hash === hash);
    if (r) {
      carts.setUploadedCart(slotId, {
        title: r.title,
        subtitle: 'Your ROM · local only',
        accent: r.accent,
        variant: 'imported',
        romBytes: r.bytes,
        hash: r.hash,
      });
    }
  }
  // keep at most the two slotted ROMs; evict anything unreferenced
  for (const r of storedRoms) {
    if (!Object.values(slotMap).includes(r.hash)) void store.deleteRom(r.hash);
  }

  // ---------- emulator (lazy, created on first cartridge interaction) ----------

  let adapter: EmulatorAdapter | null = null;
  let adapterPromise: Promise<EmulatorAdapter> | null = null;
  let currentHash: string | null = null;
  let bootGen = 0;
  let lastError = '';

  const ensureAdapter = (): Promise<EmulatorAdapter> => {
    if (adapter) return Promise.resolve(adapter);
    if (!adapterPromise) {
      adapterPromise = EmulatorAdapter.create(emuCanvas)
        .then((a) => {
          adapter = a;
          a.onFrame(() => {
            screenTex.needsUpdate = true;
          });
          a.onCrash((msg) => {
            if (fsm.state === 'PLAYING' || fsm.state === 'BOOTING') void errorFlow(msg);
          });
          let debounce = 0;
          a.onSaveWrite(() => {
            window.clearTimeout(debounce);
            debounce = window.setTimeout(() => void flushSramOnly(), 1200);
          });
          return a;
        })
        .catch((err) => {
          adapterPromise = null;
          throw err;
        });
    }
    return adapterPromise;
  };

  const flushSramOnly = async (): Promise<void> => {
    if (!adapter || !currentHash) return;
    try {
      const { sram } = await adapter.flushSave();
      if (sram) await store.putSram(currentHash, sram);
    } catch {
      /* best effort */
    }
  };

  // ---------- state flows ----------

  const loadRomBytes = async (cart: CartDef): Promise<{ bytes: Uint8Array; hash: string }> => {
    let bytes: Uint8Array;
    if (cart.romBytes) {
      bytes = cart.romBytes;
    } else if (cart.romUrl) {
      const res = await fetch(new URL(cart.romUrl, document.baseURI).href);
      if (!res.ok) throw new Error(`Could not load ${cart.romUrl} (HTTP ${res.status}).`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      throw new Error('This cartridge has no ROM.');
    }
    const v = validateRom(bytes, cart.romUrl ?? `${cart.title}.gba`);
    if (!v.ok) throw new Error(v.reason ?? 'Invalid ROM.');
    const hash = cart.hash ?? (await hashRom(bytes));
    cart.hash = hash;
    return { bytes, hash };
  };

  const insertFlow = async (cart: CartDef): Promise<void> => {
    if (!fsm.can('INSERTING')) return;
    const gen = ++bootGen;
    fsm.transition('INSERTING');
    input.enabled = false;
    sfx.unlock();
    if (scene3d.gripEligibleDevice) {
      // phone insert = transition to landscape grip: attempt the real
      // orientation lock inside this gesture chain (silent fallback to the
      // rotate hint on iOS), play the zoom+roll cinematic either way, and
      // slide the cart drawer out if it was open
      tryLandscapeLock();
      scene3d.beginGripCinematic();
      setGripDrawerOpen(false);
    }

    const romP = loadRomBytes(cart);
    const adapterP = ensureAdapter();

    await carts.insertSequence(cart, () => {
      sfx.insertLatch();
      scene3d.handheld.shake(0.4, 0.14);
    });
    if (gen !== bootGen) return;

    scene3d.handheld.setPower(true);
    sfx.powerSlide();
    fsm.transition('BOOTING');
    scene3d.handheld.setBacklightTarget(true);

    try {
      const [{ bytes, hash }, a] = await Promise.all([romP, adapterP]);
      if (gen !== bootGen) return;
      currentHash = hash;
      const sram = await store.getSram(hash);
      await a.loadRom(hash, bytes, sram);
      if (gen !== bootGen) return;
      await a.resumeAudioContext();
      fsm.transition('PLAYING');
      input.enabled = true;
      scene3d.setPlayView(true);
      overlay.showHintWithFade();
    } catch (err) {
      if (gen !== bootGen) return;
      await errorFlow(err instanceof Error ? err.message : String(err));
    }
  };

  const errorFlow = async (message: string): Promise<void> => {
    if (fsm.state !== 'BOOTING' && fsm.state !== 'PLAYING') return;
    lastError = message;
    fsm.transition('ERROR');
    input.enabled = false;
    sfx.errorBuzz();
    scene3d.setPlayView(false);
    const lines = wrapError(message);
    scene3d.handheld.setErrorScreen(errorScreenTexture(lines));
    scene3d.handheld.setBacklightTarget(true); // keep the error readable
    await sleep(2000);
    await ejectFlow();
  };

  const ejectFlow = async (): Promise<void> => {
    if (fsm.state !== 'PLAYING' && fsm.state !== 'ERROR' && fsm.state !== 'BOOTING') return;
    const wasPlaying = fsm.state === 'PLAYING';
    bootGen++; // invalidate any in-flight boot
    fsm.transition('EJECTING');
    input.enabled = false;
    scene3d.setPlayView(false);
    scene3d.handheld.setBacklightTarget(false);
    scene3d.handheld.setPower(false);

    const cart = carts.insertedCart;
    if (adapter && wasPlaying) {
      adapter.pause();
      try {
        const { sram, state } = await adapter.flushSave();
        if (sram && currentHash) {
          await store.putSram(currentHash, sram);
          overlay.toast('Progress saved to this browser');
        } else {
          overlay.toast('No save memory in this game');
        }
        if (state && currentHash) await store.putState(currentHash, state);
      } catch {
        /* teardown must continue */
      }
    }
    sfx.powerSlide();
    sfx.ejectRelease();
    if (cart) await carts.ejectSequence(cart);
    adapter?.unload();
    scene3d.handheld.restoreScreen();
    currentHash = null;
    fsm.transition('OFF');
    input.enabled = true;
  };

  carts.onInsertRequest = (cart) => void insertFlow(cart);
  carts.onEjectRequest = () => void ejectFlow();
  carts.onHoverSound = () => sfx.hoverTick();
  carts.onDragFocus = (on) => scene3d.setDragFocus(on);

  // ---------- mobile landscape grip mode ----------

  const gripHint = document.getElementById('grip-hint')!;
  const gripExit = document.getElementById('grip-exit')!;
  let gripHintDismissed = false; // session-only: never nags again once closed

  // Insert on a phone = transition to landscape grip: try fullscreen +
  // orientation.lock('landscape') inside the drag-release gesture chain
  // (Chrome/Android grants it; iOS Safari has no such API and any rejection
  // falls through silently to the rotate-hint flow). The zoom+roll cinematic
  // plays regardless of the lock outcome.
  const tryLandscapeLock = (): void => {
    try {
      const so = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
      const attemptLock = (): void => {
        try {
          void so?.lock?.('landscape')?.catch(() => undefined);
        } catch {
          /* unsupported */
        }
      };
      const reqFs = document.documentElement.requestFullscreen?.bind(document.documentElement);
      if (reqFs) void reqFs().then(attemptLock, attemptLock);
      else attemptLock();
    } catch {
      /* unsupported — the rotate-hint flow remains */
    }
  };
  const releaseLandscapeLock = (): void => {
    try {
      (screen.orientation as (ScreenOrientation & { unlock?: () => void }) | undefined)?.unlock?.();
    } catch {
      /* unsupported */
    }
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    } catch {
      /* best effort */
    }
  };

  // Grip cart drawer: the pouch parks off the right screen edge; a leftward
  // swipe from the right edge (or a quick horizontal flick) slides it in for
  // cart swaps. Auto-closes on insert, on the chip, or after a timeout.
  let gripDrawerTimer = 0;
  const DRAWER_AUTOCLOSE_MS = 20000;
  const setGripDrawerOpen = (on: boolean): void => {
    window.clearTimeout(gripDrawerTimer);
    carts.setGripPouchOpen(on);
    scene3d.setGripDrawerOpen(on);
    if (on) gripDrawerTimer = window.setTimeout(() => setGripDrawerOpen(false), DRAWER_AUTOCLOSE_MS);
  };
  const pokeGripDrawer = (): void => {
    if (!carts.drawerOpen) return;
    window.clearTimeout(gripDrawerTimer);
    gripDrawerTimer = window.setTimeout(() => setGripDrawerOpen(false), DRAWER_AUTOCLOSE_MS);
  };

  const syncGripUi = (): void => {
    const playing = fsm.state === 'PLAYING';
    const portrait = window.innerHeight > window.innerWidth;
    // the chip-exit opt-out resets once the grip context is left (rotation
    // back to portrait, or eject → next play session immerses again)
    if (scene3d.layoutMode !== 'grip' || fsm.state === 'OFF') scene3d.setGripSuppressed(false);
    if (!scene3d.gripMode && carts.drawerOpen) setGripDrawerOpen(false);
    if (scene3d.layoutMode !== 'grip') releaseLandscapeLock();
    gripHint.hidden = !(playing && portrait && scene3d.gripEligibleDevice && !gripHintDismissed);
    gripExit.hidden = !scene3d.gripMode;
    // grip view is played on the 3D buttons themselves — park the assist overlay
    document.getElementById('touch-zones')?.classList.toggle('grip-hidden', scene3d.gripMode);
  };
  fsm.onChange(syncGripUi);
  document.getElementById('grip-hint-close')!.addEventListener('click', () => {
    gripHintDismissed = true;
    syncGripUi();
  });
  gripExit.addEventListener('click', () => {
    scene3d.setGripSuppressed(true);
    setGripDrawerOpen(false);
    releaseLandscapeLock();
    syncGripUi();
  });

  scene3d.onLayout = (mode) => {
    carts.setLayout(mode);
    syncGripUi();
  };
  syncGripUi();

  // ---------- ROM import ----------

  const importFile = async (file: File, slotId: string): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const v = validateRom(bytes, file.name);
    if (!v.ok) {
      overlay.toast(v.reason ?? 'Invalid ROM file');
      sfx.errorBuzz();
      return;
    }
    const hash = await hashRom(bytes);
    const title = v.header?.title || file.name.replace(/\.gba$/i, '').slice(0, 16);
    // hash-derived low-saturation accent
    const hue = parseInt(hash.slice(0, 2), 16) / 255;
    const accent = hslToHex(hue, 0.32, 0.52);
    carts.setUploadedCart(slotId, {
      title,
      subtitle: 'Your ROM · local only',
      accent,
      variant: 'imported',
      romBytes: bytes,
      hash,
    });
    await store.putRom({ hash, name: file.name, title, accent, bytes, addedAt: Date.now() });
    const slots = (await store.getConfig<Record<string, string>>('uploadSlots')) ?? {};
    const oldHash = slots[slotId];
    slots[slotId] = hash;
    await store.putConfig('uploadSlots', slots);
    // the slot's previous ROM is evicted once nothing references it
    if (oldHash && oldHash !== hash && !Object.values(slots).includes(oldHash)) {
      void store.deleteRom(oldHash);
    }
    overlay.toast(`Imported ${title} — drag it into the slot`);
    renderCartsPanel(); // keep the slots panel in sync when it is open
  };

  const fileInput = document.getElementById('rom-file') as HTMLInputElement;
  let pendingUploadSlot: string | null = null;
  carts.onBlankActivate = (cartId) => {
    pendingUploadSlot = cartId;
    fileInput.click();
  };
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file && pendingUploadSlot) void importFile(file, pendingUploadSlot);
    fileInput.value = '';
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const ndc = scene3d.ndcFromClient(e.clientX, e.clientY);
    if (carts.isOverPouch(ndc)) {
      // first blank upload slot wins; both loaded → replace slot 1
      const blank = UPLOAD_SLOTS.find((id) => carts.getCart(id)?.isBlank);
      void importFile(file, blank ?? UPLOAD_SLOTS[0]);
    } else overlay.toast('Drop .gba files onto the cartridge pouch');
  });

  // ---------- save states (manual snapshots) ----------

  const btnStateSave = document.getElementById('btn-state-save') as HTMLButtonElement;
  const btnStateLoad = document.getElementById('btn-state-load') as HTMLButtonElement;
  const syncStateButtons = (): void => {
    const playing = fsm.state === 'PLAYING';
    btnStateSave.disabled = !playing;
    btnStateLoad.disabled = !playing;
  };
  fsm.onChange(syncStateButtons);
  syncStateButtons();

  const saveStateFlow = async (): Promise<void> => {
    if (fsm.state !== 'PLAYING' || !adapter || !currentHash) return;
    const state = await adapter.saveStateSnapshot();
    if (state) {
      await store.putState(currentHash, state);
      overlay.toast('State saved');
    } else {
      overlay.toast('Save states are not supported for this game');
    }
  };

  const loadStateFlow = async (): Promise<void> => {
    if (fsm.state !== 'PLAYING' || !adapter || !currentHash) return;
    const state = await store.getState(currentHash);
    if (!state) {
      overlay.toast('No saved state for this game');
      return;
    }
    const ok = await adapter.loadStateSnapshot(state);
    overlay.toast(ok ? 'State loaded' : 'The core rejected this save state');
  };
  btnStateSave.addEventListener('click', () => void saveStateFlow());
  btnStateLoad.addEventListener('click', () => void loadStateFlow());

  // ---------- cartridge slots panel ----------

  const dlgCarts = document.getElementById('dlg-carts') as HTMLDialogElement;
  const renderCartsPanel = (): void => {
    for (const slotId of UPLOAD_SLOTS) {
      const cart = carts.getCart(slotId);
      const blank = !cart || cart.isBlank === true;
      const titleEl = document.getElementById(`cart-title-${slotId}`)!;
      titleEl.textContent = blank ? 'LOAD YOUR ROM' : cart.title;
      titleEl.classList.toggle('blank', blank);
      (document.getElementById(`cart-clear-${slotId}`) as HTMLButtonElement).disabled =
        blank || carts.insertedCart?.id === slotId;
    }
  };

  const clearUploadSlot = async (slotId: string): Promise<void> => {
    if (carts.insertedCart?.id === slotId) {
      overlay.toast('Eject the cartridge from the console first');
      return;
    }
    const cart = carts.getCart(slotId);
    if (!cart || cart.isBlank) return;
    carts.clearUploadedCart(slotId);
    const slots = (await store.getConfig<Record<string, string>>('uploadSlots')) ?? {};
    const oldHash = slots[slotId];
    delete slots[slotId];
    await store.putConfig('uploadSlots', slots);
    // evict the ROM bytes once nothing references the hash
    if (oldHash && !Object.values(slots).includes(oldHash)) void store.deleteRom(oldHash);
    renderCartsPanel();
    overlay.toast('Slot cleared');
  };

  document.getElementById('btn-carts')!.addEventListener('click', () => {
    renderCartsPanel();
    dlgCarts.showModal();
  });
  document.getElementById('btn-carts-close')!.addEventListener('click', () => dlgCarts.close());
  for (const slotId of UPLOAD_SLOTS) {
    document.getElementById(`cart-choose-${slotId}`)!.addEventListener('click', () => {
      pendingUploadSlot = slotId;
      fileInput.click();
    });
    document.getElementById(`cart-clear-${slotId}`)!.addEventListener('click', () => void clearUploadSlot(slotId));
  }

  // ---------- pointer orchestration (3D buttons + carts) ----------

  const activeButtons = new Map<number, { button: GBAButton; source: string }>();
  let blankDown: { x: number; y: number; id: string } | null = null;
  let cartPointer: number | null = null;
  // grip drawer swipe: armed on unclaimed pointerdowns inside the grip view
  let edgeSwipe: { id: number; x0: number; y0: number; t0: number; fromEdge: boolean } | null = null;

  const dpadDirection = (worldPoint: THREE.Vector3): GBAButton | null => {
    const local = scene3d.handheld.group.worldToLocal(worldPoint.clone());
    const c = scene3d.handheld.dpadCenter;
    // Upright display pose: the D-pad face lies in the XY plane (up = +Y).
    const dx = local.x - c.x;
    const dy = local.y - c.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 3) return null;
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'LEFT' : 'RIGHT';
    return dy > 0 ? 'UP' : 'DOWN';
  };

  canvas.addEventListener('pointerdown', (e) => {
    sfx.unlock();
    pokeGripDrawer(); // interacting with the open drawer holds the auto-close
    void ensureAdapter().catch(() => undefined); // warm the core on first gesture
    const ndc = scene3d.ndcFromClient(e.clientX, e.clientY);

    const cart = carts.pickCart(ndc);
    if (cart) {
      if (cart.isBlank) {
        blankDown = { x: e.clientX, y: e.clientY, id: cart.id };
        return;
      }
      const inserted = carts.insertedCart === cart;
      const canDrag = (inserted && fsm.state === 'PLAYING') || (!inserted && fsm.state === 'OFF');
      if (canDrag && carts.beginDrag(cart, ndc)) {
        cartPointer = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    const hits = scene3d.raycast(ndc, scene3d.handheld.buttonHitMeshes);
    if (hits.length > 0) {
      const obj = hits[0].object;
      let button: GBAButton | null = null;
      if (obj.userData.kind === 'dpad') button = dpadDirection(hits[0].point);
      else if (obj.userData.kind === 'button') button = obj.userData.button as GBAButton;
      if (button) {
        const source = `ptr:${e.pointerId}`;
        input.pressSource(source, button);
        activeButtons.set(e.pointerId, { button, source });
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    // nothing claimed the pointer: in the grip view this may be the start of
    // a drawer swipe (leftward from the right screen edge, or a quick flick)
    if (scene3d.gripMode) {
      edgeSwipe = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        t0: performance.now(),
        fromEdge: e.clientX >= window.innerWidth - 24,
      };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const ndc = scene3d.ndcFromClient(e.clientX, e.clientY);
    if (cartPointer === e.pointerId) {
      carts.dragMove(ndc);
      return;
    }
    if (edgeSwipe && edgeSwipe.id === e.pointerId) {
      const dx = e.clientX - edgeSwipe.x0;
      const dy = e.clientY - edgeSwipe.y0;
      // leftward drag from the right screen edge summons the cart drawer;
      // while the drawer is open any rightward drag slides it back out
      if (!carts.drawerOpen && edgeSwipe.fromEdge && dx <= -48 && Math.abs(dy) < 90) {
        setGripDrawerOpen(true);
        edgeSwipe = null;
      } else if (carts.drawerOpen && dx >= 48 && Math.abs(dy) < 90) {
        setGripDrawerOpen(false);
        edgeSwipe = null;
      }
      return;
    }
    const ab = activeButtons.get(e.pointerId);
    if (ab) {
      // Sliding off a physical button releases it. Rolling a thumb across the
      // D-pad changes direction; sliding onto a *different* button releases.
      const DIRECTIONS: GBAButton[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
      const hits = scene3d.raycast(ndc, scene3d.handheld.buttonHitMeshes);
      let under: GBAButton | null = null;
      if (hits.length > 0) {
        const obj = hits[0].object;
        if (obj.userData.kind === 'dpad') under = dpadDirection(hits[0].point);
        else if (obj.userData.kind === 'button') under = obj.userData.button as GBAButton;
      }
      if (under === null) {
        input.releaseSource(ab.source, ab.button);
        activeButtons.delete(e.pointerId);
        return;
      }
      if (under !== ab.button) {
        const rollingDpad = DIRECTIONS.includes(ab.button) && DIRECTIONS.includes(under);
        if (rollingDpad) {
          input.releaseSource(ab.source, ab.button);
          input.pressSource(ab.source, under);
          activeButtons.set(e.pointerId, { button: under, source: ab.source });
        } else {
          input.releaseSource(ab.source, ab.button);
          activeButtons.delete(e.pointerId);
        }
      }
      return;
    }
    carts.updateHover(ndc);
  });

  const endPointer = (e: PointerEvent): void => {
    if (blankDown) {
      const moved = Math.hypot(e.clientX - blankDown.x, e.clientY - blankDown.y);
      const id = blankDown.id;
      blankDown = null;
      if (moved < 6) carts.onBlankActivate?.(id);
      return;
    }
    if (cartPointer === e.pointerId) {
      cartPointer = null;
      carts.endDrag();
      return;
    }
    if (edgeSwipe && edgeSwipe.id === e.pointerId) {
      const dx = e.clientX - edgeSwipe.x0;
      const dy = e.clientY - edgeSwipe.y0;
      const dt = performance.now() - edgeSwipe.t0;
      // quick horizontal flick anywhere in the grip view toggles the drawer
      if (dt < 320 && Math.abs(dx) >= 90 && Math.abs(dx) >= 2 * Math.abs(dy)) {
        setGripDrawerOpen(dx < 0);
      }
      edgeSwipe = null;
      return;
    }
    const ab = activeButtons.get(e.pointerId);
    if (ab) {
      input.releaseSource(ab.source, ab.button);
      activeButtons.delete(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // ---------- audio / sfx routing from the single input source ----------

  input.onEdge((button, pressed) => {
    switch (button) {
      case 'A':
      case 'B':
        pressed ? sfx.abPress() : sfx.abRelease();
        break;
      case 'L':
      case 'R':
        pressed ? sfx.shoulderPress() : sfx.shoulderRelease();
        break;
      case 'START':
      case 'SELECT':
        pressed ? sfx.rubberPress() : sfx.rubberRelease();
        break;
      default:
        pressed ? sfx.dpadPress() : sfx.dpadRelease();
    }
  });

  // ---------- page visibility ----------

  let autoPaused = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (fsm.state === 'PLAYING' && adapter) {
        adapter.pause();
        autoPaused = true;
      }
      sfx.suspend();
    } else {
      sfx.resume();
      if (autoPaused && adapter) {
        adapter.resume();
        autoPaused = false;
      }
    }
  });

  window.addEventListener('pagehide', () => {
    if (adapter && fsm.state === 'PLAYING') void flushSramOnly();
  });

  // ---------- render loop ----------

  let last = performance.now();
  let frame = 0;
  const loop = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame++;
    input.tickFrame(frame);
    if (adapter && fsm.state === 'PLAYING') {
      adapter.tickFrame(frame);
      adapter.syncButtons(input.state);
    }
    carts.update(dt);
    scene3d.render(dt, input.state);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // ---------- debug / test hooks ----------

  (window as unknown as Record<string, unknown>).__GBA = {
    fsm,
    input,
    scene3d,
    carts,
    store,
    stateName: () => fsm.state,
    lastError: () => lastError,
    getAdapter: () => adapter,
    insertById: (id: string): void => {
      const c = carts.getCart(id);
      if (c) void insertFlow(c);
    },
    eject: (): void => void ejectFlow(),
    importBytes: async (bytes: Uint8Array, name: string, slot = 'upload-1'): Promise<boolean> => {
      const v = validateRom(bytes, name);
      if (!v.ok) return false;
      await importFile(new File([bytes.slice().buffer], name), slot);
      return true;
    },
    cartScreenPos: (id: string): { x: number; y: number } | null => {
      const grp = carts.getCartGroup(id);
      if (!grp) return null;
      const p = grp.getWorldPosition(new THREE.Vector3());
      const s = scene3d.projectToScreen(p);
      return { x: s.x, y: s.y };
    },
    slotScreenPos: (): { x: number; y: number } => {
      const s = scene3d.projectToScreen(SLOT_APPROACH_POS.clone());
      return { x: s.x, y: s.y };
    },
    /** Device bounding box projected to CSS px (full-bleed grip assertion). */
    deviceScreenBounds: (): { minX: number; maxX: number; minY: number; maxY: number } => {
      const box = new THREE.Box3().setFromObject(scene3d.handheld.deviceGroup);
      const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const s = scene3d.projectToScreen(new THREE.Vector3(x, y, z));
            out.minX = Math.min(out.minX, s.x);
            out.maxX = Math.max(out.maxX, s.x);
            out.minY = Math.min(out.minY, s.y);
            out.maxY = Math.max(out.maxY, s.y);
          }
        }
      }
      return out;
    },
    /** World distance (mm) from a cart to the slot approach pose (magnetic-snap probe). */
    cartDistToSlot: (id: string): number | null => {
      const grp = carts.getCartGroup(id);
      return grp ? grp.position.distanceTo(SLOT_APPROACH_POS) : null;
    },
    buttonScreenPos: (name: string): { x: number; y: number } | null => {
      const p = scene3d.handheld.getButtonWorldPos(name);
      if (!p) return null;
      const s = scene3d.projectToScreen(p);
      return { x: s.x, y: s.y };
    },
    screenSample: (): { changed: boolean; unique: number } => {
      // The core's canvas holds a WebGL2 context — read via drawImage copy.
      const tmp = document.createElement('canvas');
      tmp.width = 240;
      tmp.height = 160;
      const ctx = tmp.getContext('2d');
      if (!ctx) return { changed: false, unique: 0 };
      ctx.drawImage(emuCanvas, 0, 0, 240, 160);
      const data = ctx.getImageData(0, 0, 240, 160).data;
      const set = new Set<number>();
      for (let i = 0; i < data.length; i += 400) {
        set.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
      return { changed: set.size > 4, unique: set.size };
    },
  };
}

function wrapError(message: string): string[] {
  const words = message.split(' ');
  const lines: string[] = ['ERROR'];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).length > 34) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

void boot().catch((err) => {
  console.error('Fatal boot error', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;left:8px;bottom:24px;color:#a33;font:11px monospace;z-index:99;max-width:90vw;white-space:pre-wrap">Boot failed: ${String(err)}</pre>`,
  );
});
