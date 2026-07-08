import { describe, it, expect } from 'vitest';
import { runAiAnalyze } from './aiAnalyzeCore.js';

/**
 * runAiAnalyze（/api/ai-edit の analyze:true 分岐の中核・遮蔽判定つき事前解析）の入力バリデーション契約。
 * ネットワーク前に早期リターンするケースのみ検証（Gemini を叩かない）。dev/prod で同一挙動を保証（260709）。
 */
describe('runAiAnalyze 入力バリデーション（ネットワーク前・dev/prod共通契約）', () => {
  const KEY = 'test-key';
  const IMG = 'data:image/png;base64,AAA';

  it('baseImage 無し → 400', async () => {
    const r = await runAiAnalyze(KEY, {});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.status).toBe(400);
      expect(r.error).toContain('baseImage');
    }
  });

  it('baseImage はあるが解析対象（objects）ゼロ → success・空を返す（呼び出し側は非クロップで続行）', async () => {
    const r = await runAiAnalyze(KEY, { baseImage: IMG, objects: [] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.narratives).toEqual({});
      expect(r.occluded).toEqual({});
    }
  });
});
