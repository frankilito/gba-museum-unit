/**
 * Tiny critically-tunable spring for mechanical-feeling button motion.
 * freq (rad/s) controls speed, damp < 1 gives a small, single overshoot
 * (no jelly wobble). Settle time ≈ 4 / (damp * freq).
 */
export class Spring {
  value = 0;
  target = 0;
  velocity = 0;

  constructor(
    public freq = 30,
    public damp = 0.62,
  ) {}

  snap(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }

  update(dt: number): void {
    // Semi-implicit Euler with fixed sub-steps: explicit integration of a
    // stiff spring blows up when a slow frame delivers a large dt (software
    // renderers, background tabs), so integrate at ≤120Hz internally.
    const maxStep = 1 / 120;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(maxStep, remaining);
      const force = -this.freq * this.freq * (this.value - this.target) - 2 * this.damp * this.freq * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
      this.snap(this.target);
    }
  }
}

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
