import { describe, it, expect } from 'vitest';
import {
  PAPER_SIZES,
  paperSizeById,
  paperMmForImage,
  paperMmPerPxForImage,
  realMmPerPx,
  parseScaleDenominator,
  detectPaperIdFromMmPerPx,
} from './underlayScale.js';

/**
 * 260803 クライアント要望（管理表124行目）「下絵は用紙サイズと縮尺を指定して実寸で配置したい」。
 *
 * 図面の実寸は「用紙の実寸 ÷ 画素数 × 縮尺の分母」で決まる。
 * ここを間違えると下絵の上をなぞって描いた壁の寸法がすべて狂うため、数値で固定する。
 */

describe('用紙の向き（画像の縦横比から自動判定）', () => {
  const a3 = paperSizeById('A3')!;

  it('横長の画像は横向き（長辺が幅）', () => {
    expect(paperMmForImage(a3, 3000, 2000)).toEqual({ widthMm: 420, heightMm: 297 });
  });

  it('縦長の画像は縦向き（短辺が幅）', () => {
    expect(paperMmForImage(a3, 2000, 3000)).toEqual({ widthMm: 297, heightMm: 420 });
  });

  it('正方形は横向き扱い（どちらかに決めておく）', () => {
    expect(paperMmForImage(a3, 2000, 2000).widthMm).toBe(420);
  });
});

describe('実寸への換算', () => {
  it('A3横・3000pxなら用紙上は 0.14 mm/px', () => {
    expect(paperMmPerPxForImage(paperSizeById('A3')!, 3000, 2000)).toBeCloseTo(420 / 3000, 10);
  });

  it('1/100 の図面なら現実は 14 mm/px（＝画像全体で42m）', () => {
    const p = paperMmPerPxForImage(paperSizeById('A3')!, 3000, 2000)!;
    const mmPerPx = realMmPerPx(p, 100)!;
    expect(mmPerPx).toBeCloseTo(14, 10);
    expect(mmPerPx * 3000).toBeCloseTo(42000, 6); // 42m
  });

  it('縮尺が倍になれば実寸も倍', () => {
    const p = paperMmPerPxForImage(paperSizeById('A3')!, 3000, 2000)!;
    expect(realMmPerPx(p, 200)!).toBeCloseTo(realMmPerPx(p, 100)! * 2, 10);
  });

  it('A1の方がA3より大きな実寸になる（同じ画素数・同じ縮尺なら）', () => {
    const a3 = paperMmPerPxForImage(paperSizeById('A3')!, 3000, 2000)!;
    const a1 = paperMmPerPxForImage(paperSizeById('A1')!, 3000, 2000)!;
    expect(realMmPerPx(a1, 100)!).toBeGreaterThan(realMmPerPx(a3, 100)!);
  });

  it('壊れた入力では null（勝手な既定値で配置しない）', () => {
    expect(paperMmPerPxForImage(paperSizeById('A3')!, 0, 100)).toBeNull();
    expect(realMmPerPx(0, 100)).toBeNull();
    expect(realMmPerPx(0.14, 0)).toBeNull();
  });
});

describe('縮尺の入力解釈', () => {
  it('「1/150」「1:150」「150」をすべて受ける', () => {
    expect(parseScaleDenominator('1/150')).toBe(150);
    expect(parseScaleDenominator('1:150')).toBe(150);
    expect(parseScaleDenominator('150')).toBe(150);
  });

  it('前後の空白や全角でも受ける（資料が全角で書かれることがある）', () => {
    expect(parseScaleDenominator('  1/150  ')).toBe(150);
    expect(parseScaleDenominator('１／１５０')).toBe(150);
    expect(parseScaleDenominator('1 / 150')).toBe(150);
  });

  it('小数の縮尺も受ける', () => {
    expect(parseScaleDenominator('1/12.5')).toBe(12.5);
  });

  it('解釈できない入力は null（黙って既定値にしない）', () => {
    for (const bad of ['', '  ', 'abc', '1/0', '0', '-100', '1/-5', '1//150', '150cm']) {
      expect(parseScaleDenominator(bad), bad).toBeNull();
    }
  });
});

describe('PDFからの用紙推定（挿入ダイアログの初期選択）', () => {
  it('A3横のPDFはA3と判定する', () => {
    // 420mm を 3000px で取り込んだ場合の用紙上 mm/px
    expect(detectPaperIdFromMmPerPx(420 / 3000, 3000, 2000)).toBe('A3');
  });

  it('A1縦のPDFはA1と判定する', () => {
    expect(detectPaperIdFromMmPerPx(594 / 2000, 2000, 3000)).toBe('A1');
  });

  it('規格から大きく外れる用紙は判定しない（利用者に選ばせる）', () => {
    // 規格のどれとも一致しない幅（例: 2000mm の長尺）
    expect(detectPaperIdFromMmPerPx(2000 / 3000, 3000, 2000)).toBeNull();
  });

  it('壊れた入力では null', () => {
    expect(detectPaperIdFromMmPerPx(0, 3000, 2000)).toBeNull();
    expect(detectPaperIdFromMmPerPx(0.14, 0, 0)).toBeNull();
  });
});

describe('用紙の定義', () => {
  it('A0〜A3が定義され、短辺 < 長辺になっている', () => {
    expect(PAPER_SIZES.map((p) => p.id)).toEqual(['A0', 'A1', 'A2', 'A3']);
    for (const p of PAPER_SIZES) expect(p.shortMm).toBeLessThan(p.longMm);
  });

  it('A判は1つ小さくすると面積がほぼ半分', () => {
    for (let i = 0; i < PAPER_SIZES.length - 1; i++) {
      const big = PAPER_SIZES[i].shortMm * PAPER_SIZES[i].longMm;
      const small = PAPER_SIZES[i + 1].shortMm * PAPER_SIZES[i + 1].longMm;
      expect(big / small).toBeCloseTo(2, 1);
    }
  });
});
