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
    expect(f.pages).toEqual([{ title: '商品A', url: 'https://example.com/p1' }]); // 非URLは除外
    expect(f.similarImageUrls).toEqual(['https://img/1.jpg']);
    expect(hasVisionSignal(f)).toBe(true);
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
