import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DISPLAY_LEAN, SLOT_ANCHOR_POS, SLOT_APPROACH_POS } from './HandheldModel';
import { cartridgeLabelTexture, plasticBumpTexture, type LabelSpec } from './textures';
import { easeInOutCubic, easeOutCubic, lerp, Spring } from './spring';
import type { LayoutMode, Scene3D } from './Scene3D';

/**
 * CartridgeManager — the cartridge pouch is the ROM selector, in 3D.
 * Carts are individual meshes (shell, thumb grip, label paper, gold contacts,
 * light wear), standing in the pouch's 2×2 grid. Drag uses raycast + drag
 * plane with magnetic correction near the slot; insert is a 4-phase
 * mechanical animation; eject reverses it with a spring-release pop.
 */

export interface CartDef {
  id: string;
  title: string;
  subtitle: string;
  accent: number;
  variant: LabelSpec['variant'];
  romUrl?: string;
  romBytes?: Uint8Array;
  hash?: string;
  isBlank?: boolean;
}

const CART_W = 57.4;
const CART_H = 35.6;
const CART_D = 7.9;

// Cart homes: 2×2 grid inside the pouch (pouch-local mm). Carts stand
// upright, sunk ~10mm into the base, labels leaning back toward the player.
// Bundled carts take the FRONT row first so their bodies are never occluded
// by a neighbor when ray-picked from the hero camera.
const POUCH_SLOTS = [
  new THREE.Vector3(-31, 11, 13), // front-left  — cascade7
  new THREE.Vector3(31, 11, 13), // front-right — gbarcade
  new THREE.Vector3(-31, 11, -13), // back-left   — upload-1
  new THREE.Vector3(31, 11, -13), // back-right  — upload-2
];
const SLOT_LEAN = -0.2;

export const BUNDLED_CARTS: CartDef[] = [
  {
    id: 'cascade7',
    title: 'CASCADE7',
    subtitle: 'Puzzle · ← → A · L/R · Start',
    accent: 0x6f8f7a,
    variant: 'cascade',
    romUrl: 'roms/CASCADE7.gba',
  },
  {
    id: 'gbarcade',
    title: 'GBARCADE',
    subtitle: '6-in-1 arcade · menus · sound',
    accent: 0x8d7fb0,
    variant: 'arcade',
    romUrl: 'roms/gbarcade_v0.1.4.gba',
  },
];

/** The two upload slots: independent blanks until a ROM is loaded into them. */
export const UPLOAD_SLOTS = ['upload-1', 'upload-2'] as const;
export type UploadSlotId = (typeof UPLOAD_SLOTS)[number];

const uploadBlankDef = (id: string): CartDef => ({
  id,
  title: 'LOAD YOUR ROM',
  subtitle: 'click · or drop a .gba file',
  accent: 0x9a958a,
  variant: 'blank',
  isBlank: true,
});

interface Tween {
  t: number;
  dur: number;
  fn: (k: number) => void;
  done: () => void;
}

export class CartridgeManager {
  readonly group = new THREE.Group(); // pouch + loose carts live here
  readonly carts: CartDef[] = [];

  private scene3d: Scene3D;
  private pouchGroup = new THREE.Group();
  private pouchGoal = { pos: new THREE.Vector3(), rotY: 0 };
  private cartGroups = new Map<string, THREE.Group>();
  private cartHome = new Map<string, { local: THREE.Vector3; rotX: number }>();
  private hitMeshes: THREE.Object3D[] = [];
  private pouchHitMeshes: THREE.Object3D[] = [];

  private drag: {
    cart: CartDef;
    fromInserted: boolean;
    plane: THREE.Plane;
    lift: number;
    grabOffset: THREE.Vector3;
    pointerY0: number;
    ndcY0: number; // drag start in NDC — grip mode measures the eject drag in px
  } | null = null;

  private hoverId: string | null = null;
  private hoverLift = new Map<string, Spring>();
  private tweens: Tween[] = [];
  private tooltip: HTMLDivElement;

  onInsertRequest: ((cart: CartDef) => void) | null = null;
  onEjectRequest: ((cart: CartDef) => void) | null = null;
  /** Fires with the upload slot id when its blank cart is clicked. */
  onBlankActivate: ((cartId: string) => void) | null = null;
  onHoverSound: (() => void) | null = null;
  /** Fires when a drag gets near/far from the slot — drives camera push-in. */
  onDragFocus: ((on: boolean) => void) | null = null;

  constructor(scene3d: Scene3D) {
    this.scene3d = scene3d;
    this.group.name = 'cartridges';
    this.buildPouch();
    this.group.add(this.pouchGroup);
    scene3d.scene.add(this.group); // without this the pouch/carts never render or raycast

    this.setLayout(scene3d.layoutMode); // initial layout may already be portrait
    for (const def of BUNDLED_CARTS) this.addCart(def);
    for (const id of UPLOAD_SLOTS) this.addCart(uploadBlankDef(id));

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'cart-tooltip';
    this.tooltip.style.opacity = '0';
    document.body.appendChild(this.tooltip);
  }

  // ---------- pouch ----------

  private buildPouch(): void {
    const fabricBump = plasticBumpTexture();
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x2c2d31,
      roughness: 0.88,
      bumpMap: fabricBump,
      bumpScale: 0.05,
    });
    const liningMat = new THREE.MeshStandardMaterial({
      color: 0x3d3e44,
      roughness: 0.96,
      bumpMap: fabricBump,
      bumpScale: 0.09,
    });
    const zipMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.6, metalness: 0.3 });

    const base = new THREE.Mesh(new RoundedBoxGeometry(140, 16, 64, 4, 8), shellMat);
    base.castShadow = true;
    base.receiveShadow = true;
    base.userData = { kind: 'pouch' };
    this.pouchGroup.add(base);
    this.pouchHitMeshes.push(base);

    const lining = new THREE.Mesh(new THREE.BoxGeometry(132, 3, 56), liningMat);
    lining.position.y = 6.5;
    lining.receiveShadow = true;
    this.pouchGroup.add(lining);

    // slot dividers (2×2 grid)
    const divX = new THREE.Mesh(new THREE.BoxGeometry(2, 7, 54), liningMat);
    divX.position.set(0, 6.5, 0);
    this.pouchGroup.add(divX);
    const divZ = new THREE.Mesh(new THREE.BoxGeometry(126, 7, 2), liningMat);
    divZ.position.set(0, 6.5, 0);
    this.pouchGroup.add(divZ);

    // lid, hinged at the back edge, half open (~58°)
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 8, -32);
    lidPivot.rotation.x = -1.0;
    const lid = new THREE.Mesh(new RoundedBoxGeometry(140, 7, 64, 4, 8), shellMat);
    lid.position.set(0, 0, 32);
    lid.castShadow = true;
    lid.userData = { kind: 'pouch' };
    lidPivot.add(lid);
    const lidLining = new THREE.Mesh(new THREE.BoxGeometry(132, 2, 56), liningMat);
    lidLining.position.set(0, -4.2, 32);
    lidPivot.add(lidLining);
    this.pouchGroup.add(lidPivot);
    this.pouchHitMeshes.push(lid);

    // zipper teeth along the base rim (front + sides), merged
    const teeth: THREE.BufferGeometry[] = [];
    const addTooth = (x: number, z: number, ry: number): void => {
      const g = new THREE.BoxGeometry(2.2, 2, 1.4);
      g.rotateY(ry);
      g.translate(x, 9, z);
      teeth.push(g);
    };
    for (let x = -62; x <= 62; x += 4) addTooth(x, 31, 0);
    for (let z = -26; z <= 28; z += 4) {
      addTooth(-69, z, Math.PI / 2);
      addTooth(69, z, Math.PI / 2);
    }
    this.pouchGroup.add(new THREE.Mesh(mergeGeometries(teeth)!, zipMat));

    // zipper pull
    const pull = new THREE.Mesh(new RoundedBoxGeometry(8, 3, 5, 2, 1.2), zipMat);
    pull.position.set(-60, 9.5, 33);
    this.pouchGroup.add(pull);

    this.pouchGroup.position.y = -36.0;
  }

  setLayout(mode: LayoutMode): void {
    if (mode === 'grip' && this.scene3d.gripMode) {
      // immersive grip view: the pouch (and every cart at home) parks far
      // below the framed device — the inserted cart is unaffected
      this.pouchGoal.pos.set(0, -220, -60);
      this.pouchGoal.rotY = 0;
    } else if (mode === 'portrait') {
      this.pouchGoal.pos.set(0, -36.0, 134);
      this.pouchGoal.rotY = 0;
    } else {
      this.pouchGoal.pos.set(160, -36.0, 6);
      this.pouchGoal.rotY = -0.12;
    }
    // Snap the pouch on layout change: under software rendering the render
    // loop runs at a few fps and an eased move would take many wall-seconds.
    this.pouchGroup.position.copy(this.pouchGoal.pos);
    this.pouchGroup.rotation.y = this.pouchGoal.rotY;
    // carts at home follow the pouch
    for (const def of this.carts) {
      const grp = this.cartGroups.get(def.id);
      const home = this.cartHome.get(def.id);
      if (!grp || !home || grp.userData.inserted || this.drag?.cart.id === def.id) continue;
      grp.position.copy(this.homeWorld(home.local));
      grp.rotation.set(home.rotX, this.pouchGoal.rotY, 0);
    }
  }

  /** Pouch-local → scene position under the current layout. */
  private homeWorld(local: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.pouchGoal.rotY);
    const s = Math.sin(this.pouchGoal.rotY);
    return new THREE.Vector3(
      this.pouchGoal.pos.x + local.x * c + local.z * s,
      this.pouchGoal.pos.y + local.y,
      this.pouchGoal.pos.z - local.x * s + local.z * c,
    );
  }

  // ---------- carts ----------

  addCart(def: CartDef, homeIndex?: number): void {
    const grp = new THREE.Group();
    grp.name = `cart-${def.id}`;

    const bump = plasticBumpTexture();
    const shellMat = new THREE.MeshStandardMaterial({
      color: def.isBlank ? 0x9a958a : 0xb6b4ac,
      roughness: 0.78,
      bumpMap: bump,
      bumpScale: 0.03,
    });
    const body = new THREE.Mesh(new RoundedBoxGeometry(CART_W, CART_H, CART_D, 3, 2.2), shellMat);
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData = { kind: 'cart', id: def.id };
    grp.add(body);

    // thumb-grip ridges on the top edge
    for (const gx of [-16, 16]) {
      const grip = new THREE.Mesh(new RoundedBoxGeometry(10, 2.4, 2, 2, 0.8), shellMat);
      grip.position.set(gx, CART_H / 2 - 1.2, CART_D / 2 - 0.6);
      grp.add(grip);
    }
    // back recessed panel line
    const backPanel = new THREE.Mesh(
      new THREE.BoxGeometry(CART_W - 8, CART_H - 10, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x9c9a92, roughness: 0.85 }),
    );
    backPanel.position.set(0, 0, -CART_D / 2 + 0.1);
    grp.add(backPanel);

    // label
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 29.5),
      new THREE.MeshStandardMaterial({
        map: cartridgeLabelTexture({
          title: def.title,
          subtitle: def.subtitle.split('·')[0]?.trim(),
          accent: def.accent,
          variant: def.variant,
        }),
        roughness: 0.92,
      }),
    );
    label.position.set(0, 1, CART_D / 2 + 0.06);
    grp.add(label);

    // gold contacts on the bottom edge
    const contactGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const g = new THREE.BoxGeometry(5.4, 3.2, 0.8);
      g.translate(-16.5 + i * 6.6, -CART_H / 2 + 0.4, 1.6);
      contactGeos.push(g);
    }
    grp.add(
      new THREE.Mesh(
        mergeGeometries(contactGeos)!,
        new THREE.MeshStandardMaterial({ color: 0xc9a23f, metalness: 0.85, roughness: 0.38 }),
      ),
    );

    const idx = homeIndex ?? this.carts.length;
    const local = POUCH_SLOTS[Math.min(idx, POUCH_SLOTS.length - 1)].clone();
    grp.position.copy(this.homeWorld(local));
    grp.rotation.set(SLOT_LEAN, this.pouchGoal.rotY, 0);
    this.group.add(grp);

    this.carts.push(def);
    this.cartGroups.set(def.id, grp);
    this.cartHome.set(def.id, { local, rotX: SLOT_LEAN });
    this.hitMeshes.push(body);
    this.hoverLift.set(def.id, new Spring(22, 0.8));
  }

  /** Load a ROM into an upload slot — the cart keeps the slot's id and cell. */
  setUploadedCart(slotId: string, def: Omit<CartDef, 'id'>): void {
    const slotIdx = UPLOAD_SLOTS.indexOf(slotId as UploadSlotId);
    if (slotIdx < 0) {
      console.warn(`[carts] unknown upload slot "${slotId}"`);
      return;
    }
    const existing = this.cartGroups.get(slotId);
    if (existing) {
      this.group.remove(existing);
      this.hitMeshes = this.hitMeshes.filter((m) => m.userData.id !== slotId);
      this.carts.splice(this.carts.indexOf(this.carts.find((c) => c.id === slotId)!), 1);
      this.cartGroups.delete(slotId);
      this.cartHome.delete(slotId);
      this.hoverLift.delete(slotId);
    }
    this.addCart({ ...def, id: slotId }, 2 + slotIdx);
  }

  /** Reset an upload slot back to its blank cart (same cell, blank label). */
  clearUploadedCart(slotId: string): void {
    const blank: CartDef = uploadBlankDef(slotId);
    this.setUploadedCart(slotId, blank);
  }

  getCart(id: string): CartDef | undefined {
    return this.carts.find((c) => c.id === id);
  }

  /** Debug/test: the THREE.Group of a cart. */
  getCartGroup(id: string): THREE.Group | undefined {
    return this.cartGroups.get(id);
  }

  get insertedCart(): CartDef | null {
    for (const c of this.carts) {
      const g = this.cartGroups.get(c.id);
      if (g && g.userData.inserted) return c;
    }
    return null;
  }

  // ---------- picking ----------

  pickCart(ndc: THREE.Vector2): CartDef | null {
    const hits = this.scene3d.raycast(ndc, this.hitMeshes, false);
    if (hits.length === 0) return null;
    const id = hits[0].object.userData.id as string;
    return this.getCart(id) ?? null;
  }

  isOverPouch(ndc: THREE.Vector2): boolean {
    return this.scene3d.raycast(ndc, this.pouchHitMeshes, false).length > 0;
  }

  // ---------- hover ----------

  updateHover(ndc: THREE.Vector2 | null): void {
    const cart = ndc && !this.drag ? this.pickCart(ndc) : null;
    const id = cart?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      if (id) this.onHoverSound?.();
    }
    if (cart) {
      this.tooltip.textContent = `${cart.title} · ${cart.subtitle}`;
      this.tooltip.style.opacity = '1';
      const grp = this.cartGroups.get(cart.id)!;
      const p = grp.position.clone();
      p.y += 26;
      this.group.localToWorld(p);
      const s = this.scene3d.projectToScreen(p);
      this.tooltip.style.left = `${s.x}px`;
      this.tooltip.style.top = `${s.y}px`;
    } else {
      this.tooltip.style.opacity = '0';
    }
    this.scene3d.canvas.style.cursor = cart ? 'grab' : 'default';
  }

  // ---------- drag ----------

  /** Returns false when the cart can't be dragged right now. */
  beginDrag(cart: CartDef, ndc: THREE.Vector2): boolean {
    if (this.drag) return false;
    if (cart.isBlank) return false;
    const grp = this.cartGroups.get(cart.id)!;
    const fromInserted = !!grp.userData.inserted;

    // cancel any tween running on this cart
    this.tweens = this.tweens.filter((t) => {
      (t as Tween & { cartId?: string }).cartId === cart.id ? t.done() : undefined;
      return (t as Tween & { cartId?: string }).cartId !== cart.id;
    });

    const worldPos = new THREE.Vector3();
    grp.getWorldPosition(worldPos);

    if (fromInserted) {
      // vertical extraction: drag on a plane facing the camera through the slot
      const n = new THREE.Vector3(0, 0, 1);
      const plane = new THREE.Plane(n, -SLOT_ANCHOR_POS.z);
      this.drag = {
        cart,
        fromInserted: true,
        plane,
        lift: 0,
        grabOffset: new THREE.Vector3(),
        pointerY0: worldPos.y,
        ndcY0: ndc.y,
      };
    } else {
      // Camera-facing drag plane through the cart: screen-space drags map 1:1
      // even while the camera pushes in, so the magnetic snap can be reached.
      // (A fixed horizontal plane breaks here: the grab offset measured against
      // a plane far above the cart lands the cart ~50mm behind the slot once
      // the camera moves.)
      const n = this.scene3d.camera.getWorldDirection(new THREE.Vector3()).negate();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, worldPos);
      const hit = this.rayPlane(ndc, plane);
      const grabOffset = hit ? worldPos.clone().sub(hit) : new THREE.Vector3();
      this.drag = { cart, fromInserted: false, plane, lift: 0, grabOffset, pointerY0: 0, ndcY0: ndc.y };
      this.scene3d.canvas.style.cursor = 'grabbing';
      this.onDragFocus?.(true);
    }
    return true;
  }

  private rayPlane(ndc: THREE.Vector2, plane: THREE.Plane): THREE.Vector3 | null {
    this.scene3d.raycaster.setFromCamera(ndc, this.scene3d.camera);
    const hit = new THREE.Vector3();
    return this.scene3d.raycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }

  dragMove(ndc: THREE.Vector2): void {
    if (!this.drag) return;
    const { cart, fromInserted } = this.drag;
    const grp = this.cartGroups.get(cart.id)!;

    if (fromInserted) {
      const hit = this.rayPlane(ndc, this.drag.plane);
      if (!hit) return;
      const y = Math.max(SLOT_ANCHOR_POS.y, hit.y);
      grp.position.set(0, y, SLOT_ANCHOR_POS.z);
      // Grip mode frames the face so tightly that the 26mm world threshold is
      // physically unreachable from the screen edge — a deliberate upward drag
      // measured in CSS px ejects instead. Desktop keeps the world threshold.
      // (NDC y grows upward: ndcFromClient maps clientY=0 → +1.)
      const upPx = ((ndc.y - this.drag.ndcY0) / 2) * window.innerHeight;
      if (y > SLOT_ANCHOR_POS.y + 26 || (this.scene3d.gripMode && upPx > 56)) {
        const c = this.drag.cart;
        this.endDragInternal();
        grp.userData.inserted = false;
        this.onEjectRequest?.(c);
      }
      return;
    }

    // re-aim the camera-facing plane at the cart each move (camera may be
    // easing during the drag push-in)
    const n = this.scene3d.camera.getWorldDirection(new THREE.Vector3()).negate();
    this.drag.plane.setFromNormalAndCoplanarPoint(n, grp.position);
    const hit = this.rayPlane(ndc, this.drag.plane);
    if (!hit) return;
    const target = hit.clone().add(this.drag.grabOffset);
    target.y = Math.max(target.y, 15); // don't sink into the face

    // magnetic correction near the slot approach pose
    const approach = SLOT_APPROACH_POS.clone();
    const dist = target.distanceTo(approach);
    const SNAP = 50;
    if (dist < SNAP) {
      const f = 1 - dist / SNAP; // 0..1
      const w = f * f * 0.92 + 0.08;
      target.lerp(approach, w);
    }

    // Screen-space depth assist. The camera-facing drag plane keeps the cart
    // at its home depth along the view axis, so in layouts where the pouch
    // sits far in front of the slot (portrait: z≈134 vs slot z≈−5.8 — a
    // ~130mm view-axis gap) the 3D snap radius and the 20mm insert threshold
    // are physically unreachable from a screen drag. When the view-axis gap
    // exceeds the world snap radius, blend the target toward the approach
    // pose by the pointer's screen distance to the slot projection (full
    // blend when the pointer sits on it). The cart otherwise moves inside
    // the drag plane, so the gap is layout-stable: on the desktop layout
    // (gap ≈12mm) this branch never runs and the world-space snap above is
    // bit-identical to before.
    const depthGap = Math.abs(this.drag.plane.distanceToPoint(approach));
    if (depthGap > SNAP) {
      const proj = SLOT_APPROACH_POS.clone().project(this.scene3d.camera);
      if (proj.z < 1) {
        const px = ((ndc.x - proj.x) / 2) * window.innerWidth;
        const py = ((ndc.y - proj.y) / 2) * window.innerHeight;
        const screenDist = Math.hypot(px, py);
        const SCREEN_SNAP = 120; // CSS px
        if (screenDist < SCREEN_SNAP) {
          const f = 1 - screenDist / SCREEN_SNAP; // 0..1
          const w = f * f * 0.94 + 0.06;
          target.lerp(approach, w);
        }
      }
    }

    grp.position.copy(target);
    // rotation always corrects toward the insertion orientation
    grp.rotation.x = lerp(grp.rotation.x, 0, 0.25);
    grp.rotation.y = lerp(grp.rotation.y, 0, 0.25);
    grp.rotation.z = lerp(grp.rotation.z, 0, 0.25);
  }

  /** Called on pointerup. Returns true when an insert was triggered. */
  endDrag(): boolean {
    if (!this.drag) return false;
    const { cart, fromInserted } = this.drag;
    const grp = this.cartGroups.get(cart.id)!;

    if (fromInserted) {
      this.endDragInternal();
      this.tweenCart(cart, 0.35, (k) => {
        grp.position.y = lerp(grp.position.y, SLOT_ANCHOR_POS.y, easeOutCubic(k));
      });
      return false;
    }

    const dist = grp.position.distanceTo(SLOT_APPROACH_POS);
    const hasRom = !!cart.romUrl || !!cart.romBytes;
    if (dist < 20 && hasRom) {
      this.endDragInternal();
      this.onInsertRequest?.(cart);
      return true;
    }
    // wrong spot → natural return to its slot
    this.endDragInternal();
    this.returnHome(cart);
    return false;
  }

  private endDragInternal(): void {
    this.drag = null;
    this.scene3d.canvas.style.cursor = 'default';
    this.onDragFocus?.(false);
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  // ---------- animations ----------

  private tweenCart(cart: CartDef, dur: number, fn: (k: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const t: Tween & { cartId?: string } = { t: 0, dur, fn, done: resolve, cartId: cart.id };
      this.tweens.push(t);
    });
  }

  /** 4-phase insert: align → enter rails → damped press → latch (~820ms). */
  insertSequence(cart: CartDef, onLatch: () => void): Promise<void> {
    const grp = this.cartGroups.get(cart.id)!;
    const startPos = grp.position.clone();
    const startRotX = grp.rotation.x;
    const mid = new THREE.Vector3(
      SLOT_ANCHOR_POS.x,
      (SLOT_APPROACH_POS.y + SLOT_ANCHOR_POS.y) / 2,
      SLOT_ANCHOR_POS.z,
    );

    return new Promise((resolve) => {
      this.tweens.push({
        t: 0,
        dur: 0.82,
        fn: (k) => {
          if (k < 0.22) {
            // align with the rails
            const q = easeInOutCubic(k / 0.22);
            grp.position.lerpVectors(startPos, SLOT_APPROACH_POS, q);
            grp.rotation.x = lerp(startRotX, DISPLAY_LEAN, q);
            grp.rotation.y = lerp(grp.rotation.y, 0, q);
            grp.rotation.z = lerp(grp.rotation.z, 0, q);
          } else if (k < 0.52) {
            // enter the guide rails
            const q = easeInOutCubic((k - 0.22) / 0.3);
            grp.position.lerpVectors(SLOT_APPROACH_POS, mid, q);
          } else if (k < 0.85) {
            // damped press down, slight overshoot
            const q = easeOutCubic((k - 0.52) / 0.33);
            const overshoot = Math.sin(q * Math.PI) * 1.2;
            grp.position.lerpVectors(mid, SLOT_ANCHOR_POS, q);
            grp.position.y -= overshoot;
          } else {
            // latch settle
            const q = (k - 0.85) / 0.15;
            grp.position.copy(SLOT_ANCHOR_POS);
            grp.position.y += Math.sin(q * Math.PI) * 0.9;
            if (q >= 0.45 && !grp.userData.latched) {
              grp.userData.latched = true;
              onLatch();
            }
          }
        },
        done: () => {
          grp.position.copy(SLOT_ANCHOR_POS);
          grp.rotation.set(DISPLAY_LEAN, 0, 0);
          grp.userData.inserted = true;
          grp.userData.latched = false;
          resolve();
        },
      });
    });
  }

  /** Eject: spring-release pop, rise, arc home (~900ms). */
  ejectSequence(cart: CartDef): Promise<void> {
    const grp = this.cartGroups.get(cart.id)!;
    grp.userData.inserted = false;
    const home = this.cartHome.get(cart.id)!;
    const homePos = this.homeWorld(home.local);
    const start = grp.position.clone(); // user may have dragged it partway out
    const pop = start.clone().add(new THREE.Vector3(0, 8, 0));
    const high = SLOT_APPROACH_POS.clone().add(new THREE.Vector3(0, 10, 0));

    return new Promise((resolve) => {
      this.tweens.push({
        t: 0,
        dur: 0.9,
        fn: (k) => {
          if (k < 0.16) {
            const q = easeOutCubic(k / 0.16);
            grp.position.lerpVectors(start, pop, q);
          } else if (k < 0.5) {
            const q = easeInOutCubic((k - 0.16) / 0.34);
            grp.position.lerpVectors(pop, high, q);
          } else {
            const q = easeInOutCubic((k - 0.5) / 0.5);
            const pos = new THREE.Vector3().lerpVectors(high, homePos, q);
            pos.y += Math.sin(q * Math.PI) * 12; // gentle arc
            grp.position.copy(pos);
            grp.rotation.x = lerp(DISPLAY_LEAN, home.rotX, q);
            grp.rotation.y = lerp(0, this.pouchGoal.rotY, q);
          }
        },
        done: () => {
          grp.position.copy(homePos);
          grp.rotation.set(home.rotX, this.pouchGoal.rotY, 0);
          resolve();
        },
      });
    });
  }

  returnHome(cart: CartDef): Promise<void> {
    const grp = this.cartGroups.get(cart.id)!;
    const home = this.cartHome.get(cart.id)!;
    const homePos = this.homeWorld(home.local);
    const startPos = grp.position.clone();
    const startRotX = grp.rotation.x;
    const startRotY = grp.rotation.y;
    // Keep it quick: the e2e wrong-drop check sleeps 900ms, and under software
    // rendering (dt clamped to 50ms) a longer tween may not have settled.
    return this.tweenCart(cart, 0.3, (k) => {
      const q = easeOutCubic(k);
      const pos = new THREE.Vector3().lerpVectors(startPos, homePos, q);
      pos.y += Math.sin(q * Math.PI) * 6;
      grp.position.copy(pos);
      grp.rotation.x = lerp(startRotX, home.rotX, q);
      grp.rotation.y = lerp(startRotY, this.pouchGoal.rotY, q);
      grp.rotation.z = lerp(grp.rotation.z, 0, q);
    });
  }

  /** Debug/test helper: jump a cart straight to the inserted pose. */
  snapInserted(cart: CartDef): void {
    const grp = this.cartGroups.get(cart.id)!;
    grp.position.copy(SLOT_ANCHOR_POS);
    grp.rotation.set(DISPLAY_LEAN, 0, 0);
    grp.userData.inserted = true;
  }

  // ---------- frame ----------

  update(dt: number): void {
    // pouch layout easing
    this.pouchGroup.position.lerp(this.pouchGoal.pos, 1 - Math.exp(-dt * 6));
    this.pouchGroup.rotation.y = lerp(this.pouchGroup.rotation.y, this.pouchGoal.rotY, 1 - Math.exp(-dt * 6));

    // hover lift
    for (const [id, spring] of this.hoverLift) {
      const grp = this.cartGroups.get(id);
      if (!grp || grp.userData.inserted || this.drag?.cart.id === id) continue;
      spring.target = this.hoverId === id ? 1 : 0;
      spring.update(dt);
      const home = this.cartHome.get(id);
      if (home && this.tweens.every((t) => (t as Tween & { cartId?: string }).cartId !== id)) {
        grp.position.y = this.homeWorld(home.local).y + spring.value * 3;
      }
    }

    // tweens
    this.tweens = this.tweens.filter((tw) => {
      tw.t += dt / tw.dur;
      if (tw.t >= 1) {
        tw.fn(1);
        tw.done();
        return false;
      }
      tw.fn(tw.t);
      return true;
    });
  }
}
