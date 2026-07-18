import { describe, it, expect } from 'vitest';
import { dataUrlTransmitBytes, compressDataUrlToBudget } from './compressDataUrl.js';

describe('dataUrlTransmitBytes', () => {
  it('data URL の文字数（≈送信バイト）を返す', () => {
    const u = 'data:image/png;base64,AAAA';
    expect(dataUrlTransmitBytes(u)).toBe(u.length);
  });
  it('空文字は 0', () => {
    expect(dataUrlTransmitBytes('')).toBe(0);
    // @ts-expect-error 実行時の防御（undefined でも落ちない）
    expect(dataUrlTransmitBytes(undefined)).toBe(0);
  });
});

// 注: 予算超過→canvas/Image 再エンコード経路は jsdom が画像デコードしないため単体テスト不可（要ライブ確認）。
// ここでは canvas を触らない「予算内は無変換で返す（＝PNG/透過を維持）」パスのみ担保する。
describe('compressDataUrlToBudget（予算内は無変換＝PNGを維持）', () => {
  it('予算内の PNG data URL はバイト一致でそのまま返す（再エンコードしない＝PNGのまま）', async () => {
    const smallPng = 'data:image/png;base64,' + 'A'.repeat(100);
    const out = await compressDataUrlToBudget(smallPng, { maxBytes: 1000 });
    expect(out).toBe(smallPng);
    expect(out.startsWith('data:image/png')).toBe(true);
  });

  it('空文字はそのまま返す', async () => {
    expect(await compressDataUrlToBudget('', { maxBytes: 1000 })).toBe('');
  });

  it('しきい値ちょうど（<=maxBytes）は無変換', async () => {
    const u = 'data:image/png;base64,' + 'B'.repeat(10);
    const out = await compressDataUrlToBudget(u, { maxBytes: u.length });
    expect(out).toBe(u);
  });
});
