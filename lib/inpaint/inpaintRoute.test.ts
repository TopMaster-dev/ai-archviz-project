import { describe, it, expect } from 'vitest';
import { isRemovalInstruction, chooseAreaEditRoute } from './inpaintRoute.js';

describe('isRemovalInstruction（削除意図の判定・純関数）', () => {
  it('日本語の削除表現を拾う', () => {
    for (const t of [
      '範囲内の椅子を消してください',
      'この椅子を消す',
      'テーブルを削除',
      '観葉植物を除去して',
      '手前のソファを取り除く',
      '柱を撤去してほしい',
      'この小物をなくして',
    ]) {
      expect(isRemovalInstruction(t)).toBe(true);
    }
  });
  it('英語の削除表現を拾う', () => {
    for (const t of ['remove the chair', 'please erase this', 'delete the lamp', 'get rid of the plant']) {
      expect(isRemovalInstruction(t)).toBe(true);
    }
  });
  it('削除以外（配置・変更・素材）は false', () => {
    for (const t of [
      'ここに木製の椅子を置いて',
      'ソファを北欧風に差し替えて',
      '壁を白い塗装に変えて',
      '窓の外を昼にして',
      'add a plant here',
      '',
    ]) {
      expect(isRemovalInstruction(t)).toBe(false);
    }
  });
});

describe('chooseAreaEditRoute（経路判定・純関数）', () => {
  it('参照画像なしの削除 → inpaint-remove', () => {
    expect(
      chooseAreaEditRoute({ instruction: '範囲内の椅子を消して', hasReferenceImage: false, unionCoverage: 0.1 })
    ).toBe('inpaint-remove');
  });
  it('参照画像あり（特定商品の差し替え/配置）は当面 Gemini（フェーズ1の生成エンジンは参照画像非対応）', () => {
    expect(
      chooseAreaEditRoute({ instruction: 'このソファに差し替えて', hasReferenceImage: true, unionCoverage: 0.1 })
    ).toBe('gemini');
    // 参照画像＋削除語という矛盾入力でも、参照画像がある時点で Gemini（幻覚生成を避ける）
    expect(
      chooseAreaEditRoute({ instruction: '椅子を消して', hasReferenceImage: true, unionCoverage: 0.1 })
    ).toBe('gemini');
  });
  it('テキスト配置・置換・素材変更 → inpaint-generate', () => {
    expect(
      chooseAreaEditRoute({ instruction: 'ここに木製の椅子を置いて', hasReferenceImage: false, unionCoverage: 0.15 })
    ).toBe('inpaint-generate');
    expect(
      chooseAreaEditRoute({ instruction: '壁を白に変えて', hasReferenceImage: false, unionCoverage: 0.2 })
    ).toBe('inpaint-generate');
  });
  it('実質全画面（被覆≥0.85）は Gemini へ', () => {
    expect(
      chooseAreaEditRoute({ instruction: '椅子を消して', hasReferenceImage: false, unionCoverage: 0.9 })
    ).toBe('gemini');
    expect(
      chooseAreaEditRoute({ instruction: '全体を明るく', hasReferenceImage: false, unionCoverage: 0.95 })
    ).toBe('gemini');
  });
  it('境界: 0.85=gemini, 0.849=inpaint', () => {
    expect(
      chooseAreaEditRoute({ instruction: '椅子を消して', hasReferenceImage: false, unionCoverage: 0.85 })
    ).toBe('gemini');
    expect(
      chooseAreaEditRoute({ instruction: '椅子を消して', hasReferenceImage: false, unionCoverage: 0.849 })
    ).toBe('inpaint-remove');
  });
});
