import { describe, it, expect } from 'vitest';
import { pickVisualCandidates, buildCandidateRecommendations } from './visionProductSearchCore.js';

/**
 * 260729 クライアント要望「見た目の一致を絶対優先」。
 *
 * 以前は候補一覧を Gemini が書いていた。だがモデルには候補ページの見た目が渡っていない
 * （タイトルとURLの文字列だけ）ので、見た目の一致を判断できるはずがなかった。
 * 現在は Vision の画像一致順からサーバが決定論的に組み立てる。ここはその順序と中身を固定する。
 */
describe('pickVisualCandidates（見た目一致で候補を選ぶ）', () => {
  const page = (url: string, matchRank: 0 | 1 | 2, imageUrl?: string) => ({
    title: url,
    url,
    imageUrl,
    matchRank,
  });

  it('完全一致を部分一致より先に出す（Vision の返却順ではなく一致度で並べる）', () => {
    const out = pickVisualCandidates(
      [page('https://a.example/1', 1), page('https://b.example/2', 2), page('https://c.example/3', 0)],
      3,
    );
    expect(out.map((p) => p.url)).toEqual([
      'https://b.example/2', // 完全一致
      'https://a.example/1', // 部分一致
      'https://c.example/3', // 一致画像なし
    ]);
  });

  it('同じ一致度なら Vision の順序を保つ（安定ソート）', () => {
    const out = pickVisualCandidates([page('https://a.example/1', 2), page('https://b.example/2', 2)], 3);
    expect(out.map((p) => p.url)).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('商品ページになり得ないホストは除く（動画・SNS）', () => {
    // 検証時、参考情報に YouTube のリンクが並んでいた。これらを商品カードにすると
    // 「商品ではないもの」が見積の候補として出てしまう。詳細の有無とは別の理由で落とす。
    const out = pickVisualCandidates(
      [
        page('https://www.youtube.com/watch?v=x', 2),
        page('https://jp.pinterest.com/pin/1', 2),
        page('https://shop.example.jp/item/1', 1),
      ],
      3,
    );
    expect(out.map((p) => p.url)).toEqual(['https://shop.example.jp/item/1']);
  });

  it('同じサイトからは1件だけ（色違い・サイズ違いで候補が埋まらないように）', () => {
    const out = pickVisualCandidates(
      [
        page('https://shop.example.jp/item/1', 2),
        page('https://shop.example.jp/item/2', 2),
        page('https://other.example.jp/item/9', 1),
      ],
      3,
    );
    expect(out.map((p) => p.url)).toEqual(['https://shop.example.jp/item/1', 'https://other.example.jp/item/9']);
  });

  it('件数は上限で切る（既定3件）', () => {
    const out = pickVisualCandidates(
      [page('https://a.jp/1', 2), page('https://b.jp/1', 2), page('https://c.jp/1', 2), page('https://d.jp/1', 2)],
      3,
    );
    expect(out).toHaveLength(3);
  });
});

describe('buildCandidateRecommendations（詳細が取れなくても候補を落とさない）', () => {
  const page = (url: string, matchRank: 0 | 1 | 2, imageUrl?: string) => ({ title: `T:${url}`, url, imageUrl, matchRank });

  it('詳細が取れたページは確認済み・値入りで出す', () => {
    const out = buildCandidateRecommendations(
      [page('https://shop.jp/1', 2, 'https://img.jp/a.jpg')],
      [
        {
          requestedUrl: 'https://shop.jp/1',
          finalUrl: 'https://shop.jp/1?ref=x',
          name: 'ソファA',
          brand: 'カリモク',
          sku: 'K-1',
          price: 120000,
          source: 'json-ld',
        } as any,
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0].verified).toBe(true);
    expect(out[0].name).toBe('ソファA');
    expect(out[0].price).toBe(120000);
    expect(out[0].productUrl).toBe('https://shop.jp/1?ref=x'); // 到達確認済みの最終URL
  });

  it('詳細が取れなくても落とさず、未確認・空欄で出す（要望の核心）', () => {
    const out = buildCandidateRecommendations(
      [page('https://blog.jp/1', 2, 'https://img.jp/b.jpg')],
      [
        {
          requestedUrl: 'https://blog.jp/1',
          finalUrl: 'https://blog.jp/1',
          name: '',
          pageTitle: 'この椅子の紹介',
          source: 'unresolved',
        } as any,
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0].verified).toBe(false);
    expect(out[0].name).toBe('この椅子の紹介'); // ページタイトルを手掛かりに出す
    expect(out[0].price).toBeUndefined(); // 推測しない
    expect(out[0].modelNumber).toBeUndefined();
    expect(out[0].productUrl).toBe('https://blog.jp/1'); // リンクは残す
  });

  it('サムネイルは「Vision が一致と判断した画像」を優先する', () => {
    // ページの og:image は別カット・別商品のことがある。利用者が似ているか判断する材料は
    // あくまで「一致した画像」なので、そちらを優先しなければ判断材料にならない。
    const out = buildCandidateRecommendations(
      [page('https://shop.jp/1', 2, 'https://img.jp/matched.jpg')],
      [
        {
          requestedUrl: 'https://shop.jp/1',
          finalUrl: 'https://shop.jp/1',
          name: 'ソファ',
          imageUrl: 'https://img.jp/og-different.jpg',
          source: 'json-ld',
        } as any,
      ],
    );
    expect(out[0].imageUrl).toBe('https://img.jp/matched.jpg');
  });

  it('ページを1件も開けなくても、Vision の候補はそのまま出す', () => {
    const out = buildCandidateRecommendations([page('https://shop.jp/1', 1, 'https://img.jp/c.jpg')], []);
    expect(out).toHaveLength(1);
    expect(out[0].productUrl).toBe('https://shop.jp/1');
    expect(out[0].imageUrl).toBe('https://img.jp/c.jpg');
    expect(out[0].verified).toBe(false);
  });

  it('並び順は Vision の一致順のまま（詳細が取れた方を先に繰り上げない）', () => {
    const out = buildCandidateRecommendations(
      [page('https://a.jp/1', 2), page('https://b.jp/1', 1)],
      [{ requestedUrl: 'https://b.jp/1', finalUrl: 'https://b.jp/1', name: '詳細あり', source: 'json-ld' } as any],
    );
    expect(out.map((r) => r.productUrl)).toEqual(['https://a.jp/1', 'https://b.jp/1']);
  });
});

/**
 * 260729 実機報告「候補が1件も出ない」の原因と対策。
 *
 * pagesWithMatchingImages は「この画像そのものが載っているページ」を探す機能なので、
 * Web に存在しない AI 生成画像では一致ページが無いか、あっても無関係なノイズしか返らない。
 * ノイズを除くと候補が空になる＝コメントだけが出る、という状態だった。
 * ここでは「1段目が空でも、似ている画像の掲載ページから候補が作れる」ことを固定する。
 */
describe('AI生成画像で1段目が空になるケース', () => {
  const page = (url: string, matchRank: 0 | 1 | 2, imageUrl?: string) => ({ title: `T:${url}`, url, imageUrl, matchRank });

  it('一致ページが動画・SNSしか無ければ候補は空になる（＝2段目が必要な状況）', () => {
    const out = pickVisualCandidates(
      [page('https://www.youtube.com/watch?v=a', 1), page('https://jp.pinterest.com/pin/2', 1)],
      3,
    );
    expect(out).toHaveLength(0);
  });

  it('似ている画像から辿ったページを足せば候補が埋まる', () => {
    // 2段目で得たページ（掲載元が実在の通販サイト）。サムネイルは「似ていると判定された画像」を使う。
    const expanded = [
      { ...page('https://shop-a.example.jp/item/1', 1), imageUrl: 'https://img.example.jp/similar-1.jpg' },
      { ...page('https://shop-b.example.jp/item/2', 1), imageUrl: 'https://img.example.jp/similar-2.jpg' },
    ];
    const out = pickVisualCandidates([page('https://www.youtube.com/watch?v=a', 1), ...expanded], 3);
    expect(out.map((p) => p.url)).toEqual([
      'https://shop-a.example.jp/item/1',
      'https://shop-b.example.jp/item/2',
    ]);
    // サムネイルは元画像に似ていると判定された画像のまま（判断材料を差し替えない）
    expect(out[0].imageUrl).toBe('https://img.example.jp/similar-1.jpg');
  });

  it('2段目のページも同一ホストは1件まで（同じ店で埋まらない）', () => {
    const out = pickVisualCandidates(
      [
        { ...page('https://shop-a.example.jp/item/1', 1), imageUrl: 'https://img/1.jpg' },
        { ...page('https://shop-a.example.jp/item/2', 1), imageUrl: 'https://img/2.jpg' },
        { ...page('https://shop-b.example.jp/item/3', 1), imageUrl: 'https://img/3.jpg' },
      ],
      3,
    );
    expect(out).toHaveLength(2);
  });

  it('候補が0件でも例外にはならない（カードは出ないがコメントは返す）', () => {
    expect(buildCandidateRecommendations([], [])).toEqual([]);
  });
});
