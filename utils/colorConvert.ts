/**
 * 自作カラーピッカー（ThrottledColorInput）用の純粋な色変換ユーティリティ（260709）。
 *
 * 背景: ブラウザ標準の <input type="color"> のスポイト（pen）が Chrome のバグで
 * ブラウザ全体を固めるため、ネイティブ入力をやめて自前ピッカーに置き換える。その
 * ピッカーが使う hex ⇔ HSV ⇔ RGB 変換をここに純関数として切り出す（単体テスト可能）。
 */

export interface Hsv {
  /** 色相 0–360 */
  h: number;
  /** 彩度 0–1 */
  s: number;
  /** 明度 0–1 */
  v: number;
}

export interface Rgb {
  /** 0–255 */
  r: number;
  /** 0–255 */
  g: number;
  /** 0–255 */
  b: number;
}

/** 0–1 にクランプ */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * ユーザー入力の hex を #rrggbb（小文字）へ正規化する。無効なら null。
 * 受理: "#fff" / "fff" / "#ffffff" / "ffffff"（前後空白可）。
 */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return '#' + h.toLowerCase();
  }
  return null;
}

export function hexToRgb(hex: string): Rgb {
  const n = normalizeHex(hex) ?? '#000000';
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return '#' + to2(r) + to2(g) + to2(b);
}

/** r,g,b は 0–255。戻り値の h:0–360 / s,v:0–1。 */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rr) {
      h = 60 * (((gg - bb) / d) % 6);
    } else if (max === gg) {
      h = 60 * ((bb - rr) / d + 2);
    } else {
      h = 60 * ((rr - gg) / d + 4);
    }
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

/** h:0–360 / s,v:0–1。戻り値は 0–255。 */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hh < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hh < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hh < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hh < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

export function hexToHsv(hex: string): Hsv {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

export function hsvToHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}
