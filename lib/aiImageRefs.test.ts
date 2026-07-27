import { describe, it, expect } from 'vitest';
import {
  AI_RENDER_URL_RE,
  collectAiRenderUrls,
  storagePathFromAiRenderUrl,
  isPathReferenced,
} from './aiImageRefs.js';

// 260728 #1: 複製を「物理コピー」から「リンク共有」へ切り替えるため、削除前の参照カウントが必須になった。
// ここでの取りこぼし＝他プロジェクトの画像を消す事故なので、抽出漏れ／正規化漏れを重点的に固定する。

const HOST = 'https://jojeebsuviptfgnvmnjy.supabase.co';
const PUB = `${HOST}/storage/v1/object/public/user-uploads`;
const UID = '11111111-1111-4111-8111-111111111111';
const urlA = `${PUB}/${UID}/ai-render/proj-a/1730000000000-abc123.png`;
const urlB = `${PUB}/${UID}/ai-render/proj-a/1730000000001-def456.jpg`;
const pathA = `${UID}/ai-render/proj-a/1730000000000-abc123.png`;

describe('collectAiRenderUrls', () => {
  it('入れ子のプロジェクト state 風オブジェクトから ai-render URL を全部拾う', () => {
    const state = {
      kind: 'room',
      name: 'テスト',
      aiRender: { versions: [{ image: urlA, feedback: 'good' }, { image: urlB }] },
      areas: [{ id: 'a1', edits: [{ before: urlA, after: urlB }] }],
      thumbnail_url: `${PUB}/${UID}/thumbnails/room.png`,
    };
    const urls = collectAiRenderUrls(state);
    expect(urls.sort()).toEqual([urlA, urlB].sort());
  });

  it('同じURLが何度出てきても重複排除される', () => {
    const urls = collectAiRenderUrls({ a: urlA, b: urlA, c: [urlA, urlA, urlB] });
    expect(urls).toHaveLength(2);
    expect(new Set(urls)).toEqual(new Set([urlA, urlB]));
  });

  it('ai-render 以外（素材アップロード・サムネイル・Cloudinary）は拾わない', () => {
    const urls = collectAiRenderUrls({
      model: `${PUB}/${UID}/models/sofa.glb`,
      texture: `${PUB}/${UID}/textures/oak.jpg`,
      thumb: `${PUB}/${UID}/thumbnails/proj-a.png`,
      catalog: 'https://res.cloudinary.com/demo/image/upload/v1/3d_assets_thumbnails/x.png',
      note: 'ai-render という文字列だけならURLではない',
    });
    expect(urls).toEqual([]);
  });

  it('URL に ?query / #hash が付いていても文字列として拾える（正規化は別関数の責務）', () => {
    const urls = collectAiRenderUrls({ image: `${urlA}?token=abc#frag` });
    expect(urls).toEqual([`${urlA}?token=abc#frag`]);
  });

  it('null / undefined / プリミティブでも例外を投げず空配列を返す', () => {
    expect(collectAiRenderUrls(null)).toEqual([]);
    expect(collectAiRenderUrls(undefined)).toEqual([]);
    expect(collectAiRenderUrls(0)).toEqual([]);
    expect(collectAiRenderUrls('')).toEqual([]);
    expect(collectAiRenderUrls({})).toEqual([]);
    expect(collectAiRenderUrls([])).toEqual([]);
  });

  it('循環参照や BigInt など JSON 化できない値でも throw しない', () => {
    const circular: { self?: unknown; image: string } = { image: urlA };
    circular.self = circular;
    expect(() => collectAiRenderUrls(circular)).not.toThrow();
    expect(collectAiRenderUrls(circular)).toEqual([]);
    expect(collectAiRenderUrls({ n: BigInt(1) })).toEqual([]);
    expect(
      collectAiRenderUrls({
        toJSON: () => {
          throw new Error('boom');
        },
      }),
    ).toEqual([]);
  });

  it('生の文字列を渡しても（JSON 化で引用符に挟まれても）URLを拾える', () => {
    expect(collectAiRenderUrls(urlA)).toEqual([urlA]);
  });

  it('繰り返し呼んでも同じ結果になる（グローバル正規表現の lastIndex バグ回帰）', () => {
    const state = { versions: [urlA, urlB] };
    const first = collectAiRenderUrls(state);
    const second = collectAiRenderUrls(state);
    const third = collectAiRenderUrls(state);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('外部で AI_RENDER_URL_RE.lastIndex が汚染されていても結果が変わらない', () => {
    AI_RENDER_URL_RE.lastIndex = 999; // 他所で exec()/test() を使い回した状態を再現
    expect(collectAiRenderUrls({ versions: [urlA, urlB] })).toHaveLength(2);
    AI_RENDER_URL_RE.lastIndex = 0;
  });

  it('AI_RENDER_URL_RE は projects.ts と同じ挙動（グローバル・ai-render 限定）', () => {
    expect(AI_RENDER_URL_RE.global).toBe(true);
    const json = JSON.stringify({ a: urlA, b: `${PUB}/${UID}/models/sofa.glb` });
    expect(json.match(new RegExp(AI_RENDER_URL_RE.source, 'g'))).toEqual([urlA]);
  });
});

describe('storagePathFromAiRenderUrl', () => {
  it('公開URLからバケットを除いたオブジェクトパスを返す', () => {
    expect(storagePathFromAiRenderUrl(urlA)).toBe(pathA);
  });

  it('?query / #hash は比較前に落とす（将来 ?token= が付いても同一視できるように）', () => {
    expect(storagePathFromAiRenderUrl(`${urlA}?token=abc`)).toBe(pathA);
    expect(storagePathFromAiRenderUrl(`${urlA}#frag`)).toBe(pathA);
    expect(storagePathFromAiRenderUrl(`${urlA}?a=1&b=2#frag`)).toBe(pathA);
  });

  it('パーセントエンコードは復号して比較形にそろえる', () => {
    expect(storagePathFromAiRenderUrl(`${PUB}/${UID}/ai-render/proj%20a/f.png`)).toBe(
      `${UID}/ai-render/proj a/f.png`,
    );
  });

  it('ai-render 以外は必ず null（誤削除防止の安全弁）', () => {
    expect(storagePathFromAiRenderUrl(`${PUB}/${UID}/models/sofa.glb`)).toBeNull();
    expect(storagePathFromAiRenderUrl(`${PUB}/${UID}/textures/oak.jpg`)).toBeNull();
    expect(storagePathFromAiRenderUrl(`${PUB}/${UID}/thumbnails/proj-a.png`)).toBeNull();
    // ディレクトリ名の一部でしかない場合も対象外（/ai-render/ 完全一致のみ）
    expect(storagePathFromAiRenderUrl(`${PUB}/${UID}/ai-render-backup/f.png`)).toBeNull();
  });

  it('別バケット・非Storage URL・data: URL は null', () => {
    expect(
      storagePathFromAiRenderUrl(`${HOST}/storage/v1/object/public/other/${UID}/ai-render/f.png`),
    ).toBeNull();
    expect(
      storagePathFromAiRenderUrl('https://res.cloudinary.com/demo/image/upload/ai-render/f.png'),
    ).toBeNull();
    expect(storagePathFromAiRenderUrl('data:image/png;base64,AAAA')).toBeNull();
  });

  it('空文字・非URL文字列・生パスは null（URL 由来であることを要求する）', () => {
    expect(storagePathFromAiRenderUrl('')).toBeNull();
    expect(storagePathFromAiRenderUrl('   ')).toBeNull();
    expect(storagePathFromAiRenderUrl('not a url')).toBeNull();
    expect(storagePathFromAiRenderUrl(pathA)).toBeNull();
  });

  it('null / undefined を渡されても throw しない', () => {
    expect(storagePathFromAiRenderUrl(null as unknown as string)).toBeNull();
    expect(storagePathFromAiRenderUrl(undefined as unknown as string)).toBeNull();
  });

  it('collect → path の実運用フローが通る', () => {
    const paths = collectAiRenderUrls({ v: [urlA, urlB, `${PUB}/${UID}/models/x.glb`] })
      .map(storagePathFromAiRenderUrl)
      .filter((p): p is string => !!p);
    expect(paths).toHaveLength(2);
    expect(paths).toContain(pathA);
  });
});

describe('isPathReferenced', () => {
  it('参照集合に同じパスがあれば true', () => {
    expect(isPathReferenced(pathA, [pathA])).toBe(true);
    expect(isPathReferenced(pathA, new Set([`${UID}/ai-render/proj-a/other.png`, pathA]))).toBe(
      true,
    );
  });

  it('参照集合が空／別プロジェクトのみなら false（＝削除して良い）', () => {
    expect(isPathReferenced(pathA, [])).toBe(false);
    expect(isPathReferenced(pathA, new Set())).toBe(false);
    expect(isPathReferenced(pathA, [`${UID}/ai-render/proj-b/1730000000000-abc123.png`])).toBe(
      false,
    );
  });

  it('生URLとパスを混ぜて渡しても正規化して一致する', () => {
    expect(isPathReferenced(pathA, [urlA])).toBe(true);
    expect(isPathReferenced(urlA, [pathA])).toBe(true);
    expect(isPathReferenced(urlA, [urlA])).toBe(true);
  });

  it('?token= 等のクエリ違いで参照を見落とさない（生URL比較の回帰防止）', () => {
    expect(isPathReferenced(pathA, [`${urlA}?token=xyz`])).toBe(true);
    expect(isPathReferenced(`${urlA}?token=xyz`, [urlA])).toBe(true);
    expect(isPathReferenced(`${urlA}#frag`, [`${urlA}?v=2`])).toBe(true);
    expect(urlA).not.toBe(`${urlA}?token=xyz`); // 生URLでは別物＝だから正規化が要る
  });

  it('バケット付きパス・先頭スラッシュ・エンコード差も同一視する', () => {
    expect(isPathReferenced(pathA, [`user-uploads/${pathA}`])).toBe(true);
    expect(isPathReferenced(`/${pathA}`, [pathA])).toBe(true);
    expect(
      isPathReferenced(`${UID}/ai-render/proj a/f.png`, [`${PUB}/${UID}/ai-render/proj%20a/f.png`]),
    ).toBe(true);
  });

  it('判定できない対象は安全側に倒して true（消させない）', () => {
    expect(isPathReferenced('', [])).toBe(true);
    expect(isPathReferenced('data:image/png;base64,AAAA', [])).toBe(true);
    expect(isPathReferenced(`${UID}/models/sofa.glb`, [])).toBe(true); // ai-render 以外
    expect(isPathReferenced(pathA, null as unknown as Iterable<string>)).toBe(true);
  });

  it('参照集合内のゴミ（空文字・素材パス）に引っかからない', () => {
    expect(isPathReferenced(pathA, ['', 'data:image/png;base64,AAAA', `${UID}/models/x.glb`])).toBe(
      false,
    );
  });

  it('ジェネレータ等の任意 Iterable を受け付ける', () => {
    function* refs(): Generator<string> {
      yield `${UID}/ai-render/proj-b/x.png`;
      yield urlA;
    }
    expect(isPathReferenced(pathA, refs())).toBe(true);
  });

  it('複製（リンク共有）シナリオ: 元を消しても、コピーが参照する限り実体は残す', () => {
    const original = { versions: [{ image: urlA }, { image: urlB }] };
    const copy = { versions: [{ image: urlA }] }; // 260728: URL を貼り替えずそのまま共有
    const survivors = new Set(collectAiRenderUrls(copy)); // 生き残るプロジェクト側の参照
    const deletable = collectAiRenderUrls(original)
      .map(storagePathFromAiRenderUrl)
      .filter((p): p is string => !!p)
      .filter((p) => !isPathReferenced(p, survivors));
    expect(deletable).toEqual([`${UID}/ai-render/proj-a/1730000000001-def456.jpg`]); // urlA は残る
  });
});
