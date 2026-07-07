import { describe, it, expect } from 'vitest';
import { runAiEdit } from './aiEditCore.js';

/**
 * runAiEdit（本番 api/ai-edit.ts と 開発 vite.config.ts が共有する中核）の入力バリデーション契約。
 * ここで検証するのはネットワーク前に早期リターンするケースのみ（generateGeminiImageEdit を叩かない）。
 * これにより dev/prod で同一の 400/エラー文言を返すことを保証する（260707）。
 */
describe('runAiEdit 入力バリデーション（ネットワーク前・dev/prod共通契約）', () => {
  const KEY = 'test-key';
  const IMG = 'data:image/png;base64,AAA';

  it('baseImage 無し → 400', async () => {
    const r = await runAiEdit(KEY, {});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.status).toBe(400);
      expect(r.error).toContain('baseImage');
    }
  });

  it('baseImage のみ・入力ゼロ → 400（画像かテキストを1つ以上）', async () => {
    const r = await runAiEdit(KEY, { baseImage: IMG });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.status).toBe(400);
      expect(r.error).toContain('1つ以上');
    }
  });

  it('エリア編集の入力はあるが範囲選択ゼロ → 400（範囲選択を1つ以上）', async () => {
    const r = await runAiEdit(KEY, {
      baseImage: IMG,
      objects: [{ id: 'o1', imageDataUrl: 'data:image/png;base64,BBB', placements: [], memo: '', placementMemos: [] }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.status).toBe(400);
      expect(r.error).toContain('範囲選択');
    }
  });
});
