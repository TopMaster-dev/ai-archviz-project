import { describe, it, expect } from 'vitest';
import {
  PAPER_SIZES,
  SCALE_DENOMINATORS,
  CUSTOM_PAPER_ID,
  paperSizeById,
  paperMmLandscape,
  paperMmPerPxForImage,
  paperMmPerPxFromWidth,
  realMmPerPx,
  parseScaleDenominator,
  detectPaperIdFromMmPerPx,
  initialPaperIdForImage,
  isStandardPaperAspect,
  offsetFromAnchor,
  anchorFromOffset,
  ANCHOR_OPTIONS,
  type UnderlayAnchor,
} from './underlayScale.js';

/**
 * 下絵の実寸合わせ（260803 要望・260804 資料で仕様確定）。
 *
 * 図面の実寸は「用紙の実寸 ÷ 画素数 × 縮尺の分母」で決まる。
 * ここを間違えると、下絵をなぞって描いた壁の寸法がすべて狂う。
 *
 * クライアント指定:
 *  - 用紙は横（ランドスケープ）想定
 *  - 縦横比がA判(1:1.414)でないファイルは「カスタム（手入力）」にする
 */

describe('用紙は横想定', () => {
  it('常に長辺が幅・短辺が高さ', () => {
    expect(paperMmLandscape(paperSizeById('A3')!)).toEqual({ widthMm: 420, heightMm: 297 });
    expect(paperMmLandscape(paperSizeById('A0')!)).toEqual({ widthMm: 1189, heightMm: 841 });
  });

  it('画像が縦長でも用紙の向きは変えない（指定どおり横で扱う）', () => {
    // 縦長画像でも幅は長辺のまま。向きで実寸が変わると、同じ図面でも取り込み方で寸法がずれるため。
    expect(paperMmPerPxForImage(paperSizeById('A3')!, 2000)).toBeCloseTo(420 / 2000, 10);
  });
});

describe('A判かどうかの判定', () => {
  it('1:1.414 の画像はA判とみなす', () => {
    expect(isStandardPaperAspect(1414, 1000)).toBe(true);
    expect(isStandardPaperAspect(4200, 2970)).toBe(true); // A3実寸比
  });

  it('比率が外れていればA判ではない（切り取った図面など）', () => {
    expect(isStandardPaperAspect(1000, 1000)).toBe(false);
    expect(isStandardPaperAspect(1920, 1080)).toBe(false); // 16:9のスクリーンショット
    expect(isStandardPaperAspect(3000, 1000)).toBe(false); // 長尺
  });

  it('壊れた入力は false', () => {
    expect(isStandardPaperAspect(0, 100)).toBe(false);
    expect(isStandardPaperAspect(100, 0)).toBe(false);
  });
});

describe('画像取り込み時の用紙の初期選択', () => {
  it('A判の比率なら A3 を初期値にする', () => {
    // 画像だけでは A0〜A3 のどれかまでは判別できない（A判はどれも同じ比率）ため既定はA3。
    expect(initialPaperIdForImage(1414, 1000)).toBe('A3');
  });

  it('A判でなければカスタム（手入力）にする', () => {
    expect(initialPaperIdForImage(1920, 1080)).toBe(CUSTOM_PAPER_ID);
  });
});

describe('実寸への換算', () => {
  it('A3横・3000pxなら用紙上は 0.14 mm/px', () => {
    expect(paperMmPerPxForImage(paperSizeById('A3')!, 3000)).toBeCloseTo(420 / 3000, 10);
  });

  it('1/100 の図面なら現実は 14 mm/px（＝画像全体で42m）', () => {
    const p = paperMmPerPxForImage(paperSizeById('A3')!, 3000)!;
    const mmPerPx = realMmPerPx(p, 100)!;
    expect(mmPerPx).toBeCloseTo(14, 10);
    expect(mmPerPx * 3000).toBeCloseTo(42000, 6); // 42m
  });

  it('縮尺が倍になれば実寸も倍', () => {
    const p = paperMmPerPxForImage(paperSizeById('A3')!, 3000)!;
    expect(realMmPerPx(p, 200)!).toBeCloseTo(realMmPerPx(p, 100)! * 2, 10);
  });

  it('カスタム: 幅(mm)を直接指定できる', () => {
    expect(paperMmPerPxFromWidth(420, 3000)).toBeCloseTo(0.14, 10);
  });

  it('壊れた入力では null（勝手な既定値で配置しない）', () => {
    expect(paperMmPerPxForImage(paperSizeById('A3')!, 0)).toBeNull();
    expect(paperMmPerPxFromWidth(0, 3000)).toBeNull();
    expect(paperMmPerPxFromWidth(420, 0)).toBeNull();
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

  it('解釈できない入力は null（黙って既定値にしない）', () => {
    for (const bad of ['', '  ', 'abc', '1/0', '0', '-100', '1//150', '150cm']) {
      expect(parseScaleDenominator(bad), bad).toBeNull();
    }
  });
});

describe('PDFからの用紙推定', () => {
  it('A3のPDFはA3と判定する', () => {
    expect(detectPaperIdFromMmPerPx(420 / 3000, 3000)).toBe('A3');
  });

  it('A1のPDFはA1と判定する', () => {
    expect(detectPaperIdFromMmPerPx(841 / 2000, 2000)).toBe('A1');
  });

  it('規格から外れる用紙はカスタムにする（長尺図面など）', () => {
    expect(detectPaperIdFromMmPerPx(2000 / 3000, 3000)).toBe(CUSTOM_PAPER_ID);
  });

  it('壊れた入力はカスタム（誤った用紙で自動確定しない）', () => {
    expect(detectPaperIdFromMmPerPx(0, 3000)).toBe(CUSTOM_PAPER_ID);
    expect(detectPaperIdFromMmPerPx(0.14, 0)).toBe(CUSTOM_PAPER_ID);
  });
});

describe('基準点（位置をどの角で測るか）', () => {
  const W = 42000;
  const H = 29700;
  const anchors = ANCHOR_OPTIONS.map((a) => a.id);

  it('左上なら位置＝左上座標そのもの', () => {
    expect(offsetFromAnchor('topLeft', 1000, 2000, W, H)).toEqual({ offsetX: 1000, offsetY: 2000 });
  });

  it('右上なら幅のぶん左へずれた位置が左上になる', () => {
    expect(offsetFromAnchor('topRight', 1000, 2000, W, H)).toEqual({ offsetX: 1000 - W, offsetY: 2000 });
  });

  it('左下なら高さのぶん上へずれた位置が左上になる（Yは下向きが正）', () => {
    expect(offsetFromAnchor('bottomLeft', 1000, 2000, W, H)).toEqual({ offsetX: 1000, offsetY: 2000 - H });
  });

  it('右下は幅・高さの両方がずれる', () => {
    expect(offsetFromAnchor('bottomRight', 1000, 2000, W, H)).toEqual({ offsetX: 1000 - W, offsetY: 2000 - H });
  });

  it('どの角でも往復して元に戻る（基準点を切り替えても下絵は動かない）', () => {
    // 基準点はあくまで「どこを測るか」であって、下絵そのものは動いてはいけない。
    for (const a of anchors) {
      const o = offsetFromAnchor(a as UnderlayAnchor, 1000, 2000, W, H);
      const back = anchorFromOffset(a as UnderlayAnchor, o.offsetX, o.offsetY, W, H);
      expect(back, a).toEqual({ x: 1000, y: 2000 });
    }
  });

  it('同じ左上座標なら、角を変えると表示される位置だけが変わる', () => {
    const offsetX = 0;
    const offsetY = 0;
    expect(anchorFromOffset('topLeft', offsetX, offsetY, W, H)).toEqual({ x: 0, y: 0 });
    expect(anchorFromOffset('topRight', offsetX, offsetY, W, H)).toEqual({ x: W, y: 0 });
    expect(anchorFromOffset('bottomLeft', offsetX, offsetY, W, H)).toEqual({ x: 0, y: H });
    expect(anchorFromOffset('bottomRight', offsetX, offsetY, W, H)).toEqual({ x: W, y: H });
  });

  it('寸法が負でも壊れない（0として扱う）', () => {
    expect(offsetFromAnchor('bottomRight', 100, 100, -5, -5)).toEqual({ offsetX: 100, offsetY: 100 });
  });
});

describe('選択肢の定義', () => {
  it('用紙は A0〜A3、短辺 < 長辺', () => {
    expect(PAPER_SIZES.map((p) => p.id)).toEqual(['A0', 'A1', 'A2', 'A3']);
    for (const p of PAPER_SIZES) expect(p.shortMm).toBeLessThan(p.longMm);
  });

  it('縮尺は資料の指定どおり', () => {
    expect([...SCALE_DENOMINATORS]).toEqual([10, 20, 30, 50, 100, 150, 200, 250, 300, 500]);
  });

  it('基準点は4隅', () => {
    expect(ANCHOR_OPTIONS.map((a) => a.label)).toEqual(['左上', '右上', '左下', '右下']);
  });
});
