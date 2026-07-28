import { describe, it, expect } from 'vitest';
import { parseVisionWebDetection, buildVisionFindingsText, hasVisionSignal } from './visionProductSearch.js';

describe('parseVisionWebDetection', () => {
  it('壊れた応答でも空を返す', () => {
    const f = parseVisionWebDetection({});
    expect(f.pages).toEqual([]);
    expect(hasVisionSignal(f)).toBe(false);
  });

  it('webDetection を抽出しエンティティはスコア降順', () => {
    const f = parseVisionWebDetection({
      responses: [
        {
          webDetection: {
            bestGuessLabels: [{ label: 'grey fabric sofa' }],
            webEntities: [
              { description: 'Sofa', score: 0.5 },
              { description: 'Couch', score: 0.9 },
              { description: '', score: 1.0 },
            ],
            pagesWithMatchingImages: [
              { url: 'https://example.com/p1', pageTitle: '商品A' },
              { url: 'not-a-url', pageTitle: 'x' },
            ],
            visuallySimilarImages: [{ url: 'https://img/1.jpg' }],
          },
        },
      ],
    });
    expect(f.bestGuess).toEqual(['grey fabric sofa']);
    expect(f.entities[0]).toBe('Couch'); // スコア降順
    expect(f.entities).not.toContain(''); // 空は除外
    // 非URLは除外。matchRank は一致画像が無いので 0。
    expect(f.pages).toEqual([{ title: '商品A', url: 'https://example.com/p1', imageUrl: undefined, matchRank: 0 }]);
    expect(f.similarImageUrls).toEqual(['https://img/1.jpg']);
    expect(hasVisionSignal(f)).toBe(true);
  });

  /**
   * 260728 クライアント要望「画像を選ぶと該当商品を追加できるように」。
   * 「どの画像がどのページに載っているか」が取れていないと、画像を選んでも
   * 商品ページに辿り着けず、逆画像検索をやり直すしかなくなる（遅く・高く・不正確）。
   */
  it('一致画像URLをページに紐付ける（完全一致を優先し、無ければ部分一致）', () => {
    const f = parseVisionWebDetection({
      responses: [
        {
          webDetection: {
            pagesWithMatchingImages: [
              {
                url: 'https://shop.example.jp/item/1',
                pageTitle: 'ソファ',
                partialMatchingImages: [{ url: 'https://img.example.jp/partial.jpg' }],
                fullMatchingImages: [{ url: 'https://img.example.jp/full.jpg' }],
              },
              {
                url: 'https://shop.example.jp/item/2',
                pageTitle: 'チェア',
                partialMatchingImages: [{ url: 'https://img.example.jp/only-partial.jpg' }],
              },
              { url: 'https://shop.example.jp/item/3', pageTitle: '画像なし' },
              {
                url: 'https://shop.example.jp/item/4',
                pageTitle: '不正URL',
                fullMatchingImages: [{ url: 'javascript:alert(1)' }],
              },
            ],
          },
        },
      ],
    });
    expect(f.pages[0].imageUrl).toBe('https://img.example.jp/full.jpg'); // 完全一致が優先
    expect(f.pages[1].imageUrl).toBe('https://img.example.jp/only-partial.jpg'); // 部分一致で代替
    expect(f.pages[2].imageUrl).toBeUndefined(); // 画像が無くてもページは残る
    expect(f.pages[3].imageUrl).toBeUndefined(); // http(s) でないURLは採用しない
    expect(f.pages).toHaveLength(4);
  });

  it('findings テキストは実在ページURLを含む', () => {
    const t = buildVisionFindingsText({
      bestGuess: ['sofa'],
      entities: ['Couch'],
      pages: [{ title: '商品A', url: 'https://example.com/p1' }],
      similarImageUrls: [],
    });
    expect(t).toContain('https://example.com/p1');
    expect(t).toContain('sofa');
  });

  it('手掛かりが無ければその旨のテキスト', () => {
    const t = buildVisionFindingsText({ bestGuess: [], entities: [], pages: [], similarImageUrls: [] });
    expect(t).toContain('手掛かり');
  });
});
