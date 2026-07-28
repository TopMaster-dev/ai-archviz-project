import { describe, it, expect } from 'vitest';
import { mergeResolvedIntoRecommendations } from './visionProductSearchCore.js';
import type { ResolvedProduct } from './productResolver.js';
import type { AgentRecommendation } from '../../types.js';

/**
 * 260728 クライアント要望②③の核心:
 *  - モデルが書いたURL（作文＝ほぼ404）は絶対に提示しない
 *  - 価格・品番・メーカーはページから実測した値を優先する
 * ここが崩れると「実在しない商品」「404のURL」という元の不具合に戻る。
 */
const rec = (o: Partial<AgentRecommendation> & { name: string }): AgentRecommendation => ({ ...o });
const resolved = (o: Partial<ResolvedProduct> & { finalUrl: string }): ResolvedProduct =>
  ({ source: 'json-ld', ...o }) as ResolvedProduct;

describe('mergeResolvedIntoRecommendations', () => {
  it('実測が無いときはモデルのURLを必ず落とす（404を出さない）', () => {
    const out = mergeResolvedIntoRecommendations(
      [rec({ name: '椅子', productUrl: 'https://example.com/made-up/123', price: 24800 })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].productUrl).toBeUndefined();
    expect(out[0].name).toBe('椅子'); // 名称は手掛かりとして残す
  });

  it('実測値が価格・品番・メーカーを上書きする（推測より実測を優先）', () => {
    const out = mergeResolvedIntoRecommendations(
      [rec({ name: '推測名', brand: '推測メーカー', modelNumber: 'GUESS-1', price: 99999, productUrl: 'https://karimoku.co.jp/x' })],
      [
        resolved({
          finalUrl: 'https://www.karimoku.co.jp/item/WU4700',
          name: 'カリモク WU4700',
          brand: 'カリモク家具',
          sku: 'WU4700',
          price: 98000,
          imageUrl: 'https://img.example/wu4700.jpg',
          availability: 'InStock',
        }),
      ],
    );
    expect(out[0].name).toBe('カリモク WU4700');
    expect(out[0].brand).toBe('カリモク家具');
    expect(out[0].modelNumber).toBe('WU4700');
    expect(out[0].price).toBe(98000);
    expect(out[0].productUrl).toBe('https://www.karimoku.co.jp/item/WU4700');
    expect(out[0].imageUrl).toBe('https://img.example/wu4700.jpg');
    expect(out[0].verified).toBe(true);
  });

  it('同じホストの実測だけに対応付ける（www の有無は無視）', () => {
    const out = mergeResolvedIntoRecommendations(
      [rec({ name: 'A', productUrl: 'https://www.b-shop.jp/guess' })],
      [
        resolved({ finalUrl: 'https://a-shop.jp/p/1', name: 'Aの商品' }),
        resolved({ finalUrl: 'https://b-shop.jp/p/2', name: 'Bの商品' }),
      ],
    );
    expect(out[0].productUrl).toBe('https://b-shop.jp/p/2');
    expect(out[0].name).toBe('Bの商品');
  });

  // 260728 敵対レビュー B1: ホストが一致しない実測を当てはめてはいけない。
  // 以前は余った実測を順番に割り当てていたため、別商品の名前・URL と
  // モデルが推測したメーカー/品番/価格が1枚のカードに混ざり、
  // しかも『確認済み』バッジが付くという、元の不具合より悪い状態が作れた。
  it('ホスト不一致の実測を推薦に混ぜない（別商品の値が合成されない）', () => {
    const out = mergeResolvedIntoRecommendations(
      [rec({ name: 'カリモク60 Kチェア', brand: 'カリモク家具', modelNumber: 'K-CHAIR-U', price: 88000, productUrl: 'https://karimoku60.com/x' })],
      [resolved({ finalUrl: 'https://amazon.co.jp/dp/XYZ', name: 'ソファカバー ストレッチ 3人掛け' })],
    );
    const guess = out.find((r) => r.modelNumber === 'K-CHAIR-U');
    expect(guess).toBeDefined();
    // モデルの推測はURLを持たず、未確認として出る
    expect(guess!.name).toBe('カリモク60 Kチェア'); // 別商品の名前で上書きされない
    expect(guess!.productUrl).toBeUndefined();
    expect(guess!.verified).toBe(false);
    // 実測商品は独立した候補として出る（推測値と混ざらない）
    const real = out.find((r) => r.productUrl === 'https://amazon.co.jp/dp/XYZ');
    expect(real!.name).toBe('ソファカバー ストレッチ 3人掛け');
    expect(real!.brand).toBeUndefined();
    expect(real!.price).toBeUndefined();
  });

  // 260728 敵対レビュー B3: カタログ経路（ユーザーが登録した実データ）は検証済みなので触らない。
  it('verified 済みの推薦はURLを保持する（運営が手入力した商品URLを失わない）', () => {
    const out = mergeResolvedIntoRecommendations(
      [rec({ name: '自社登録品', productUrl: 'https://own.example/p/1', verified: true })],
      [],
    );
    expect(out[0].productUrl).toBe('https://own.example/p/1');
    expect(out[0].verified).toBe(true);
  });

  it('実測商品は全て候補に加える（Vision が見つけたものを取りこぼさない）', () => {
    const out = mergeResolvedIntoRecommendations(
      [rec({ name: 'A' })], // URL 無し＝どの実測ともホストが一致しない
      [
        resolved({ finalUrl: 'https://a.jp/1', name: '商品1' }),
        resolved({ finalUrl: 'https://b.jp/2', name: '商品2' }),
      ],
    );
    // モデルの推薦1件（未確認）＋ 実測2件（確認済み）＝ 3件。混ぜないので合成されない。
    expect(out).toHaveLength(3);
    expect(out.filter((r) => r.verified).map((r) => r.productUrl)).toEqual([
      'https://a.jp/1',
      'https://b.jp/2',
    ]);
    expect(out.find((r) => r.name === 'A')!.productUrl).toBeUndefined();
  });

  it('裏取りできない推薦は全てURLを失い、実測は独立候補として残る', () => {
    const out = mergeResolvedIntoRecommendations(
      [rec({ name: 'A', productUrl: 'https://fake/1' }), rec({ name: 'B', productUrl: 'https://fake/2' })],
      [resolved({ finalUrl: 'https://real.jp/1', name: '実物' })],
    );
    expect(out.filter((r) => r.name === 'A' || r.name === 'B').every((r) => r.productUrl === undefined)).toBe(true);
    expect(out.some((r) => r.name === '実物' && r.productUrl === 'https://real.jp/1')).toBe(true);
  });

  it('壊れた入力でも落ちない', () => {
    expect(mergeResolvedIntoRecommendations(undefined as never, [])).toEqual([]);
    expect(mergeResolvedIntoRecommendations([], [])).toEqual([]);
  });

  it('提示件数に上限がある（描画とトークンの暴走防止）', () => {
    const many = Array.from({ length: 20 }, (_, i) => resolved({ finalUrl: `https://x.jp/${i}`, name: `P${i}` }));
    expect(mergeResolvedIntoRecommendations([], many).length).toBeLessThanOrEqual(8);
  });
});
