import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Spring } from './spring';
import type { ButtonState, GBAButton } from '../core/types';

/**
 * HandheldModel — the real AGB-001 shell (no procedural body geometry),
 * presented UPRIGHT like a museum exhibit: the device stands on its bottom
 * edge facing the viewer (+Z) with a slight backward lean, cradled by a
 * restrained dark matte-acrylic display stand (a scene prop, not a part of
 * the console — the only procedural geometry here besides the LCD plane and
 * the keycap-hint chips allowed by the task).
 *
 * Model: "Gameboy Advance - Zelda Concept" by yassineCGI (CC-BY-4.0),
 * downloaded 2026-07-13, adapted in ~/gba-assets (split into named parts,
 * indigo repaint, power slider + volume wheel added, screen island
 * separated, normalized to 144.5mm wide / Y-up / screen +Z). The GLB's
 * native orientation is already the upright one (screen +Z, Y up); it is
 * scaled ×1000 into the scene's millimeter space.
 *
 * Hierarchy:
 *   group (shake) → deviceGroup (lean) → glbRoot (scale) + pivot groups + LCD + chips
 *   standGroup — added to the scene by Scene3D, does not shake.
 */

/** Backward lean of the upright device (rad) — negative = top edge away. */
export const DISPLAY_LEAN = -0.17; // ≈ −9.7°

const LEAN_EULER = new THREE.Euler(DISPLAY_LEAN, 0, 0);

// Cartridge slot pose measured from the GLB geometry (top-edge groove,
// |x| < 32mm): groove floor strip at glb y ≈ 33.5mm, walls at y ≈ 36.5..40.5.
// The unleaned anchor (0, 36.5, 4.7) seats the cart so its top protrudes
// ≈11.5mm above the top edge — matching reference photos; exported values
// include the display lean (carts live in scene space).
export const SLOT_ANCHOR_POS = new THREE.Vector3(0, 36.5, 4.7).applyEuler(LEAN_EULER);
export const SLOT_APPROACH_POS = new THREE.Vector3(0, 61.5, 4.7).applyEuler(LEAN_EULER);

const GLB_URL = 'models/gba.glb';

// Warm the HTTP cache at module evaluation (the loader reuses the response).
if (typeof document !== 'undefined') {
  void fetch(new URL(GLB_URL, document.baseURI)).catch(() => undefined);
}

/** Control anchors measured from the GLB meshes (scene mm, unleaned upright). */
const ANCHOR = {
  dpadPivot: new THREE.Vector3(-53.3, 6.5, 10.4), // base center of the cross
  dpadCenter: new THREE.Vector3(-53.3, 6.5, 12.5),
  btnA: new THREE.Vector3(58.5, 9.8, 11.5),
  btnB: new THREE.Vector3(45.7, 5.4, 11.5),
  btnSelect: new THREE.Vector3(-43.6, -13.1, 13.1),
  btnStart: new THREE.Vector3(-43.6, -21.1, 13.1),
  shoulderL: new THREE.Vector3(-41.0, 37.1, 8.0), // inner-top edge hinge
  shoulderR: new THREE.Vector3(41.0, 37.3, 8.0),
  slider: new THREE.Vector3(70.8, 5.7, 0.0),
  lcd: new THREE.Vector3(-0.8, 5.7, 13.35), // centered on the embossed LCD area
};

/** Keycap-hint chip positions (x, y) on the face, z = 13.45. */
const CHIP_POS: Record<string, [number, number]> = {
  A: [58.5, 0.5],
  B: [45.7, -3.5],
  DPAD: [-53.3, 19.5],
  SELECT: [-43.6, -6.5],
  START: [-43.6, -27.5],
  L: [-63.0, 27.0],
  R: [63.0, 27.0],
};

export class HandheldModel {
  readonly group = new THREE.Group();
  /** Device + controls + LCD + chips; carries the display lean. */
  readonly deviceGroup = new THREE.Group();
  /** Museum display stand — a scene prop; added to the scene by Scene3D. */
  readonly standGroup = new THREE.Group();

  readonly screenMaterial: THREE.MeshStandardMaterial;
  ledMaterial!: THREE.MeshStandardMaterial;

  /** Raycast targets for physical button presses (tagged with userData). */
  readonly buttonHitMeshes: THREE.Object3D[] = [];
  dpadHitMesh: THREE.Object3D | null = null;
  readonly dpadCenter = new THREE.Vector3();

  // pivot groups (created up-front; GLB meshes attach on load)
  readonly grpDpad = new THREE.Group();
  private grpA = new THREE.Group();
  private grpB = new THREE.Group();
  private grpL = new THREE.Group();
  private grpR = new THREE.Group();
  private grpStart = new THREE.Group();
  private grpSelect = new THREE.Group();
  private grpSlider = new THREE.Group();

  /** Resolves when the GLB is loaded and all parts are attached. */
  readonly ready: Promise<void>;
  private loaded = false;

  private screenTex: THREE.Texture | null = null;
  private chipMats = new Map<string, THREE.MeshBasicMaterial>();

  // animation springs
  private springA = new Spring(30, 0.6);
  private springB = new Spring(30, 0.6);
  private springL = new Spring(26, 0.6);
  private springR = new Spring(26, 0.6);
  private springStart = new Spring(34, 0.7);
  private springSelect = new Spring(34, 0.7);
  private dpadRx = new Spring(26, 0.55);
  private dpadRy = new Spring(26, 0.55);
  private ledLevel = new Spring(14, 1);
  private backlight = new Spring(9, 1);
  private sliderPos = new Spring(18, 0.85);
  private shakeTime = 0;
  private shakeAmp = 0;

  constructor() {
    this.group.name = 'handheld';
    this.deviceGroup.name = 'device';
    this.deviceGroup.rotation.x = DISPLAY_LEAN;
    this.group.add(this.deviceGroup);
    this.dpadCenter.copy(this.deviceGroup.localToWorld(ANCHOR.dpadCenter.clone()));

    for (const [grp, anchor] of [
      [this.grpDpad, ANCHOR.dpadPivot],
      [this.grpA, ANCHOR.btnA],
      [this.grpB, ANCHOR.btnB],
      [this.grpL, ANCHOR.shoulderL],
      [this.grpR, ANCHOR.shoulderR],
      [this.grpStart, ANCHOR.btnStart],
      [this.grpSelect, ANCHOR.btnSelect],
      [this.grpSlider, ANCHOR.slider],
    ] as const) {
      grp.position.copy(anchor);
      this.deviceGroup.add(grp);
    }

    // ---------- LCD plane (screen replacement, strict 3:2, 240×160 content) ----------
    this.screenMaterial = new THREE.MeshStandardMaterial({
      color: 0x0d0d11,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      roughness: 0.28,
      metalness: 0,
      envMapIntensity: 0.5, // very light glassy reflection, even while playing
      toneMapped: false,
    });
    const lcd = new THREE.Mesh(new THREE.PlaneGeometry(59.0, 39.33), this.screenMaterial);
    lcd.name = 'lcd';
    lcd.position.copy(ANCHOR.lcd); // faces +Z, like the screen island
    lcd.renderOrder = 1;
    this.deviceGroup.add(lcd);

    this.buildKeyChips();
    this.buildStand();

    this.ready = this.loadGlb();
  }

  // ---------- display stand (scene prop) ----------

  private buildStand(): void {
    this.standGroup.name = 'display-stand';
    const mat = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.92, metalness: 0 });

    // foot plate on the floor
    const foot = new THREE.Mesh(new RoundedBoxGeometry(124, 5, 50, 3, 2), mat);
    foot.position.set(0, -43.5, -8);
    foot.castShadow = true;
    foot.receiveShadow = true;
    this.standGroup.add(foot);

    // two cradle brackets gripping the bottom corners, angled with the lean
    for (const sx of [-1, 1]) {
      const bracket = new THREE.Mesh(new RoundedBoxGeometry(16, 13, 32, 3, 3), mat);
      bracket.position.set(sx * 54, -38.5, -5);
      bracket.rotation.x = DISPLAY_LEAN;
      bracket.castShadow = true;
      bracket.receiveShadow = true;
      this.standGroup.add(bracket);
    }

    // low back bar catching the lean at the bottom of the battery cover
    const backBar = new THREE.Mesh(new RoundedBoxGeometry(80, 5, 4, 2, 1.5), mat);
    backBar.position.set(0, -36.3, -9);
    backBar.rotation.x = DISPLAY_LEAN;
    backBar.castShadow = true;
    backBar.receiveShadow = true;
    this.standGroup.add(backBar);
  }

  // ---------- GLB ----------

  private async loadGlb(): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(new URL(GLB_URL, document.baseURI).href);

    const glbRoot = new THREE.Group();
    glbRoot.name = 'gba-glb';
    glbRoot.scale.setScalar(1000); // meters → millimeters; GLB is already upright (screen +Z, Y up)
    glbRoot.add(gltf.scene);
    this.deviceGroup.add(glbRoot);
    this.group.updateMatrixWorld(true);

    // collect part meshes by name. GLTFLoader names mesh children "<node>_1"
    // (fall back to the parent node's name for the procedural slider meshes).
    const parts = new Map<string, THREE.Mesh>();
    gltf.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      let partName = mesh.name.replace(/_\d+$/, '');
      if (!partName || partName === 'mesh') partName = mesh.parent?.name ?? '';
      if (partName) parts.set(partName, mesh);
    });

    // dark glass for the screen island (the LCD plane floats just above it)
    const screenMesh = parts.get('screen');
    if (screenMesh) {
      screenMesh.material = new THREE.MeshPhysicalMaterial({
        color: 0x070809,
        roughness: 0.1,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.12,
        envMapIntensity: 1.2,
      });
      screenMesh.castShadow = false;
    }

    // LED: clone the atlas material so it can glow on its own
    const ledMesh = parts.get('led');
    if (ledMesh) {
      this.ledMaterial = (ledMesh.material as THREE.MeshStandardMaterial).clone();
      this.ledMaterial.emissive = new THREE.Color(0x33ff66);
      this.ledMaterial.emissiveIntensity = 0;
      this.ledMaterial.color.setHex(0x0d2815); // dark base: white atlas tint would wash the glow out
      this.ledMaterial.roughness = 0.9; // glossy finish reflects the softbox as a white blowout
      this.ledMaterial.metalness = 0;
      this.ledMaterial.envMapIntensity = 0.15;
      ledMesh.material = this.ledMaterial;
      // The led mesh is modeled behind the shell's molded lens dome
      // (~1mm proud of the face) — lift it above the dome so it can glow.
      const ledLift = new THREE.Group();
      this.deviceGroup.add(ledLift);
      ledLift.attach(ledMesh);
      ledLift.position.z += 1.6;
    } else {
      this.ledMaterial = new THREE.MeshStandardMaterial({ color: 0x0a2a10, emissive: 0x33ff66, emissiveIntensity: 0 });
    }

    // interactive parts → pivot groups (attach preserves world transform)
    const attach = (
      partName: string,
      pivot: THREE.Group,
      userData: Record<string, unknown>,
    ): THREE.Mesh | null => {
      const mesh = parts.get(partName);
      if (!mesh) {
        console.warn(`[handheld] GLB part "${partName}" missing`);
        return null;
      }
      mesh.userData = { ...mesh.userData, ...userData };
      pivot.attach(mesh);
      this.buttonHitMeshes.push(mesh);
      return mesh;
    };

    this.dpadHitMesh = attach('dpad', this.grpDpad, { kind: 'dpad' });
    attach('btnA', this.grpA, { kind: 'button', button: 'A' satisfies GBAButton });
    attach('btnB', this.grpB, { kind: 'button', button: 'B' satisfies GBAButton });
    attach('btnStart', this.grpStart, { kind: 'button', button: 'START' satisfies GBAButton });
    attach('btnSelect', this.grpSelect, { kind: 'button', button: 'SELECT' satisfies GBAButton });
    attach('shoulderL', this.grpL, { kind: 'button', button: 'L' satisfies GBAButton });
    attach('shoulderR', this.grpR, { kind: 'button', button: 'R' satisfies GBAButton });

    // power slider = the two procedural meshes under the "powerSlider" node
    const sliderMesh = parts.get('powerSlider');
    if (sliderMesh) {
      const parent = sliderMesh.parent!;
      for (const child of [...parent.children]) {
        if ((child as THREE.Mesh).isMesh) this.grpSlider.attach(child);
      }
    } else {
      console.warn('[handheld] GLB part "powerSlider" missing');
    }

    this.loaded = true;
  }

  // ---------- keycap hint chips ----------

  private buildKeyChips(): void {
    for (const [key, [x, y]] of Object.entries(CHIP_POS)) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.chipTexture(''),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const aspect = key === 'DPAD' ? 2.4 : 1.4;
      const chip = new THREE.Mesh(new THREE.PlaneGeometry(7 * aspect, 7), mat);
      chip.position.set(x, y, 13.45); // faces +Z, like the face
      chip.renderOrder = 3;
      this.deviceGroup.add(chip);
      this.chipMats.set(key, mat);
    }
  }

  private chipTexture(label: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 256, 64);
    if (label) {
      ctx.font = '600 30px "Helvetica Neue", sans-serif';
      const tw = Math.min(ctx.measureText(label).width, 240);
      ctx.fillStyle = 'rgba(232,230,224,0.16)';
      roundRect(ctx, 128 - tw / 2 - 14, 8, tw + 28, 48, 12);
      ctx.fill();
      ctx.fillStyle = 'rgba(245,243,238,0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 128, 34);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // ---------- screen ----------

  setScreenTexture(tex: THREE.Texture): void {
    this.screenTex = tex;
    this.screenMaterial.map = tex;
    this.screenMaterial.emissiveMap = tex;
    this.screenMaterial.needsUpdate = true;
  }

  setErrorScreen(tex: THREE.Texture): void {
    this.screenMaterial.map = tex;
    this.screenMaterial.emissiveMap = tex;
    this.screenMaterial.emissiveIntensity = 1;
    this.screenMaterial.needsUpdate = true;
  }

  restoreScreen(): void {
    if (this.screenTex) this.setScreenTexture(this.screenTex);
  }

  setBacklightTarget(on: boolean): void {
    this.backlight.target = on ? 1 : 0;
  }

  setPower(on: boolean): void {
    this.ledLevel.target = on ? 1 : 0;
    this.sliderPos.target = on ? 1 : 0;
  }

  /** Regenerate the keycap-hint chips after a remap. */
  setKeyLabels(labels: Record<string, string>): void {
    for (const [key, mat] of this.chipMats) {
      const old = mat.map;
      mat.map = this.chipTexture(labels[key] ?? '');
      mat.needsUpdate = true;
      old?.dispose();
    }
  }

  shake(amp = 0.35, time = 0.14): void {
    this.shakeAmp = amp;
    this.shakeTime = time;
  }

  // ---------- per-frame animation ----------

  update(dt: number, buttons: ButtonState): void {
    this.springA.target = buttons.A ? 1 : 0;
    this.springB.target = buttons.B ? 1 : 0;
    this.springL.target = buttons.L ? 1 : 0;
    this.springR.target = buttons.R ? 1 : 0;
    this.springStart.target = buttons.START ? 1 : 0;
    this.springSelect.target = buttons.SELECT ? 1 : 0;
    this.dpadRx.target = (buttons.UP ? -1 : buttons.DOWN ? 1 : 0) * 0.17;
    this.dpadRy.target = (buttons.LEFT ? -1 : buttons.RIGHT ? 1 : 0) * 0.17;

    for (const s of [
      this.springA,
      this.springB,
      this.springL,
      this.springR,
      this.springStart,
      this.springSelect,
      this.dpadRx,
      this.dpadRy,
      this.ledLevel,
      this.backlight,
      this.sliderPos,
    ]) {
      s.update(dt);
    }

    if (this.loaded) {
      // upright pose: buttons press into the face (−Z)
      this.grpA.position.z = ANCHOR.btnA.z - 1.8 * this.springA.value;
      this.grpB.position.z = ANCHOR.btnB.z - 1.8 * this.springB.value;
      this.grpStart.position.z = ANCHOR.btnStart.z - 0.9 * this.springStart.value;
      this.grpSelect.position.z = ANCHOR.btnSelect.z - 0.9 * this.springSelect.value;
      this.grpL.rotation.x = 0.19 * this.springL.value;
      this.grpR.rotation.x = 0.19 * this.springR.value;
      this.grpDpad.rotation.x = this.dpadRx.value;
      this.grpDpad.rotation.y = this.dpadRy.value;
      this.grpSlider.position.y = ANCHOR.slider.y + 3.5 * this.sliderPos.value;
      this.ledMaterial.emissiveIntensity = 2.5 * this.ledLevel.value;
    }
    this.screenMaterial.emissiveIntensity = 1.05 * this.backlight.value;

    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const a = this.shakeAmp * Math.max(0, this.shakeTime / 0.14);
      this.group.position.x = (Math.random() - 0.5) * a;
      this.group.position.y = (Math.random() - 0.5) * a;
      if (this.shakeTime <= 0) this.group.position.set(0, 0, 0);
    }
  }

  /** Current button travel values (0..1) — used by tests to verify same-frame response. */
  getButtonTravel(): Record<string, number> {
    return {
      A: this.springA.value,
      B: this.springB.value,
      L: this.springL.value,
      R: this.springR.value,
      START: this.springStart.value,
      SELECT: this.springSelect.value,
    };
  }

  /** Debug/test: world position of a control's hit mesh. */
  getButtonWorldPos(name: string): THREE.Vector3 | null {
    for (const m of this.buttonHitMeshes) {
      if (m.userData.button === name || (name === 'DPAD' && m.userData.kind === 'dpad')) {
        return m.getWorldPosition(new THREE.Vector3());
      }
    }
    return null;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
