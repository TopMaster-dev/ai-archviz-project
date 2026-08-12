import { describe, it, expect } from 'vitest';
import {
  fitImageBox,
  pxToColWidth,
  splitRowHeights,
  pageSetupFor,
  ESTIMATE_COLUMN_WIDTHS,
  BOARD_COLUMN_WIDTHS,
} from './estimateXlsx.js';

/**
 * Excel から PDF に書き出したときのレイアウト崩れ対策（260813 クライアント指摘）。
 *
 * Excel は「1ページ幅に収める」設定のとき、内容が印刷可能幅を超えると
 * ページ全体を縮小して収める。文字も画像も一緒に小さくなる。
 * したがって「列幅の合計が用紙に収まっているか」が、そのまま
 * 「Ariseで出したPDFと同じ大きさで刷れるか」になる。
 *
 * ここは崩れの原因そのものを数値で固定するテスト。
 */

/**
 * Excel の列幅単位 → px。
 * OOXML の col@width は 5px パディングを**含んだ**値なので px = 幅×7（既定 Calibri 11 の
 * 最大数字幅が 7px）。既定幅 9.140625×7 = 64px と一致する。「×7+5」は二重加算になる。
 */
const colsToPx = (units: readonly number[]) => units.reduce((s, u) => s + u * 7, 0);

/** 用紙の印刷可能幅（px・96dpi）。実装の余白は上下左右 0.4in = 10.16mm。 */
const printableW = (paperMm: number) => Math.round(((paperMm - 20.32) / 25.4) * 96);

const A4_PORTRAIT_W = printableW(210); // ≒717
const A3_LANDSCAPE_W = printableW(420); // ≒1511

describe('列幅が用紙に収まっている（縮小されずに刷れる）', () => {
  it('見積表は A4縦の印刷可能幅に収まる', () => {
    const px = colsToPx(ESTIMATE_COLUMN_WIDTHS);
    expect(px).toBeLessThanOrEqual(A4_PORTRAIT_W);
  });

  it('見積表は用紙の幅を使い切る（縮小も余らせすぎもしない）', () => {
    /*
      比を「内容÷用紙」で見ること。「用紙÷内容」だと列幅をいくら狭めても
      比が大きくなるだけで常に真になり、テストが何も守らない。
      旧値（合計152 = 1064px = 281mm）は余白0.7in の印刷可能幅を超え約61%に縮小されていた。
    */
    const px = colsToPx(ESTIMATE_COLUMN_WIDTHS);
    expect(px / A4_PORTRAIT_W).toBeGreaterThan(0.9);
    expect(px / A4_PORTRAIT_W).toBeLessThanOrEqual(1);
  });

  it('マテリアルボードは A3横の印刷可能幅に収まる', () => {
    const px = colsToPx(BOARD_COLUMN_WIDTHS);
    expect(px).toBeLessThanOrEqual(A3_LANDSCAPE_W);
  });

  it('マテリアルボードは用紙の幅を使い切る', () => {
    // 旧値は938px＝A3横の62%しか使わず、右側に大きな余白が残っていた。
    const px = colsToPx(BOARD_COLUMN_WIDTHS);
    expect(px / A3_LANDSCAPE_W).toBeGreaterThan(0.9);
  });
});

describe('文字が切り捨てられない幅がある', () => {
  /*
    隣のセルに値があると Excel ははみ出し表示をせず文字を切り捨てる。
    折り返し（wrapText）を付けた列は行が伸びるので可読だが、
    仕様列は全行に固定文字列が入るため、1行に収まる幅を確保しておく。
    9pt の全角文字は約12px。
  */
  const FULL_WIDTH_PX = 12;

  it('仕様列に "ロス率込み・㎡単価" が1行で入る', () => {
    const specPx = ESTIMATE_COLUMN_WIDTHS[2]! * 7;
    expect(specPx).toBeGreaterThanOrEqual('ロス率込み・㎡単価'.length * FULL_WIDTH_PX);
  });

  it('明細名称列に半角35文字級の品番が1行で入る', () => {
    // 実データ例: "Sangetsu KAGETOHIKARI_R KAG111C_R01"（半角35文字・9pt で約5px/文字）
    const namePx = ESTIMATE_COLUMN_WIDTHS[1]! * 7;
    expect(namePx).toBeGreaterThanOrEqual(35 * 5);
  });
});

describe('数値列は書式どおりの桁数が入る（##### にならない）', () => {
  /*
    列幅が数値より狭いと、Excel は値を ##### で表示する（切り詰めではなく非表示）。
    見積の要である数量・単価・金額でこれが起きると読めないため、
    列幅を詰めるときは桁数の担保が要る。
    列幅の単位は「既定フォントの 0 が何文字入るか」なので、幅≒最大文字数。
  */
  const IDX = { qty: 3, unitPrice: 5, amount: 6 };

  it('数量は "1,234.567"（9文字）が入る', () => {
    expect(ESTIMATE_COLUMN_WIDTHS[IDX.qty]).toBeGreaterThanOrEqual('1,234.567'.length);
  });

  it('単価は "1,234,567"（9文字）が入る', () => {
    expect(ESTIMATE_COLUMN_WIDTHS[IDX.unitPrice]).toBeGreaterThanOrEqual('1,234,567'.length);
  });

  it('金額は "123,456,789"（11文字）が入る', () => {
    expect(ESTIMATE_COLUMN_WIDTHS[IDX.amount]).toBeGreaterThanOrEqual('123,456,789'.length);
  });
});

describe('画像は用紙の中に収まる（幅だけでなく高さも）', () => {
  const BOX_W = 1452;
  const BOX_H = 957;

  it('横長は幅で決まる', () => {
    const { w, h } = fitImageBox(16 / 9, BOX_W, BOX_H);
    expect(w).toBe(BOX_W);
    expect(h).toBeLessThanOrEqual(BOX_H);
  });

  it('縦長は高さで決まる（旧実装はここで用紙をはみ出していた）', () => {
    // 旧実装は幅を900pxに固定し高さを比率なりに伸ばしていたため、
    // 3:4 だと高さ1200px＝印刷可能領域超え。「1ページに収める」でページごと縮小されていた。
    const { w, h } = fitImageBox(3 / 4, BOX_W, BOX_H);
    expect(h).toBe(BOX_H);
    expect(w).toBeLessThanOrEqual(BOX_W);
  });

  it('どの比率でも用紙からはみ出さない', () => {
    for (const r of [16 / 9, 4 / 3, 1, 3 / 4, 9 / 16, 2.35]) {
      const { w, h } = fitImageBox(r, BOX_W, BOX_H);
      expect(w, `ratio ${r}`).toBeLessThanOrEqual(BOX_W);
      expect(h, `ratio ${r}`).toBeLessThanOrEqual(BOX_H);
    }
  });

  it('縦横比は保つ（画像が歪んではいけない）', () => {
    for (const r of [16 / 9, 4 / 3, 3 / 4, 9 / 16]) {
      const { w, h } = fitImageBox(r, BOX_W, BOX_H);
      expect(w / h, `ratio ${r}`).toBeCloseTo(r, 1);
    }
  });

  it('比率が取れないときは 16:9 とみなす（落とさない）', () => {
    for (const bad of [NaN, 0, -1, Infinity]) {
      const { w, h } = fitImageBox(bad, BOX_W, BOX_H);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });
});

describe('行の高さは Excel の上限（409pt）を超えない', () => {
  it('高い画像は複数行へ割り振る', () => {
    const heights = splitRowHeights(957);
    expect(heights.length).toBeGreaterThan(1);
    for (const h of heights) expect(h).toBeLessThanOrEqual(409);
  });

  it('割り振った合計は画像の高さと一致する（印刷範囲が画像より短くならない）', () => {
    for (const px of [100, 545, 816, 957, 2000]) {
      const heights = splitRowHeights(px);
      const sum = heights.reduce((a, b) => a + b, 0);
      expect(sum, `${px}px`).toBeCloseTo(px * 0.75 + 6, 6);
      for (const h of heights) expect(h, `${px}px`).toBeLessThanOrEqual(409);
    }
  });

  it('低い画像は1行のまま', () => {
    expect(splitRowHeights(200)).toHaveLength(1);
  });

  it('壊れた入力でも行は必ず1つ以上', () => {
    for (const bad of [0, -5, NaN]) {
      const heights = splitRowHeights(bad as number);
      expect(heights.length).toBeGreaterThanOrEqual(1);
      expect(heights[0]).toBeGreaterThan(0);
    }
  });
});

describe('px から列幅への換算', () => {
  it('列は必ず要求 px 以上になる（画像が隣の列へはみ出さない）', () => {
    // 切り捨て/四捨五入だと列が画像より狭くなり、印刷範囲が1列ぶん広がって余計に縮小される。
    for (const px of [140, 500, 1000, 1452, 701, 699]) {
      const units = pxToColWidth(px);
      expect(units * 7, `${px}px`).toBeGreaterThanOrEqual(px);
      // ただし切り上げは1単位（7px）以内に留める（無駄に広げない）。
      expect(units * 7 - px, `${px}px`).toBeLessThan(7);
    }
  });

  it('Excel の上限（255）と下限（1）を超えない', () => {
    expect(pxToColWidth(99999)).toBeLessThanOrEqual(255);
    expect(pxToColWidth(0)).toBeGreaterThanOrEqual(1);
    expect(pxToColWidth(NaN)).toBeGreaterThanOrEqual(1);
  });
});

describe('シートの印刷設定が Arise のPDFのページと一致する', () => {
  /*
    今回の崩れの真因そのもの。用紙サイズを書かないと Excel は出力先の既定用紙を使い、
    横向きのシートは内容ごと90度回転して縦の用紙に押し込まれる。
    ここが緩むと同じ不具合が再発するので、値を直接固定する。
    Arise のPDF: p1=A3横 / p2=A4縦 / p3=A3横（実測 1191x842pt, 595x842pt, 1191x842pt）。
  */
  it('AI画像は A3横（PDF 1ページ目と同じ）', () => {
    const ps = pageSetupFor('image');
    expect(ps.paperSize).toBe(8); // OOXML の A3
    expect(ps.orientation).toBe('landscape');
    expect(ps.fitToHeight).toBe(1); // 画像は1ページに収める
  });

  it('概算見積は A4縦（PDF 2ページ目と同じ）', () => {
    const ps = pageSetupFor('estimate');
    expect(ps.paperSize).toBe(9); // OOXML の A4
    expect(ps.orientation).toBe('portrait');
    expect(ps.fitToHeight).toBe(0); // 明細が多ければ縦に続ける
  });

  it('マテリアルボードは A3横（PDF 3ページ目と同じ）', () => {
    const ps = pageSetupFor('board');
    expect(ps.paperSize).toBe(8);
    expect(ps.orientation).toBe('landscape');
    expect(ps.fitToHeight).toBe(0);
  });

  it('用紙サイズは必ず明示する（未指定だと出力先の既定用紙になり回転する）', () => {
    for (const kind of ['image', 'estimate', 'board'] as const) {
      expect(pageSetupFor(kind).paperSize, kind).toBeDefined();
    }
  });

  it('余白は3シートとも10mm（Excel既定の19mmだと表がさらに縮小される）', () => {
    for (const kind of ['image', 'estimate', 'board'] as const) {
      const m = pageSetupFor(kind).margins;
      expect(m.left, kind).toBeCloseTo(0.4, 5);
      expect(m.right, kind).toBeCloseTo(0.4, 5);
    }
  });
});
