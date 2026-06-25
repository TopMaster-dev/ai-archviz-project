import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * LP ギャラリー画像の一覧を仮想モジュール 'virtual:lp-gallery' として供給する（260625 クライアント要望）。
 *
 * import.meta.glob は `public/` 配下を読めない（public はバンドル対象外で import 不可）ため、
 * 「public フォルダに画像を入れて全件自動表示」を実現するための小さなプラグイン。
 * `public/assets/lp-gallery/` 内の画像を列挙し、配信URL（`/assets/lp-gallery/<file>`）の配列を default export する。
 *
 * 運用: このフォルダへ画像を追加してビルド（dev は再起動）すれば、自動でギャラリーのスライダーに増える。
 * vite.config.ts（本番/開発）と vitest.config.ts（テスト）の双方の plugins に登録すること
 * （AuthScreen→LandingPage が import 連鎖に乗るため、テストでも仮想モジュールの解決が必要）。
 */
export function lpGalleryPlugin(): Plugin {
  const VIRTUAL_ID = 'virtual:lp-gallery';
  const RESOLVED_ID = '\0' + VIRTUAL_ID;
  const galleryDir = path.resolve(process.cwd(), 'public/assets/lp-gallery');

  const listUrls = (): string[] => {
    try {
      return fs
        .readdirSync(galleryDir)
        .filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f))
        .sort((a, b) => a.localeCompare(b))
        .map((f) => `/assets/lp-gallery/${f}`);
    } catch {
      return []; // フォルダが無い等は空配列（ギャラリー非表示）。
    }
  };

  return {
    name: 'lp-gallery-manifest',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      return id === RESOLVED_ID ? `export default ${JSON.stringify(listUrls())};` : null;
    },
  };
}
