import { describe, it, expect, beforeEach } from 'vitest';
import {
  generatedSizeKey,
  rememberGeneratedSize,
  recallGeneratedSize,
  clearGeneratedSizeMemory,
} from './generatedSizeMemory.js';
import { MEASURED_GEMINI_2K_SIZES } from './printExportSpec.js';

/**
 * 【260821 クライアント指摘】写真PJのエリア編集で拡大が残る件。
 *
 * 版1の幾何が生成結果と一致していないと、モデルへの入力と要求出力の解像度が食い違い、
 * かつ生成結果を版寸法へ戻す際の中央クロップが編集ごとに蓄積する。
 *
 * 260820 の修正は取り込み時にしか効かず、既存プロジェクトは版1が古いまま残った。
 * また実測できた比率は 16:9 だけで、スマホ写真に多い 4:3 / 3:2 は未実測だった。
 * そこで「生成が成功したら実寸を覚える」方式にして、人手の測定を待たずに全比率を揃える。
 */
describe('生成寸法の記憶', () => {
  beforeEach(() => clearGeneratedSizeMemory());

  it('覚えた寸法を引き当てる', () => {
    const k = generatedSizeKey('2K', '4:3');
    expect(recallGeneratedSize(k, '4:3')).toBeNull(); // 4:3 は未実測なので初回は無い
    rememberGeneratedSize(k, 2368, 1792, 'gemini-3-pro-image');
    expect(recallGeneratedSize(k, '4:3')).toMatchObject({ w: 2368, h: 1792 });
  });

  it('覚えていない比率は実測の定数表へ落ちる', () => {
    // 16:9 は定数表にあるので、一度も生成していなくても引ける。
    const k = generatedSizeKey('2K', '16:9');
    expect(recallGeneratedSize(k, '16:9')).toMatchObject(MEASURED_GEMINI_2K_SIZES['16:9']!);
  });

  it('モデルを変えると次の生成で上書きされる（案1でモデル固定した場合）', () => {
    const k = generatedSizeKey('2K', '16:9');
    rememberGeneratedSize(k, 2752, 1536, 'gemini-3-pro-image-preview');
    expect(recallGeneratedSize(k, '16:9')).toMatchObject({ w: 2752, h: 1536 });
    rememberGeneratedSize(k, 2688, 1536, 'gemini-3-pro-image');
    expect(recallGeneratedSize(k, '16:9')).toMatchObject({ w: 2688, h: 1536, model: 'gemini-3-pro-image' });
  });

  it('画像サイズが違えば別扱い（1K と 2K を混同しない）', () => {
    rememberGeneratedSize(generatedSizeKey('2K', '16:9'), 2752, 1536);
    rememberGeneratedSize(generatedSizeKey('1K', '16:9'), 1376, 768);
    expect(recallGeneratedSize(generatedSizeKey('2K', '16:9'), '16:9')).toMatchObject({ w: 2752, h: 1536 });
    expect(recallGeneratedSize(generatedSizeKey('1K', '16:9'), '16:9')).toMatchObject({ w: 1376, h: 768 });
  });

  it('壊れた寸法は覚えない（キャンバス生成ごと失敗するのを防ぐ）', () => {
    const k = generatedSizeKey('2K', '3:2');
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [NaN, 100],
      [100, NaN],
      [-5, -5],
      [Infinity, 100],
    ] as const) {
      rememberGeneratedSize(k, w as number, h as number);
    }
    expect(recallGeneratedSize(k, '3:2')).toBeNull();
  });

  it('保存が使えない環境でも例外を投げない', () => {
    // localStorage が無い/失敗する環境でも、生成そのものは止めない契約。
    expect(() => rememberGeneratedSize(generatedSizeKey('2K', '1:1'), 100, 100)).not.toThrow();
    expect(() => recallGeneratedSize(generatedSizeKey('2K', '1:1'), '1:1')).not.toThrow();
  });
});
