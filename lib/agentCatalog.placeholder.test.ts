import { describe, it, expect } from 'vitest';
import { buildAgentCatalog, isPlaceholderProductValue } from './agentCatalog.js';
import type { FurnitureCatalogItem } from '../types.js';

/**
 * 260728 クライアント #8:「提案される商品が実在しない／URLが404」対策。
 * サンプル（プレースホルダ）値を実在商品として提示しないことを固定する。
 */
describe('isPlaceholderProductValue', () => {
  it('サンプル品番を検出する', () => {
    expect(isPlaceholderProductValue('SAMPLE-SOFA')).toBe(true);
    expect(isPlaceholderProductValue('SMPL-CH-001')).toBe(true);
    expect(isPlaceholderProductValue('sample-lamp')).toBe(true);
  });

  it('example ドメインを検出する', () => {
    expect(isPlaceholderProductValue('https://example.com/products/chair')).toBe(true);
    expect(isPlaceholderProductValue('http://example.org/x')).toBe(true);
  });

  it('サンプル表記のメーカー名を検出する', () => {
    expect(isPlaceholderProductValue('（例）サンプル・ファニチャー')).toBe(true);
    expect(isPlaceholderProductValue('株式会社サンプル家具')).toBe(true);
  });

  it('実在しうる値は誤検出しない', () => {
    expect(isPlaceholderProductValue('KARIMOKU')).toBe(false);
    expect(isPlaceholderProductValue('WU4700')).toBe(false);
    expect(isPlaceholderProductValue('https://www.karimoku.co.jp/item/WU4700')).toBe(false);
    expect(isPlaceholderProductValue(undefined)).toBe(false);
    expect(isPlaceholderProductValue('')).toBe(false);
  });
});

describe('buildAgentCatalog', () => {
  const base = (over: Partial<FurnitureCatalogItem>): FurnitureCatalogItem =>
    ({ id: 'i1', name: 'chair_1', type: 'Chair', url: 'https://cdn/x.glb', ...over }) as FurnitureCatalogItem;

  it('プレースホルダ商品は候補ごと除外する（価格だけ残さない）', () => {
    // メーカー/品番/URL がサンプルなら、その「価格」も架空の数字でしかない。項目単位で伏せると
    // 「正体不明の ¥24,800 の行」だけが見積に残り、かえって悪化する。
    const out = buildAgentCatalog([
      base({ brand: '（例）サンプル・ファニチャー', modelNumber: 'SAMPLE-CHAIR', productUrl: 'https://example.com/c', price: 24800 }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('実データはそのまま通す', () => {
    const out = buildAgentCatalog([
      base({ brand: 'KARIMOKU', modelNumber: 'WU4700', productUrl: 'https://www.karimoku.co.jp/item/WU4700', price: 98000 }),
    ]);
    expect(out[0].brand).toBe('KARIMOKU');
    expect(out[0].modelNumber).toBe('WU4700');
    expect(out[0].productUrl).toBe('https://www.karimoku.co.jp/item/WU4700');
  });

  it('価格が無くても実在カタログ家具は候補に残す', () => {
    // サンプル価格を既定オフにした結果、価格を持つのはユーザーアップロードだけになった。
    // ここで除外すると公式カタログの提案が全滅するため、価格なしでも候補に含める（#8）。
    const out = buildAgentCatalog([base({ name: 'sofa_a' })]);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBeUndefined();
  });

  it('名前が違えば別候補として残す（重複排除で潰さない）', () => {
    // アップロード家具は type が一律「アップロード」で品番/URLも空になりがち。name をキーに
    // 含めないと2件目以降が落ち、最初の1件しか推薦できなくなる。
    const out = buildAgentCatalog([
      base({ id: 'a', name: 'chair_a', type: 'アップロード', brand: 'カリモク', price: 98000 }),
      base({ id: 'b', name: 'chair_b', type: 'アップロード', brand: 'カリモク', price: 98000 }),
    ]);
    expect(out).toHaveLength(2);
  });
});
