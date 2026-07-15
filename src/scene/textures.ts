import * as THREE from 'three';

/** Procedural canvas textures — no external image assets. */

let noiseBump: THREE.CanvasTexture | null = null;

/** Fine plastic micro-surface used as bumpMap on shells and buttons. */
export function plasticBumpTexture(): THREE.CanvasTexture {
  if (noiseBump) return noiseBump;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 120 + Math.floor(Math.random() * 24);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Slight blur pass to kill hard pixel edges.
  ctx.globalAlpha = 0.5;
  ctx.drawImage(canvas, -1, 0);
  ctx.drawImage(canvas, 1, 0);
  ctx.drawImage(canvas, 0, -1);
  ctx.drawImage(canvas, 0, 1);
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  noiseBump = tex;
  return tex;
}

export interface LabelSpec {
  title: string;
  subtitle?: string;
  accent: number; // hex color
  variant: 'cascade' | 'pong' | 'arcade' | 'blank' | 'imported';
}

/** Paint an original, restrained cartridge label (paper texture, low saturation). */
export function cartridgeLabelTexture(spec: LabelSpec): THREE.CanvasTexture {
  const w = 512;
  const h = 320;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const accent = '#' + spec.accent.toString(16).padStart(6, '0');

  // Paper base
  ctx.fillStyle = '#efece3';
  ctx.fillRect(0, 0, w, h);
  // Fibers
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
    ctx.fillRect(Math.random() * w, Math.random() * h, Math.random() * 2 + 0.4, 0.6);
  }
  ctx.globalAlpha = 1;

  // Light use-wear: two faint scratches
  ctx.strokeStyle = 'rgba(60,55,45,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 60);
  ctx.lineTo(210, 44);
  ctx.moveTo(300, 250);
  ctx.lineTo(470, 268);
  ctx.stroke();

  if (spec.variant === 'blank') {
    // Dashed border + big plus — the LOAD YOUR ROM cart
    ctx.strokeStyle = '#9a958a';
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 4;
    roundRectPath(ctx, 26, 26, w - 52, h - 52, 18);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#6f6a60';
    ctx.font = '600 46px "Helvetica Neue", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LOAD YOUR ROM', w / 2, h / 2 - 6);
    ctx.font = '400 22px "Helvetica Neue", sans-serif';
    ctx.fillStyle = '#9a958a';
    ctx.fillText('drop a .gba file · click to browse', w / 2, h / 2 + 30);
    ctx.strokeStyle = '#9a958a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 16, 64);
    ctx.lineTo(w / 2 + 16, 64);
    ctx.moveTo(w / 2, 48);
    ctx.lineTo(w / 2, 80);
    ctx.stroke();
  } else {
    // Accent band
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.85;
    roundRectPath(ctx, 26, 26, w - 52, 92, 14);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Motif area
    ctx.save();
    roundRectPath(ctx, 26, 130, w - 52, h - 156, 14);
    ctx.clip();
    ctx.fillStyle = '#e3ded2';
    ctx.fillRect(26, 130, w - 52, h - 156);
    drawMotif(ctx, spec.variant, accent, 26, 130, w - 52, h - 156);
    ctx.restore();

    // Title
    ctx.fillStyle = '#f7f5ee';
    ctx.font = '700 40px "Helvetica Neue", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(spec.title.toUpperCase(), 46, 86);
    if (spec.subtitle) {
      ctx.fillStyle = '#5c574c';
      ctx.font = '500 20px "Helvetica Neue", sans-serif';
      ctx.fillText(spec.subtitle, 46, h - 34);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function drawMotif(
  ctx: CanvasRenderingContext2D,
  variant: LabelSpec['variant'],
  accent: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  if (variant === 'cascade') {
    // Falling squares motif
    const cols = ['#4b4f92', accent, '#8d8aa8', '#d8d4cc'];
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = cols[i % cols.length];
      ctx.globalAlpha = 0.75;
      const s = 14 + Math.random() * 26;
      ctx.fillRect(Math.random() * (w - s), Math.random() * (h - s), s, s);
    }
  } else if (variant === 'pong') {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#3a3a3e';
    ctx.fillRect(40, h / 2 - 34, 12, 68);
    ctx.fillRect(w - 52, h / 2 - 34, 12, 68);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(58,58,62,0.35)';
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 10);
    ctx.lineTo(w / 2, h - 10);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (variant === 'arcade') {
    // Six mini glyphs for the 6-in-1 collection
    const glyphs = ['○', '✦', '▲', '■', '◆', '●'];
    ctx.font = '40px "Helvetica Neue", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? accent : '#4b4f92';
      ctx.globalAlpha = 0.8;
      ctx.fillText(glyphs[i], (w / 6) * (i + 0.5), h / 2);
    }
  } else {
    // imported: hash-tinted diagonal stripes
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = accent;
    for (let i = -h; i < w; i += 34) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 17, 0);
      ctx.lineTo(i + 17 - h, h);
      ctx.lineTo(i - h, h);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function roundRectPath(
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

/** Face decals: printed labels next to controls (A/B/SELECT/START/POWER). */
export function faceDecalTexture(keyLabels: Record<string, string>): THREE.CanvasTexture {
  const w = 1024;
  const h = 584;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Body 144.5×82 mapped to canvas; center = (512, 292). 1mm ≈ 7.08px (w) / 7.12px (h)
  const px = (mmX: number): number => 512 + mmX * (w / 144.5);
  const pz = (mmZ: number): number => 292 + mmZ * (h / 82);

  ctx.fillStyle = 'rgba(232,230,224,0.82)';
  ctx.textAlign = 'center';

  ctx.font = '600 21px "Helvetica Neue", sans-serif';
  ctx.fillText('A', px(62), pz(7));
  ctx.fillText('B', px(53), pz(-3));

  ctx.font = '500 15px "Helvetica Neue", sans-serif';
  ctx.fillText('SELECT', px(10), pz(28));
  ctx.fillText('START', px(25), pz(28));

  ctx.font = '500 13px "Helvetica Neue", sans-serif';
  ctx.fillStyle = 'rgba(232,230,224,0.65)';
  ctx.fillText('POWER', px(-56), pz(20.5));

  // Keycap hints next to controls (tiny, drawn as rounded chips)
  const chip = (cx: number, cz: number, label: string): void => {
    if (!label) return;
    ctx.font = '600 14px "Helvetica Neue", sans-serif';
    const tw = ctx.measureText(label).width;
    const bx = px(cx);
    const by = pz(cz);
    ctx.fillStyle = 'rgba(232,230,224,0.16)';
    roundRectPath(ctx, bx - tw / 2 - 7, by - 11, tw + 14, 20, 5);
    ctx.fill();
    ctx.fillStyle = 'rgba(245,243,238,0.92)';
    ctx.fillText(label, bx, by + 4);
  };

  chip(53, 17, keyLabels.A ?? '');
  chip(44, -13, keyLabels.B ?? '');
  chip(-45, -32, keyLabels.L ?? '');
  chip(45, -32, keyLabels.R ?? '');
  chip(-4, 33.5, keyLabels.SELECT ?? '');
  chip(37, 33.5, keyLabels.START ?? '');
  // D-pad: combined hint
  chip(-43, 16, keyLabels.DPAD ?? '');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Screen-bezel well floor: dark with the hardware wordmark below the display. */
export function bezelWellTexture(): THREE.CanvasTexture {
  const w = 640;
  const h = 448;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#15161c';
  ctx.fillRect(0, 0, w, h);
  // subtle vignette
  const grad = ctx.createRadialGradient(w / 2, h / 2, 60, w / 2, h / 2, 420);
  grad.addColorStop(0, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(210,212,224,0.55)';
  ctx.font = '600 30px "Helvetica Neue", sans-serif';
  ctx.textAlign = 'center';
  // Well is 80×56mm, display occupies upper part; wordmark near the bottom strip
  ctx.fillText('GAME BOY ADVANCE', w / 2, h - 26);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Error text rendered into a 240×160 screen texture (shown on the GBA screen). */
export function errorScreenTexture(lines: string[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, 240, 160);
  ctx.fillStyle = '#e0607e';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  lines.slice(0, 8).forEach((line, i) => {
    ctx.fillText(line.slice(0, 38), 10, 24 + i * 16);
  });
  ctx.fillStyle = 'rgba(224,96,126,0.5)';
  ctx.fillText('> ejecting cartridge…', 10, 150);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Back-cover sticker: original exhibit label (no Nintendo branding). */
export function backLabelTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 300;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e8e4da';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#3a3833';
  ctx.font = '700 26px "Helvetica Neue", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('HANDHELD MUSEUM', 28, 52);
  ctx.font = '500 17px "Helvetica Neue", sans-serif';
  ctx.fillStyle = '#6a665e';
  ctx.fillText('Interactive hardware exhibit · Unit 001', 28, 82);
  ctx.fillText('Runs real cartridges in-browser', 28, 106);
  // barcode-ish block (decorative)
  ctx.fillStyle = '#3a3833';
  let bx = 28;
  for (let i = 0; i < 48; i++) {
    const bw = 2 + Math.floor(Math.random() * 5);
    if (Math.random() > 0.35) ctx.fillRect(bx, 140, bw, 64);
    bx += bw + 2;
  }
  ctx.font = '500 15px monospace';
  ctx.fillText('SN 2001-AGB-MUSEUM', 28, 232);
  ctx.font = '400 13px "Helvetica Neue", sans-serif';
  ctx.fillStyle = '#8a867e';
  ctx.fillText('Unofficial experiment · not affiliated with Nintendo', 28, 268);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
