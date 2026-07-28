import { describe, it, expect } from 'vitest';
import { sameImage } from './visionProductSearchCore.js';

/**
 * 260728 敵対レビュー H2 の対策。
 *
 * 逆画像検索は「その画像を単に埋め込んでいるだけのページ」（特集記事・一覧・関連商品枠）も返す。
 * そういうページの schema.org/Product はたいてい "そのページの主役商品" ＝ 押した画像とは別物なので、
 * 素通しすると『商品ページ確認済み』の緑バッジ付きで無関係な商品名と価格が見積に入る。
 * 「押した画像」と「ページが商品画像として名乗っている画像」が一致したときだけ確定扱いにする。
 *
 * 判定は保守的でよい。取りこぼしても画像経路（実際に画像で照合する）へ落ちるだけだが、
 * 誤って一致と判断すると利用者の見積に誤った金額が入る。
 */
describe('sameImage（押した画像とページの商品画像が同じか）', () => {
  it('完全に同じURLは一致', () => {
    expect(sameImage('https://img.example.jp/a/chair.jpg', 'https://img.example.jp/a/chair.jpg')).toBe(true);
  });

  it('CDNのサイズ・書式クエリが違っても一致（?w=800&fm=webp などは日常的に付く）', () => {
    expect(
      sameImage('https://img.example.jp/a/chair.jpg?w=800&fm=webp', 'https://img.example.jp/a/chair.jpg?w=200'),
    ).toBe(true);
  });

  it('www の有無・大文字小文字は無視する', () => {
    expect(sameImage('https://WWW.Img.Example.jp/a/Chair.JPG', 'https://img.example.jp/a/chair.jpg')).toBe(true);
  });

  it('別のファイル名は不一致（＝そのページの主役商品は別物）', () => {
    expect(sameImage('https://img.example.jp/a/chair.jpg', 'https://img.example.jp/a/sofa.jpg')).toBe(false);
  });

  it('ホストが違えば不一致（別サイトの同名ファイルを同一視しない）', () => {
    expect(sameImage('https://img.a.jp/p/1.jpg', 'https://img.b.jp/p/1.jpg')).toBe(false);
  });

  it('片方でも欠けていれば不一致（判断できないものは確定扱いにしない）', () => {
    expect(sameImage(undefined, 'https://img.example.jp/a/chair.jpg')).toBe(false);
    expect(sameImage('https://img.example.jp/a/chair.jpg', undefined)).toBe(false);
    expect(sameImage(undefined, undefined)).toBe(false);
  });

  it('URLとして壊れていれば不一致', () => {
    expect(sameImage('not a url', 'https://img.example.jp/a/chair.jpg')).toBe(false);
    expect(sameImage('https://img.example.jp/', 'https://img.example.jp/')).toBe(false); // ファイル名が無い
  });
});
