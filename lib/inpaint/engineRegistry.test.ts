import { describe, it, expect, afterEach } from 'vitest';
import { resolveInpaintEngine, getEngineApiKey } from './engineRegistry.js';
import { briaEraserEngine, briaRemoveBgEngine } from './briaEngine.js';
import { replicateRemoveEngine, replicateCutoutEngine } from './replicateEngine.js';

/**
 * エンジン解決（env で候補切替）とプロバイダ別APIキー解決（Replicate/Bria）を固定する（260713）。
 * ネットワークは張らず、登録・env 分岐・trim だけを検証する純度の高いテスト。
 */
describe('engineRegistry: エンジン解決 + プロバイダ別キー', () => {
  const KEYS = ['INPAINT_REMOVE_ENGINE', 'INPAINT_CUTOUT_ENGINE', 'REPLICATE_API_TOKEN', 'BRIA_API_TOKEN'];
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const k of Object.keys(saved)) delete saved[k];
  });

  it('既定は Replicate、env で Bria に切り替えられる', () => {
    setEnv('INPAINT_REMOVE_ENGINE', undefined);
    expect(resolveInpaintEngine('remove')?.id).toBe(replicateRemoveEngine.id);
    setEnv('INPAINT_CUTOUT_ENGINE', undefined);
    expect(resolveInpaintEngine('cutout')?.id).toBe(replicateCutoutEngine.id);

    setEnv('INPAINT_REMOVE_ENGINE', 'bria:eraser');
    expect(resolveInpaintEngine('remove')?.id).toBe('bria:eraser');
    setEnv('INPAINT_CUTOUT_ENGINE', 'bria:remove-background');
    expect(resolveInpaintEngine('cutout')?.id).toBe('bria:remove-background');
  });

  it('未知のエンジンIDは null（クラッシュしない）', () => {
    setEnv('INPAINT_REMOVE_ENGINE', 'nope:nope');
    expect(resolveInpaintEngine('remove')).toBeNull();
  });

  it('getEngineApiKey はプロバイダごとの env を読み、前後空白を trim する', () => {
    setEnv('REPLICATE_API_TOKEN', '  r8_abc  ');
    setEnv('BRIA_API_TOKEN', '\nbria_xyz\n');
    expect(getEngineApiKey(replicateRemoveEngine)).toBe('r8_abc'); // 既定=REPLICATE_API_TOKEN
    expect(getEngineApiKey(briaEraserEngine)).toBe('bria_xyz'); // apiKeyEnv=BRIA_API_TOKEN
    expect(getEngineApiKey(briaRemoveBgEngine)).toBe('bria_xyz');
  });

  it('キー未設定なら空文字（runInpaint 側で 500 → フェイルソフト）', () => {
    setEnv('BRIA_API_TOKEN', undefined);
    expect(getEngineApiKey(briaEraserEngine)).toBe('');
  });

  it('Bria エンジンの op 対応が正しい', () => {
    expect(briaEraserEngine.apiKeyEnv).toBe('BRIA_API_TOKEN');
    expect(briaEraserEngine.supports).toContain('remove');
    expect(briaRemoveBgEngine.supports).toContain('cutout');
  });
});
