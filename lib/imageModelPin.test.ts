import { describe, it, expect } from 'vitest';
import { isUnstableModelId, GEMINI_IMAGE_MODEL_DEFAULT } from './gemini.js';

/**
 * 【案1・260818】画像モデルの固定。
 *
 * 既定は preview 版で、提供元（Google）の更新によりコードを1行も変えずに
 * 生成の傾向が変わりうる。260817「構図が若干拡大される」の調査では、
 * 原因が手段2 と確定するまで最後まで候補に残った。
 *
 * 本番は env GEMINI_IMAGE_MODEL に安定版を設定して固定する（コード変更不要）。
 * このテストは「preview を preview と認識できること」を担保する。
 * 誤認すると管理画面の警告が出ず、未固定のまま運用され続ける。
 */

describe('preview版の判定', () => {
  it('preview 版を preview と判定する', () => {
    for (const id of [
      'gemini-3-pro-image-preview',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.5-flash-image-preview',
      'imagen-4.0-generate-preview-06-06',
    ]) {
      expect(isUnstableModelId(id), id).toBe(true);
    }
  });

  it('experimental / -exp も不安定と判定する', () => {
    for (const id of ['gemini-2.0-flash-exp', 'gemini-experimental-image']) {
      expect(isUnstableModelId(id), id).toBe(true);
    }
  });

  it('安定版を preview と誤判定しない（誤検知で警告が常時出るのを防ぐ）', () => {
    for (const id of [
      'gemini-3-pro-image',
      'gemini-2.5-flash-image',
      'imagen-4.0-generate-001',
      'gemini-2.0-flash',
    ]) {
      expect(isUnstableModelId(id), id).toBe(false);
    }
  });

  it('大文字小文字を問わない', () => {
    expect(isUnstableModelId('GEMINI-3-PRO-IMAGE-PREVIEW')).toBe(true);
  });

  it('空文字でも落ちない', () => {
    expect(isUnstableModelId('')).toBe(false);
  });
});

describe('現在の既定値', () => {
  it('既定は preview 版であり、固定が必要な状態だと明示できる', () => {
    /*
      安定版へ切り替えたらこの期待値は false になる。
      その時点でこのテストが赤くなるので、既定を変えたことに必ず気づける。
    */
    expect(isUnstableModelId(GEMINI_IMAGE_MODEL_DEFAULT)).toBe(true);
  });
});
