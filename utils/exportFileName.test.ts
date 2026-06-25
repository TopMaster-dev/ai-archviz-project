import { describe, it, expect } from 'vitest';
import { sanitizeFileNamePart, exportDateStamp, buildPreviewFileName, buildHiResFileName } from './exportFileName.js';

const NOW = new Date(2026, 5, 25); // 2026-06-25（ローカル）

describe('exportDateStamp', () => {
  it('YYYY-MM-DD（ゼロ埋め）', () => {
    expect(exportDateStamp(new Date(2026, 0, 3))).toBe('2026-01-03');
    expect(exportDateStamp(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('sanitizeFileNamePart', () => {
  it('OSで使えない文字を _ に', () => {
    expect(sanitizeFileNamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });
  it('空白（全角含む）を 1 つの _ に・連続 _ もまとめる', () => {
    expect(sanitizeFileNamePart('リビング 　提案  A')).toBe('リビング_提案_A');
  });
  it('先頭・末尾の . _ を除去', () => {
    expect(sanitizeFileNamePart('  .提案_  ')).toBe('提案');
  });
  it('日本語はそのまま許可', () => {
    expect(sanitizeFileNamePart('和室リフォーム案')).toBe('和室リフォーム案');
  });
});

describe('buildPreviewFileName', () => {
  it('日付＋プロジェクト名＋.png', () => {
    expect(buildPreviewFileName('リビング提案', NOW)).toBe('2026-06-25_リビング提案.png');
  });
  it('不正文字を含む名前をサニタイズ', () => {
    expect(buildPreviewFileName('A/B 案', NOW)).toBe('2026-06-25_A_B_案.png');
  });
  it('名前が空/空白/未指定なら既定値にフォールバック', () => {
    expect(buildPreviewFileName('', NOW)).toBe('2026-06-25_プロジェクト.png');
    expect(buildPreviewFileName('   ', NOW)).toBe('2026-06-25_プロジェクト.png');
    expect(buildPreviewFileName(null, NOW)).toBe('2026-06-25_プロジェクト.png');
    expect(buildPreviewFileName(undefined, NOW)).toBe('2026-06-25_プロジェクト.png');
  });
});

describe('buildHiResFileName', () => {
  it('日付＋プロジェクト名＋DPI＋寸法＋.png（プリセットを区別できる）', () => {
    expect(buildHiResFileName('リビング提案', { dpi: 300, width: 5906, height: 3321 }, NOW)).toBe(
      '2026-06-25_リビング提案_300dpi_5906x3321.png',
    );
    // 別プリセットはファイル名で区別できる。
    expect(buildHiResFileName('リビング提案', { dpi: 150, width: 2953, height: 1662 }, NOW)).toBe(
      '2026-06-25_リビング提案_150dpi_2953x1662.png',
    );
  });
  it('不正文字を含む名前をサニタイズ', () => {
    expect(buildHiResFileName('A/B 案', { dpi: 250, width: 4922, height: 2768 }, NOW)).toBe(
      '2026-06-25_A_B_案_250dpi_4922x2768.png',
    );
  });
  it('名前が空/未指定なら既定値にフォールバック', () => {
    expect(buildHiResFileName('', { dpi: 200, width: 3937, height: 2216 }, NOW)).toBe(
      '2026-06-25_プロジェクト_200dpi_3937x2216.png',
    );
    expect(buildHiResFileName(null, { dpi: 150, width: 2953, height: 1662 }, NOW)).toBe(
      '2026-06-25_プロジェクト_150dpi_2953x1662.png',
    );
  });
});
