import { describe, it, expect } from 'vitest';
import { mergeUploadMetadata } from './uploadsMeta.js';

/**
 * 260728 クライアント #6:「ユーザーがアップロードしたデータは、変更内容をアップロード情報自体を書き換える」。
 * metadata は全置換更新なので、マージが他キーを落とさないことが最重要。
 */
describe('mergeUploadMetadata', () => {
  const base = {
    name: '旧名称',
    brand: '旧メーカー',
    price: 1000,
    // 別経路が書く重要キー。ここが消えるとサムネイル再生成や寸法の再計測が起きる。
    thumbnailUrl: 'https://x/thumb.png',
    footprint2d: { widthMm: 800, depthMm: 600 },
    modelUnitScale: 0.001,
    category: 'Wall',
  };

  it('無関係なキーを絶対に落とさない', () => {
    const out = mergeUploadMetadata(base, { name: '新名称' });
    expect(out.thumbnailUrl).toBe('https://x/thumb.png');
    expect(out.footprint2d).toEqual({ widthMm: 800, depthMm: 600 });
    expect(out.modelUnitScale).toBe(0.001);
    expect(out.category).toBe('Wall');
    expect(out.name).toBe('新名称');
  });

  it('undefined の項目は変更しない（部分更新）', () => {
    const out = mergeUploadMetadata(base, { brand: undefined });
    expect(out.brand).toBe('旧メーカー');
  });

  it('空文字は未設定へ戻す（キー削除）', () => {
    const out = mergeUploadMetadata(base, { brand: '   ' });
    expect('brand' in out).toBe(false);
    expect(out.name).toBe('旧名称'); // 他は無傷
  });

  it('価格は0以下・非有限で削除、正数で設定', () => {
    expect('price' in mergeUploadMetadata(base, { price: 0 })).toBe(false);
    expect('price' in mergeUploadMetadata(base, { price: -5 })).toBe(false);
    expect('price' in mergeUploadMetadata(base, { price: Number.NaN })).toBe(false);
    expect(mergeUploadMetadata(base, { price: 2500 }).price).toBe(2500);
  });

  it('前後の空白を落として保存する', () => {
    expect(mergeUploadMetadata(base, { modelNumber: '  ABC-1  ' }).modelNumber).toBe('ABC-1');
  });

  it('URL も同じ規則で扱える', () => {
    expect(mergeUploadMetadata(base, { productUrl: 'https://a/b' }).productUrl).toBe('https://a/b');
    expect('productUrl' in mergeUploadMetadata({ ...base, productUrl: 'https://a' }, { productUrl: '' })).toBe(false);
  });

  it('入力オブジェクトを破壊しない', () => {
    const snapshot = JSON.stringify(base);
    mergeUploadMetadata(base, { name: 'x', price: 9 });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
