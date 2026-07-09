import { describe, it, expect } from 'vitest';
import {
  normalizeHex,
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  hexToHsv,
  hsvToHex,
} from './colorConvert.js';

describe('colorConvert', () => {
  it('normalizeHex: 3桁/6桁/#有無/空白/大文字を #rrggbb 小文字へ、無効は null', () => {
    expect(normalizeHex('#fff')).toBe('#ffffff');
    expect(normalizeHex('fff')).toBe('#ffffff');
    expect(normalizeHex('#FFFFFF')).toBe('#ffffff');
    expect(normalizeHex('  #Ece5D3 ')).toBe('#ece5d3');
    expect(normalizeHex('abcdef')).toBe('#abcdef');
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex('#ggg')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('12345678')).toBeNull();
  });

  it('hexToRgb / rgbToHex 往復', () => {
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#ece5d3')).toEqual({ r: 236, g: 229, b: 211 });
    expect(rgbToHex(236, 229, 211)).toBe('#ece5d3');
    // クランプ
    expect(rgbToHex(-10, 300, 128)).toBe('#00ff80');
  });

  it('rgbToHsv: 既知の色', () => {
    expect(rgbToHsv(255, 0, 0)).toMatchObject({ h: 0, s: 1, v: 1 });
    const green = rgbToHsv(0, 255, 0);
    expect(green.h).toBeCloseTo(120, 3);
    expect(green.s).toBe(1);
    expect(green.v).toBe(1);
    const blue = rgbToHsv(0, 0, 255);
    expect(blue.h).toBeCloseTo(240, 3);
    // 無彩色は s=0
    expect(rgbToHsv(255, 255, 255)).toMatchObject({ s: 0, v: 1 });
    expect(rgbToHsv(0, 0, 0)).toMatchObject({ s: 0, v: 0 });
    expect(rgbToHsv(128, 128, 128).s).toBe(0);
  });

  it('hsvToRgb: 既知の色', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb(120, 1, 1)).toEqual({ r: 0, g: 255, b: 0 });
    expect(hsvToRgb(240, 1, 1)).toEqual({ r: 0, g: 0, b: 255 });
    expect(hsvToRgb(0, 0, 1)).toEqual({ r: 255, g: 255, b: 255 });
    expect(hsvToRgb(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('hex ⇔ HSV 往復（代表色で誤差1未満）', () => {
    const samples = ['#ffffff', '#000000', '#ece5d3', '#8b6f47', '#4b3621', '#3366cc', '#ff8800'];
    for (const hex of samples) {
      const hsv = hexToHsv(hex);
      const back = hsvToHex(hsv.h, hsv.s, hsv.v);
      expect(back).toBe(normalizeHex(hex));
    }
  });

  it('hsvToRgb は色相の負値/360超えを正規化する', () => {
    expect(hsvToRgb(-360, 1, 1)).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb(720, 1, 1)).toEqual({ r: 255, g: 0, b: 0 });
  });
});
