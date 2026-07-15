/** GBA ROM header parsing & validation (no external deps). */

export interface RomHeader {
  title: string;
  code: string;
  maker: string;
  checksumValid: boolean;
  logoValid: boolean;
}

export const GBA_LOGO_OFFSET = 0x04;
export const GBA_LOGO_LENGTH = 156;

/** The fixed 156-byte Nintendo logo bitmap every licensed ROM carries at 0x04. */
export const GBA_LOGO: Uint8Array = new Uint8Array([
  0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a, 0x84, 0xe4, 0x09, 0xad,
  0x11, 0x24, 0x8b, 0x98, 0xc0, 0x81, 0x7f, 0x21, 0xa3, 0x52, 0xbe, 0x19, 0x93, 0x09, 0xce, 0x20,
  0x10, 0x46, 0x4a, 0x4a, 0xf8, 0x27, 0x31, 0xec, 0x58, 0xc7, 0xe8, 0x33, 0x82, 0xe3, 0xce, 0xbf,
  0x85, 0xf4, 0xdf, 0x94, 0xce, 0x4b, 0x09, 0xc1, 0x94, 0x56, 0x8a, 0xc0, 0x13, 0x72, 0xa7, 0xfc,
  0x9f, 0x84, 0x4d, 0x73, 0xa3, 0xca, 0x9a, 0x61, 0x58, 0x97, 0xa3, 0x27, 0xfc, 0x03, 0x98, 0x76,
  0x23, 0x1d, 0xc7, 0x61, 0x03, 0x04, 0xae, 0x56, 0xbf, 0x38, 0x84, 0x00, 0x40, 0xa7, 0x0e, 0xfd,
  0xff, 0x52, 0xfe, 0x03, 0x6f, 0x95, 0x30, 0xf1, 0x97, 0xfb, 0xc0, 0x85, 0x60, 0xd6, 0x80, 0x25,
  0xa9, 0x63, 0xbe, 0x03, 0x01, 0x4e, 0x38, 0xe2, 0xf9, 0xa2, 0x34, 0xff, 0xbb, 0x3e, 0x03, 0x44,
  0x78, 0x00, 0x90, 0xcb, 0x88, 0x11, 0x3a, 0x94, 0x65, 0xc0, 0x7c, 0x63, 0x87, 0xf0, 0x3c, 0xaf,
  0xd6, 0x25, 0xe4, 0x8b, 0x38, 0x0a, 0xac, 0x72, 0x21, 0xd4, 0xf8, 0x07,
]);

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) {
    const b = bytes[i];
    if (b === 0) break;
    if (b < 0x20 || b > 0x7e) return s ? s + '?' : '';
    s += String.fromCharCode(b);
  }
  return s.trim();
}

function headerChecksum(rom: Uint8Array): number {
  let chk = 0;
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - rom[i]) & 0xff;
  return (chk - 0x19) & 0xff;
}

export function parseRomHeader(rom: Uint8Array): RomHeader | null {
  if (rom.length < 0xc0) return null;
  let logoValid = true;
  for (let i = 0; i < GBA_LOGO_LENGTH; i++) {
    if (rom[GBA_LOGO_OFFSET + i] !== GBA_LOGO[i]) { logoValid = false; break; }
  }
  return {
    title: ascii(rom, 0xa0, 0xac),
    code: ascii(rom, 0xac, 0xb0),
    maker: ascii(rom, 0xb0, 0xb2),
    checksumValid: headerChecksum(rom) === rom[0xbd],
    logoValid,
  };
}

export interface RomValidation {
  ok: boolean;
  reason?: string;
  header?: RomHeader;
}

export const ROM_MIN_SIZE = 1024; // must at least contain a header
export const ROM_MAX_SIZE = 64 * 1024 * 1024; // 64 MB upper bound

/**
 * Validate a candidate .gba file. Random text renamed to .gba is rejected:
 * it cannot pass the 156-byte logo match, and the odds of byte 0xB2==0x96 plus
 * a valid complement checksum plus a printable title are ~1/16M.
 */
export function validateRom(bytes: Uint8Array, fileName: string): RomValidation {
  if (!/\.gba$/i.test(fileName)) {
    return { ok: false, reason: 'Not a .gba file.' };
  }
  if (bytes.length < ROM_MIN_SIZE) {
    return { ok: false, reason: 'File too small to be a GBA ROM.' };
  }
  if (bytes.length > ROM_MAX_SIZE) {
    return { ok: false, reason: 'File too large (max 64 MB).' };
  }
  const header = parseRomHeader(bytes);
  if (!header) {
    return { ok: false, reason: 'Missing GBA header.' };
  }
  const fixedByteOk = bytes[0xb2] === 0x96;
  if (header.logoValid && fixedByteOk) {
    return { ok: true, header };
  }
  if (fixedByteOk && header.checksumValid && header.title.length > 0) {
    return { ok: true, header };
  }
  return { ok: false, reason: 'GBA header check failed — this is not a valid ROM.' };
}
