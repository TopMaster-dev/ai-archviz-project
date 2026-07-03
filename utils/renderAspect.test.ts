import { describe, it, expect } from 'vitest';
import {
  RENDER_ASPECT_RATIOS,
  DEFAULT_RENDER_ASPECT,
  normalizeRenderAspectKey,
  ratioValueForKey,
  aspectLabelForKey,
  containBox,
} from './renderAspect.js';
import { exportPresetsForRatio, EXPORT_PRESETS_16_9 } from './printExportSpec.js';

describe('normalizeRenderAspectKey（対応キーへ丸め・260703）', () => {
  it('対応キーはそのまま', () => {
    expect(normalizeRenderAspectKey('3:2')).toBe('3:2');
    expect(normalizeRenderAspectKey('16:9')).toBe('16:9');
  });
  it('未対応/空は既定(16:9)へ', () => {
    expect(normalizeRenderAspectKey('7:3')).toBe(DEFAULT_RENDER_ASPECT);
    expect(normalizeRenderAspectKey(null)).toBe(DEFAULT_RENDER_ASPECT);
    expect(normalizeRenderAspectKey(undefined)).toBe(DEFAULT_RENDER_ASPECT);
    expect(normalizeRenderAspectKey('1:1.414')).toBe(DEFAULT_RENDER_ASPECT); // 用紙比率は対応外
  });
  it('既定は対応リストに含まれる', () => {
    expect(RENDER_ASPECT_RATIOS.some((r) => r.key === DEFAULT_RENDER_ASPECT)).toBe(true);
  });
});

describe('ratioValueForKey / aspectLabelForKey', () => {
  it('比率値を返す', () => {
    expect(ratioValueForKey('16:9')).toBeCloseTo(16 / 9, 6);
    expect(ratioValueForKey('1:1')).toBeCloseTo(1, 6);
    expect(ratioValueForKey('3:4')).toBeCloseTo(3 / 4, 6);
  });
  it('未知キーは16:9相当', () => {
    expect(ratioValueForKey('nope')).toBeCloseTo(16 / 9, 6);
  });
  it('ラベルは W : H 体裁', () => {
    expect(aspectLabelForKey('16:9')).toBe('16 : 9');
    expect(aspectLabelForKey('3:2')).toBe('3 : 2');
    expect(aspectLabelForKey('bad')).toBe(DEFAULT_RENDER_ASPECT.replace(':', ' : '));
  });
});

describe('containBox（レターボックス＝contain・最大の比率矩形）', () => {
  it('外枠が目標より横長なら高さ使い切り', () => {
    const b = containBox(2000, 1000, 1); // 目標1:1、外枠は横長
    expect(b.h).toBeCloseTo(1000);
    expect(b.w).toBeCloseTo(1000);
  });
  it('外枠が目標より縦長なら幅使い切り', () => {
    const b = containBox(1000, 2000, 1); // 目標1:1、外枠は縦長
    expect(b.w).toBeCloseTo(1000);
    expect(b.h).toBeCloseTo(1000);
  });
  it('同一比率は外枠いっぱい', () => {
    const b = containBox(1600, 900, 16 / 9);
    expect(b.w).toBeCloseTo(1600);
    expect(b.h).toBeCloseTo(900);
  });
  it('返り矩形は目標比率', () => {
    const b = containBox(1234, 987, 3 / 2);
    expect(b.w / b.h).toBeCloseTo(3 / 2, 6);
    expect(b.w).toBeLessThanOrEqual(1234 + 1e-6);
    expect(b.h).toBeLessThanOrEqual(987 + 1e-6);
  });
  it('不正入力は外枠をそのまま', () => {
    const b = containBox(0, 100, 1);
    expect(b.w).toBe(0);
  });
});

describe('exportPresetsForRatio（任意比率の書き出しプリセット）', () => {
  it('16:9 は従来の EXPORT_PRESETS_16_9 と同一寸法（後方互換）', () => {
    const gen = exportPresetsForRatio(16 / 9);
    expect(gen.length).toBe(EXPORT_PRESETS_16_9.length);
    gen.forEach((p, i) => {
      expect(p.width).toBe(EXPORT_PRESETS_16_9[i]!.width);
      expect(p.height).toBe(EXPORT_PRESETS_16_9[i]!.height);
      expect(p.dpi).toBe(EXPORT_PRESETS_16_9[i]!.dpi);
    });
  });
  it('横長は幅＝長辺・縦長は高さ＝長辺（向き保持）', () => {
    const land = exportPresetsForRatio(3 / 2)[0]!;
    expect(land.width).toBeGreaterThan(land.height);
    expect(land.width / land.height).toBeCloseTo(3 / 2, 2);

    const port = exportPresetsForRatio(3 / 4)[0]!;
    expect(port.height).toBeGreaterThan(port.width);
    expect(port.width / port.height).toBeCloseTo(3 / 4, 2);
  });
  it('1:1 は正方', () => {
    const sq = exportPresetsForRatio(1)[0]!;
    expect(sq.width).toBe(sq.height);
  });
});
