/** Colour helpers shared by Phaser (numeric) and React (CSS string) layers. */

export function hexToInt(hex: string): number {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return Number.parseInt(full, 16) & 0xffffff;
}

export function intToHex(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const value = hexToInt(hex);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const va = hexToInt(a);
  const vb = hexToInt(b);
  const ar = (va >> 16) & 0xff;
  const ag = (va >> 8) & 0xff;
  const ab = va & 0xff;
  const br = (vb >> 16) & 0xff;
  const bg = (vb >> 8) & 0xff;
  const bb = vb & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return intToHex((r << 16) | (g << 8) | bl);
}

export function shade(hex: string, amount: number): string {
  return amount < 0 ? mixHex(hex, '#000000', -amount) : mixHex(hex, '#ffffff', amount);
}

export function colorIntToCss(value: number): string {
  return intToHex(value);
}

/**
 * Perceptual luminance (0..1) — used to decide which stop of a two-colour
 * palette carries enough contrast to be the UI identity colour.
 */
export function luminance(hex: string): number {
  const value = hexToInt(hex);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
