import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { HandheldModel } from './HandheldModel';
import { lerp } from './spring';
import type { ButtonState } from '../core/types';

/**
 * Scene3D — renderer, studio lighting, camera rig and the render loop.
 * Warm light-gray seamless photo studio: one big soft key, weak rim,
 * real soft contact shadow. No bloom, no neon, no HUD in the 3D world.
 */

export type LayoutMode = 'desktop' | 'portrait' | 'grip';

/**
 * Landscape "grip mode" (phones only): a coarse pointer on a small screen
 * held sideways reframes the PLAYING camera so the device face fills the
 * viewport width — LCD centered and maximized, D-pad / A / B inside the
 * thumb zones. Detection reuses the existing layout pipeline (resize →
 * layout mode → camera goals); desktop viewports never resolve to 'grip'.
 */
const GRIP_HALF_WIDTH = 74; // device is 144.5mm wide → fills ≈98% of the view width
const GRIP_TARGET = new THREE.Vector3(-0.8, 8, 13.35); // LCD plane, slight headroom
const GRIP_MAX_MIN_DIM = 500; // CSS px — phones, not tablets / desktop windows

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly handheld: HandheldModel;

  readonly raycaster = new THREE.Raycaster();

  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // camera rig state (spherical around target) — device stands upright
  private camTarget = new THREE.Vector3(0, 2, 0);
  private camTargetGoal = new THREE.Vector3(0, 2, 0);
  private az = -0.38;
  private azGoal = -0.38;
  private elev = 0.35;
  private elevGoal = 0.35;
  private radius = 600;
  private radiusGoal = 600;
  private parallaxX = 0;
  private parallaxY = 0;
  private playView = false;
  private dragFocus = false;
  private layout: LayoutMode = 'desktop';
  private coarseMq = window.matchMedia('(pointer: coarse)');
  private smallScreen = false;
  private gripSuppressed = false; // user exited grip mode via the corner chip
  private gripRadius = 400; // recomputed from the aspect on every resize

  private pointerNdc = new THREE.Vector2();

  /** When set, the rig stops driving the camera (debug screenshots). */
  cameraOverride: { pos: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(26, window.innerWidth / window.innerHeight, 1, 6000);

    this.buildStudio();
    this.buildLights();

    this.handheld = new HandheldModel();
    this.scene.add(this.handheld.group);
    this.scene.add(this.handheld.standGroup); // museum display stand (scene prop)

    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('resize', this.resize);
    this.coarseMq.addEventListener('change', () => this.resize());
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.reducedMotion = e.matches;
    });
    this.resize();

    // Slow-network/cold-cache guard: the first framing may have been computed
    // before the GLB (and the layout it implies) was ready — re-fit once the
    // model is fully attached. refit() is a no-op when nothing drifted.
    this.handheld.ready.then(() => this.refit()).catch(() => undefined);
  }

  // ---------- studio ----------

  private buildStudio(): void {
    // Seamless warm-gray cyclorama: gradient sphere + matching floor.
    const uniforms = {
      top: { value: new THREE.Color(0xdad6cd) },
      bottom: { value: new THREE.Color(0xb7b3aa) },
    };
    const backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms,
        vertexShader: `
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vPos;
          uniform vec3 top;
          uniform vec3 bottom;
          void main() {
            float h = normalize(vPos).y * 0.5 + 0.5;
            vec3 c = mix(bottom, top, smoothstep(0.05, 0.6, h));
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      }),
    );
    this.scene.add(backdrop);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1400, 64),
      new THREE.MeshStandardMaterial({ color: 0xc4c0b7, roughness: 0.96, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -46.0; // display stand foot rests here; device stands upright
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Subtle environment for plastic/glass reflections: gradient + one soft window.
    const envScene = new THREE.Scene();
    const envSphere = new THREE.Mesh(
      new THREE.SphereGeometry(100, 16, 12),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x8d8a84 }),
    );
    envScene.add(envSphere);
    const window_ = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 60),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    window_.position.set(-40, 60, 60);
    window_.lookAt(0, 0, 0);
    envScene.add(window_);
    const floorGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshBasicMaterial({ color: 0x55524d }),
    );
    floorGlow.rotation.x = -Math.PI / 2;
    floorGlow.position.y = -30;
    envScene.add(floorGlow);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0.06).texture;
    pmrem.dispose();
  }

  private buildLights(): void {
    RectAreaLightUniformsLib.init();

    this.scene.add(new THREE.HemisphereLight(0xfff6ea, 0x8f8b83, 0.55));

    const key = new THREE.DirectionalLight(0xfff4e8, 2.4);
    key.position.set(-160, 260, 190);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 60;
    key.shadow.camera.far = 900;
    key.shadow.camera.left = -220;
    key.shadow.camera.right = 220;
    key.shadow.camera.top = 200;
    key.shadow.camera.bottom = -200;
    key.shadow.radius = 7;
    key.shadow.blurSamples = 12;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xdfe6ff, 0.55);
    rim.position.set(240, 130, -210);
    this.scene.add(rim);

    const softbox = new THREE.RectAreaLight(0xfff8f0, 2.6, 420, 280);
    softbox.position.set(-130, 330, 260);
    softbox.lookAt(0, 0, 0);
    this.scene.add(softbox);
  }

  // ---------- camera ----------

  setPlayView(on: boolean): void {
    this.playView = on;
    // the pouch parks out of frame in grip mode, so layout consumers need a
    // re-evaluation whenever play view toggles (idempotent, snaps directly)
    this.onLayout?.(this.layout);
  }

  /** Corner-chip exit: leave the immersive framing until the context resets. */
  setGripSuppressed(on: boolean): void {
    if (this.gripSuppressed === on) return;
    this.gripSuppressed = on;
    this.onLayout?.(this.layout);
  }

  /** Coarse pointer on a phone-sized screen (orientation-independent). */
  get gripEligibleDevice(): boolean {
    return this.coarseMq.matches && this.smallScreen;
  }

  /** True while the immersive landscape grip framing is actually driving the camera. */
  get gripMode(): boolean {
    return this.layout === 'grip' && this.playView && !this.gripSuppressed;
  }

  setDragFocus(on: boolean): void {
    this.dragFocus = on;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.reducedMotion) return;
    this.parallaxX = (e.clientX / window.innerWidth - 0.5) * 2;
    this.parallaxY = (e.clientY / window.innerHeight - 0.5) * 2;
  };

  private updateCamera(dt: number): void {
    if (this.cameraOverride) {
      // pos/target may be plain {x,y,z} objects (test hooks) — lookAt() on a
      // non-Vector3 would read undefined components and NaN the view matrix.
      const { pos, target } = this.cameraOverride;
      this.camera.position.set(pos.x, pos.y, pos.z);
      this.camera.lookAt(target.x, target.y, target.z);
      return;
    }
    if (this.playView) {
      if (this.layout === 'grip' && !this.gripSuppressed) {
        // immersive grip: device face fills the viewport width, LCD centered
        this.azGoal = 0;
        this.elevGoal = 0.02;
        this.radiusGoal = this.gripRadius;
        this.camTargetGoal.copy(GRIP_TARGET);
      } else {
        this.azGoal = 0;
        this.elevGoal = this.layout === 'portrait' ? 0.45 : 0.32;
        this.radiusGoal = this.layout === 'portrait' ? 720 : 565;
        this.camTargetGoal.set(0, 4, this.layout === 'portrait' ? 30 : 2);
      }
    } else {
      this.azGoal = this.layout === 'portrait' ? -0.16 : -0.38;
      this.elevGoal = 0.35;
      this.radiusGoal = this.layout === 'portrait' ? 820 : 600;
      this.camTargetGoal.set(0, 2, this.layout === 'portrait' ? 45 : 0);
    }
    if (this.dragFocus && !this.playView) {
      // gentle push toward the slot (top edge) while a cartridge approaches
      this.camTargetGoal.lerp(new THREE.Vector3(0, 26, 0), 0.22);
      this.radiusGoal *= 0.94;
    }

    const damp = 1 - Math.exp(-dt * 4.5);
    this.az = lerp(this.az, this.azGoal, damp);
    this.elev = lerp(this.elev, this.elevGoal, damp);
    this.radius = lerp(this.radius, this.radiusGoal, damp);
    this.camTarget.lerp(this.camTargetGoal, damp);

    // no parallax wobble in grip mode — thumbs move across the screen constantly
    const px = this.reducedMotion || this.layout === 'grip' ? 0 : this.parallaxX * 0.05; // ≈ ±3°
    const py = this.reducedMotion || this.layout === 'grip' ? 0 : this.parallaxY * 0.03;
    const az = this.az + px;
    const elev = Math.max(0.05, this.elev + py);

    const r = this.radius;
    this.camera.position.set(
      this.camTarget.x + r * Math.cos(elev) * Math.sin(az),
      this.camTarget.y + r * Math.sin(elev),
      this.camTarget.z + r * Math.cos(elev) * Math.cos(az),
    );
    this.camera.lookAt(this.camTarget);
  }

  // ---------- layout / resize ----------

  private lastW = 0;
  private lastH = 0;

  resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.lastW = w;
    this.lastH = h;
    this.smallScreen = Math.min(w, h) <= GRIP_MAX_MIN_DIM;
    // grip: coarse pointer + phone-sized screen + landscape. Everything else
    // keeps the existing aspect-based desktop/portrait split untouched.
    this.layout =
      this.coarseMq.matches && this.smallScreen && w > h ? 'grip' : w / h < 1.05 ? 'portrait' : 'desktop';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // distance that makes the device face span GRIP_HALF_WIDTH×2 of view width
    const vHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    this.gripRadius = GRIP_HALF_WIDTH / (vHalf * this.camera.aspect);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.onLayout?.(this.layout);
  };

  /**
   * Recompute layout/size and snap the camera rig straight to its goals
   * (no damp). Called once the GLB is fully loaded, so any framing computed
   * against a half-initialized scene is corrected in one step.
   */
  refit(): void {
    this.resize();
    this.az = this.azGoal;
    this.elev = this.elevGoal;
    this.radius = this.radiusGoal;
    this.camTarget.copy(this.camTargetGoal);
  }

  onLayout: ((mode: LayoutMode) => void) | null = null;

  get layoutMode(): LayoutMode {
    return this.layout;
  }

  // ---------- picking helpers ----------

  ndcFromClient(x: number, y: number): THREE.Vector2 {
    this.pointerNdc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    return this.pointerNdc.clone();
  }

  raycast(ndc: THREE.Vector2, objects: THREE.Object3D[], recursive = true): THREE.Intersection[] {
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, recursive);
  }

  /** Project a world position to CSS pixels (for the hover tooltip). */
  projectToScreen(pos: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = pos.clone().project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      visible: v.z < 1,
    };
  }

  // ---------- frame ----------

  render(dt: number, buttons: ButtonState): void {
    // Some viewport changes never fire window.resize (iframe growth on embed
    // hosts, mobile browser chrome). Poll the real size so the framing can
    // never be left stale — resize() is cheap and idempotent.
    if (window.innerWidth !== this.lastW || window.innerHeight !== this.lastH) this.resize();
    this.handheld.update(dt, buttons);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
