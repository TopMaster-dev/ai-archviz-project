import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateGeminiImageEdit } from './gemini.js';
import type { AiEditObjectReference } from '../types.js';

/**
 * ゴースト（二重露光）再発の恒久ガード（260710）。
 * 「画質を高める（enhanceDetail）」と「継ぎ目をなじませる（harmonize）」は単一画像パス＝Gemini へ送る画像は
 * ベース1枚だけでなければならない（2枚目を添付するとモデルが重ね焼きしてゴーストが出る）。将来 gemini.ts の
 * ゲート外に parts.push(画像) が増えても、このテストが即座に落ちて気付けるようにする。
 */

const IMG = 'data:image/png;base64,aaaa';

const objectWithImage = (): AiEditObjectReference => ({
  id: 'o1',
  imageDataUrl: IMG,
  placements: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
  memo: '',
  placementMemos: [],
});

function mockFetchCapturingBodies(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'zzzz' } }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
      text: async () => '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return bodies;
}

function imagePartCount(body: Record<string, unknown>): number {
  const contents = (body as { contents?: Array<{ parts?: Array<{ inlineData?: unknown }> }> }).contents;
  const parts = contents?.[0]?.parts ?? [];
  return parts.filter((p) => !!p.inlineData).length;
}

describe('generateGeminiImageEdit: 単一画像パスは画像1枚だけを送る（ゴースト構造的防止・260710）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('enhanceDetail=true は base 1枚のみ（見本・スタイル・オブジェクト画像を一切添付しない）', async () => {
    const bodies = mockFetchCapturingBodies();
    await generateGeminiImageEdit('key', {
      baseImageDataUrl: IMG,
      objects: [objectWithImage()],
      styleImageDataUrls: [IMG],
      qualityRefImageDataUrl: IMG,
      enhanceDetail: true,
    });
    expect(imagePartCount(bodies[0])).toBe(1);
  });

  it('harmonize=true も base 1枚のみ', async () => {
    const bodies = mockFetchCapturingBodies();
    await generateGeminiImageEdit('key', {
      baseImageDataUrl: IMG,
      objects: [objectWithImage()],
      styleImageDataUrls: [IMG],
      harmonize: true,
    });
    expect(imagePartCount(bodies[0])).toBe(1);
  });

  it('通常編集（単一画像パスでない）は base＋オブジェクト画像＝複数枚を送る（誤って単一画像化していないことの回帰ガード）', async () => {
    const bodies = mockFetchCapturingBodies();
    await generateGeminiImageEdit('key', {
      baseImageDataUrl: IMG,
      objects: [objectWithImage()],
    });
    expect(imagePartCount(bodies[0])).toBeGreaterThanOrEqual(2);
  });
});
