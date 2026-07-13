import { describe, it, expect, vi } from 'vitest';
import { runInpaint } from './inpaintCore.js';
import type { InpaintEngine } from './inpaintTypes.js';

const mockEngine = (over?: Partial<InpaintEngine>): InpaintEngine => ({
  id: 'mock',
  supports: ['remove', 'generate'],
  approxCostUsd: 0.001,
  run: vi.fn(async () => ({ imageDataUrl: 'data:image/png;base64,OUT', engine: 'mock', costUsd: 0.001 })),
  ...over,
});

const body = {
  imageDataUrl: 'data:image/png;base64,IMG',
  maskDataUrl: 'data:image/png;base64,MASK',
  op: 'remove' as const,
};

describe('runInpaint（検証＋委譲＋フェイルソフト）', () => {
  it('正常: エンジンを呼んで結果を返す', async () => {
    const eng = mockEngine();
    const r = await runInpaint(eng, 'key', body);
    expect(r.success).toBe(true);
    if (r.success) expect(r.result.imageDataUrl).toBe('data:image/png;base64,OUT');
    expect(eng.run).toHaveBeenCalledOnce();
  });

  it('エンジン未設定 → 501', async () => {
    expect(await runInpaint(null, 'key', body)).toMatchObject({ success: false, status: 501 });
  });

  it('APIキー無し → 500', async () => {
    expect(await runInpaint(mockEngine(), '', body)).toMatchObject({ success: false, status: 500 });
  });

  it('image / mask 欠如 → 400', async () => {
    expect(await runInpaint(mockEngine(), 'k', { maskDataUrl: 'm', op: 'remove' })).toMatchObject({
      success: false,
      status: 400,
    });
    expect(await runInpaint(mockEngine(), 'k', { imageDataUrl: 'i', op: 'remove' })).toMatchObject({
      success: false,
      status: 400,
    });
  });

  it('不正な op → 400', async () => {
    expect(await runInpaint(mockEngine(), 'k', { ...body, op: 'foo' })).toMatchObject({
      success: false,
      status: 400,
    });
  });

  it('エンジンが未対応の op → 400', async () => {
    const eng = mockEngine({ supports: ['generate'] });
    expect(await runInpaint(eng, 'k', { ...body, op: 'remove' })).toMatchObject({
      success: false,
      status: 400,
    });
    expect(eng.run).not.toHaveBeenCalled();
  });

  it('generate で prompt も参照画像も無い → 400', async () => {
    expect(
      await runInpaint(mockEngine(), 'k', { imageDataUrl: 'i', maskDataUrl: 'm', op: 'generate' })
    ).toMatchObject({ success: false, status: 400 });
  });

  it('generate は prompt があれば実行', async () => {
    const eng = mockEngine();
    const r = await runInpaint(eng, 'k', { imageDataUrl: 'i', maskDataUrl: 'm', op: 'generate', prompt: '椅子' });
    expect(r.success).toBe(true);
  });

  it('参照画像が来たが engine が参照非対応 → 400（幻覚を返さず拒否・クライアントは Gemini へ）', async () => {
    const eng = mockEngine({ acceptsReference: false });
    const r = await runInpaint(eng, 'k', {
      imageDataUrl: 'i',
      maskDataUrl: 'm',
      op: 'generate',
      prompt: '差し替え',
      referenceImageDataUrl: 'data:image/png;base64,REF',
    });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(eng.run).not.toHaveBeenCalled();
  });

  it('参照画像対応エンジン（acceptsReference:true）なら参照付きでも実行', async () => {
    const eng = mockEngine({ acceptsReference: true });
    const r = await runInpaint(eng, 'k', {
      imageDataUrl: 'i',
      maskDataUrl: 'm',
      op: 'generate',
      prompt: '差し替え',
      referenceImageDataUrl: 'data:image/png;base64,REF',
    });
    expect(r.success).toBe(true);
  });

  it('エンジンが throw → 502 でフェイルソフト（クライアントが Gemini へ）', async () => {
    const eng = mockEngine({
      run: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await runInpaint(eng, 'k', body)).toMatchObject({ success: false, status: 502 });
  });

  it('cutout: マスク不要（image だけで実行）', async () => {
    const eng = mockEngine({ supports: ['cutout'] });
    const r = await runInpaint(eng, 'k', { imageDataUrl: 'data:image/png;base64,PROD', op: 'cutout' });
    expect(r.success).toBe(true);
    expect(eng.run).toHaveBeenCalledOnce();
  });

  it('remove/generate はマスク欠如で 400（範囲内編集はマスク必須）', async () => {
    const eng = mockEngine();
    expect(await runInpaint(eng, 'k', { imageDataUrl: 'i', op: 'remove' })).toMatchObject({
      success: false,
      status: 400,
    });
  });

  it('relight: 背景画像が無ければ 400', async () => {
    const eng = mockEngine({ supports: ['relight'] });
    expect(await runInpaint(eng, 'k', { imageDataUrl: 'i', op: 'relight' })).toMatchObject({
      success: false,
      status: 400,
    });
    expect(eng.run).not.toHaveBeenCalled();
  });

  it('relight: 背景画像があれば実行', async () => {
    const eng = mockEngine({ supports: ['relight'] });
    const r = await runInpaint(eng, 'k', {
      imageDataUrl: 'i',
      op: 'relight',
      backgroundImageDataUrl: 'data:image/png;base64,BG',
    });
    expect(r.success).toBe(true);
  });

  it('未知の op（foo）は 400', async () => {
    expect(await runInpaint(mockEngine(), 'k', { imageDataUrl: 'i', maskDataUrl: 'm', op: 'foo' })).toMatchObject({
      success: false,
      status: 400,
    });
  });
});
