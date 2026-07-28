import { describe, it, expect } from 'vitest';
import { buildAgentItemMemo } from './agentItemMemo.js';
import { isOutOfStock } from './productExtract.js';

/**
 * 260728 クライアント要望:
 *   「100%の正確性は保証できない点は理解している。見積に追加した際、メモ欄に
 *    在庫切れ・廃番・価格改定といった旨を自動記載する運用でカバーしたい」
 * 見積は長期間残るため、取得日を必ず残す（いつ時点の価格か分からないと使えない）。
 */
const at = new Date(2026, 6, 28); // 2026/07/28

describe('buildAgentItemMemo', () => {
  it('ページ確認済みなら「要確認」の注意書きと取得日を付ける', () => {
    const memo = buildAgentItemMemo({ verified: true }, at);
    expect(memo).toContain('2026/07/28');
    expect(memo).toContain('在庫切れ・廃番・価格改定の可能性');
    expect(memo).toContain('要確認');
  });

  it('推薦理由があれば先頭に残す（ユーザーが見返す主要情報）', () => {
    const memo = buildAgentItemMemo({ reason: '既存のオーク材と調和するため', verified: true }, at);
    expect(memo.startsWith('既存のオーク材と調和するため')).toBe(true);
    expect(memo).toContain('※Web取得情報');
  });

  it('改行ではなく区切り文字で連結する（単一行inputで区切りが消えないように）', () => {
    // メモ欄は <input type="text"> のため、改行はブラウザに除去されて
    // 「理由※Web取得情報…」と繋がってしまう（260728 敵対レビュー B5）。
    const memo = buildAgentItemMemo({ reason: '理由', verified: true }, at);
    expect(memo).not.toContain('\n');
    expect(memo).toContain(' / ');
  });

  it('在庫切れが判明している場合はより強い文言にする', () => {
    const memo = buildAgentItemMemo({ verified: true, availability: 'OutOfStock' }, at);
    expect(memo).toContain('在庫切れ／廃番の表示あり');
  });

  it('ページ未確認（AIの推測）はさらに強く注意喚起する', () => {
    const memo = buildAgentItemMemo({ verified: false }, at);
    expect(memo).toContain('未確認情報');
    expect(memo).toContain('一次情報でご確認');
  });

  it('空の推薦でも必ず注記が付く（注記なしで見積に入らない）', () => {
    expect(buildAgentItemMemo({}, at)).toContain('2026/07/28');
  });
});

describe('isOutOfStock', () => {
  it('schema.org の詰め表記を判定する', () => {
    expect(isOutOfStock('OutOfStock')).toBe(true);
    expect(isOutOfStock('https://schema.org/OutOfStock')).toBe(true);
    expect(isOutOfStock('SoldOut')).toBe(true);
    expect(isOutOfStock('Discontinued')).toBe(true);
  });

  it('空白・大小の揺れを吸収する（サイトによって表記がまちまち）', () => {
    expect(isOutOfStock('out of stock')).toBe(true);
    expect(isOutOfStock('Out Of Stock')).toBe(true);
    expect(isOutOfStock('SOLD OUT')).toBe(true);
  });

  it('在庫ありや未設定は false', () => {
    expect(isOutOfStock('InStock')).toBe(false);
    expect(isOutOfStock('https://schema.org/InStock')).toBe(false);
    expect(isOutOfStock('')).toBe(false);
    expect(isOutOfStock(undefined)).toBe(false);
  });
});
