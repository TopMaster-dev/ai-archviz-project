import { describe, it, expect } from 'vitest';
import { parseGroundingMetadata } from './gemini.js';

/**
 * 260728 クライアント要望③「検索結果一覧ではなく個別商品URLを提示する」の土台。
 *
 * Gemini の Web検索グラウンディング応答には、モデルが実際に参照した「実在URL」が入っているが、
 * 従来はテキスト部分だけ読んで捨てていた。モデルに書かせたURLは作文でありほぼ404になるため、
 * ここで取り出す実URLだけを提示に使う。応答形状は揺れるので、欠けていても落ちないことが重要。
 */
describe('parseGroundingMetadata', () => {
  const wrap = (groundingMetadata: unknown) => ({ candidates: [{ groundingMetadata }] });

  it('groundingChunks から実在URLとタイトルを取り出す', () => {
    const r = parseGroundingMetadata(
      wrap({
        groundingChunks: [
          { web: { uri: 'https://www.karimoku.co.jp/item/WU4700', title: 'カリモク WU4700' } },
          { web: { uri: 'https://example.jp/p/2', title: '' } },
        ],
      }),
    );
    expect(r.sources).toHaveLength(2);
    expect(r.sources[0]).toEqual({ uri: 'https://www.karimoku.co.jp/item/WU4700', title: 'カリモク WU4700' });
    // タイトルが空ならURLで代用（表示で空欄にならないように）
    expect(r.sources[1].title).toBe('https://example.jp/p/2');
  });

  it('http(s) 以外や壊れたチャンクは捨てる', () => {
    const r = parseGroundingMetadata(
      wrap({
        groundingChunks: [
          { web: { uri: 'javascript:alert(1)' } },
          { web: { uri: 'data:text/html,x' } },
          { web: {} },
          {},
          null,
          { web: { uri: 'https://ok.example/p' } },
        ],
      }),
    );
    expect(r.sources.map((s) => s.uri)).toEqual(['https://ok.example/p']);
  });

  it('同一URLは重複排除する', () => {
    const r = parseGroundingMetadata(
      wrap({
        groundingChunks: [
          { web: { uri: 'https://a.example/p', title: 'A' } },
          { web: { uri: 'https://a.example/p', title: 'A' } },
        ],
      }),
    );
    expect(r.sources).toHaveLength(1);
  });

  it('検索クエリと検索候補HTML（規約上の表示義務）を取り出す', () => {
    const r = parseGroundingMetadata(
      wrap({
        webSearchQueries: ['カリモク ソファ 価格', ''],
        searchEntryPoint: { renderedContent: '<div>検索候補</div>' },
      }),
    );
    expect(r.searchQueries).toEqual(['カリモク ソファ 価格']); // 空文字は除外
    expect(r.searchSuggestionHtml).toBe('<div>検索候補</div>');
  });

  it('groundingMetadata が無い/壊れていても落ちない', () => {
    expect(parseGroundingMetadata(undefined).sources).toEqual([]);
    expect(parseGroundingMetadata({}).sources).toEqual([]);
    expect(parseGroundingMetadata(wrap(null)).sources).toEqual([]);
    expect(parseGroundingMetadata(wrap({ groundingChunks: 'nope' })).sources).toEqual([]);
    expect(parseGroundingMetadata(wrap({})).searchSuggestionHtml).toBeUndefined();
  });

  it('出典が多すぎる応答でも上限で打ち切る（トークン/描画の暴走防止）', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({ web: { uri: `https://x.example/${i}` } }));
    expect(parseGroundingMetadata(wrap({ groundingChunks: chunks })).sources.length).toBeLessThanOrEqual(12);
  });
});
