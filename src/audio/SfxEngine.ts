/**
 * SfxEngine — all sounds synthesized at runtime with WebAudio.
 * Nothing is sampled from Nintendo hardware or commercial games:
 * plastic clicks are filtered noise bursts + short tonal bodies.
 */

export class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private unlocked = false;
  private muted = false;

  /** Call from the first user gesture (pointerdown/keydown). */
  unlock(): void {
    if (this.unlocked) {
      void this.ctx?.resume();
      return;
    }
    this.unlocked = true;
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);

    // 1s of white noise, reused by every effect.
    const len = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.startAmbient();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.9;
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    if (this.unlocked) void this.ctx?.resume();
  }

  // ---- primitives ----

  private noiseBurst(opts: {
    at?: number;
    duration: number;
    gain: number;
    filterType: BiquadFilterType;
    freq: number;
    q?: number;
    freqEnd?: number;
  }): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const t = this.ctx.currentTime + (opts.at ?? 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.filterType;
    filter.frequency.setValueAtTime(opts.freq, t);
    if (opts.q) filter.Q.value = opts.q;
    if (opts.freqEnd) filter.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + opts.duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + opts.duration + 0.02);
  }

  private tone(opts: {
    at?: number;
    duration: number;
    freq: number;
    freqEnd?: number;
    gain: number;
    type?: OscillatorType;
  }): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + (opts.at ?? 0);
    const osc = this.ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + opts.duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + opts.duration + 0.02);
  }

  // ---- effects ----

  /** A/B button: firm plastic dome — click + low body. */
  abPress(): void {
    this.noiseBurst({ duration: 0.028, gain: 0.5, filterType: 'highpass', freq: 1400 });
    this.noiseBurst({ duration: 0.045, gain: 0.35, filterType: 'bandpass', freq: 2600, q: 1.2 });
    this.tone({ duration: 0.06, freq: 190, gain: 0.22, type: 'sine' });
  }

  abRelease(): void {
    this.noiseBurst({ duration: 0.02, gain: 0.22, filterType: 'highpass', freq: 2200 });
  }

  /** L/R shoulder: deeper clack with a microswitch tick. */
  shoulderPress(): void {
    this.noiseBurst({ duration: 0.03, gain: 0.45, filterType: 'highpass', freq: 1000 });
    this.tone({ duration: 0.07, freq: 140, gain: 0.25 });
    this.noiseBurst({ at: 0.012, duration: 0.012, gain: 0.3, filterType: 'bandpass', freq: 4200, q: 2 });
  }

  shoulderRelease(): void {
    this.noiseBurst({ duration: 0.022, gain: 0.2, filterType: 'highpass', freq: 1600 });
  }

  /** Start/Select: short rubber thud. */
  rubberPress(): void {
    this.noiseBurst({ duration: 0.05, gain: 0.3, filterType: 'lowpass', freq: 700 });
    this.tone({ duration: 0.045, freq: 120, gain: 0.16 });
  }

  rubberRelease(): void {
    this.noiseBurst({ duration: 0.035, gain: 0.12, filterType: 'lowpass', freq: 900 });
  }

  dpadPress(): void {
    this.noiseBurst({ duration: 0.025, gain: 0.28, filterType: 'bandpass', freq: 1800, q: 1.5 });
    this.tone({ duration: 0.05, freq: 160, gain: 0.14 });
  }

  dpadRelease(): void {
    this.noiseBurst({ duration: 0.02, gain: 0.12, filterType: 'bandpass', freq: 2400, q: 1.5 });
  }

  /** Power slider: friction sweep ending in a detent click. */
  powerSlide(): void {
    this.noiseBurst({ duration: 0.16, gain: 0.18, filterType: 'bandpass', freq: 800, freqEnd: 2600, q: 0.8 });
    this.noiseBurst({ at: 0.15, duration: 0.025, gain: 0.4, filterType: 'highpass', freq: 1800 });
    this.tone({ at: 0.15, duration: 0.05, freq: 150, gain: 0.2 });
  }

  /** Cartridge insert: damped slide + latch lock (double click). */
  insertLatch(): void {
    this.noiseBurst({ duration: 0.22, gain: 0.16, filterType: 'bandpass', freq: 2400, freqEnd: 500, q: 0.7 });
    this.noiseBurst({ at: 0.2, duration: 0.03, gain: 0.5, filterType: 'highpass', freq: 1500 });
    this.tone({ at: 0.2, duration: 0.07, freq: 170, gain: 0.28 });
    this.noiseBurst({ at: 0.235, duration: 0.018, gain: 0.3, filterType: 'bandpass', freq: 3200, q: 2 });
  }

  /** Eject: latch release + short spring pop. */
  ejectRelease(): void {
    this.noiseBurst({ duration: 0.025, gain: 0.4, filterType: 'highpass', freq: 1700 });
    this.tone({ at: 0.02, duration: 0.12, freq: 520, freqEnd: 1400, gain: 0.18, type: 'triangle' });
    this.noiseBurst({ at: 0.05, duration: 0.14, gain: 0.14, filterType: 'bandpass', freq: 600, freqEnd: 1900, q: 0.7 });
  }

  /** Hover tick on cartridges — very quiet. */
  hoverTick(): void {
    this.noiseBurst({ duration: 0.012, gain: 0.08, filterType: 'highpass', freq: 2600 });
  }

  uiBlip(): void {
    this.tone({ duration: 0.05, freq: 660, gain: 0.1, type: 'triangle' });
  }

  errorBuzz(): void {
    this.tone({ duration: 0.18, freq: 130, gain: 0.14, type: 'sawtooth' });
  }

  // ---- ambient bed ----

  private startAmbient(): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    const g = this.ctx.createGain();
    g.gain.value = 0.012; // barely-there room tone
    src.connect(filter).connect(g).connect(this.master);
    src.start();
    this.ambientSource = src;
  }

  stopAmbient(): void {
    try {
      this.ambientSource?.stop();
    } catch {
      /* already stopped */
    }
    this.ambientSource = null;
  }
}
