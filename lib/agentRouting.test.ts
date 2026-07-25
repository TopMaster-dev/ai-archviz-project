import { describe, it, expect } from 'vitest';
import { analyzeAgentRequest, DEFAULT_AGENT_ROUTE_THRESHOLDS } from './agentRouting.js';

const base = { text: '', fileCount: 0, totalAttachmentBytes: 0, hasNonImageDoc: false, hasImage: false };

describe('analyzeAgentRequest（ルールベース振り分け）', () => {
  it('軽いテキスト相談は Flash・検索OFF', () => {
    const d = analyzeAgentRequest({ ...base, text: 'この部屋の雰囲気の感想を教えて' });
    expect(d.tier).toBe('flash');
    expect(d.useSearch).toBe(false);
  });

  it('検索意図の語があれば検索ON（モデルは軽ければ Flash のまま）', () => {
    const d = analyzeAgentRequest({ ...base, text: 'このソファに似た商品を探して' });
    expect(d.useSearch).toBe(true);
    expect(d.tier).toBe('flash');
  });

  it('商品名（家具語）だけでも検索ON', () => {
    expect(analyzeAgentRequest({ ...base, text: 'おしゃれなチェアある？' }).useSearch).toBe(true);
  });

  it('大容量の添付は Pro', () => {
    const d = analyzeAgentRequest({ ...base, text: '見て', totalAttachmentBytes: 5 * 1024 * 1024, fileCount: 1, hasImage: true });
    expect(d.tier).toBe('pro');
  });

  it('ファイル数が多いと Pro', () => {
    const d = analyzeAgentRequest({ ...base, text: '確認して', fileCount: 3 });
    expect(d.tier).toBe('pro');
  });

  it('画像以外の書類（PDF等）添付は Pro', () => {
    const d = analyzeAgentRequest({ ...base, text: '要約して', fileCount: 1, hasNonImageDoc: true });
    expect(d.tier).toBe('pro');
  });

  it('複雑意図の語（比較/検討）は Pro', () => {
    expect(analyzeAgentRequest({ ...base, text: '2案を比較して検討したい' }).tier).toBe('pro');
  });

  it('長文の相談は Pro', () => {
    const d = analyzeAgentRequest({ ...base, text: 'あ'.repeat(DEFAULT_AGENT_ROUTE_THRESHOLDS.proTextLength + 1) });
    expect(d.tier).toBe('pro');
  });

  it('reasons は必ず理由を含む（ログ用）', () => {
    expect(analyzeAgentRequest({ ...base, text: 'こんにちは' }).reasons.length).toBeGreaterThan(0);
  });
});
