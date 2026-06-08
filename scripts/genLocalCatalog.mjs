// 同梱モデル（public/models/*.gltf|glb）の静的カタログ public/models/catalog.json を生成する。
//
// 目的: 本番（Vercel）で Cloudinary 未構成でも、フロントが /models/catalog.json を
//       フォールバック読み込みして家具を表示できるようにする。
//       dev の lib/localFurnitureCatalog.ts（getLocalFurnitureCatalog）と同一の出力形状にすること。
//
// 実行: npm run build の prebuild で自動実行（モデル追加時はビルドで自動再生成）。

import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = path.join(process.cwd(), 'public', 'models');

function inferType(base) {
  const b = base.toLowerCase();
  if (b.includes('sofa')) return 'Sofa';
  if (b.includes('chair')) return 'Chair';
  if (b.includes('table')) return 'Table';
  if (b.includes('lamp') || b.includes('light')) return 'Lamp';
  if (b.includes('bed')) return 'Bed';
  if (b.includes('shelf')) return 'Shelf';
  return 'Other';
}

function build() {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'furniture-metadata.json'), 'utf-8'));
  } catch {
    meta = {};
  }
  const files = fs.readdirSync(dir).filter((f) => /\.(gltf|glb)$/i.test(f));
  return files.map((file) => {
    const base = file.replace(/\.(gltf|glb)$/i, '');
    const m = meta[file] ?? {};
    return {
      id: `local-${base}`,
      name: base,
      type: inferType(base),
      url: `/models/${file}`,
      defaultScale: 1,
      defaultY: 0,
      footprint2d: {
        widthMm: typeof m.widthMm === 'number' ? m.widthMm : 1000,
        depthMm: typeof m.depthMm === 'number' ? m.depthMm : 700,
      },
      forwardYawDeg: typeof m.forwardYawDeg === 'number' ? m.forwardYawDeg : 0,
    };
  });
}

try {
  if (!fs.existsSync(dir)) {
    console.warn('[genLocalCatalog] public/models が無いためスキップしました。');
    process.exit(0);
  }
  const items = build();
  const out = path.join(dir, 'catalog.json');
  fs.writeFileSync(out, JSON.stringify(items, null, 2) + '\n', 'utf-8');
  console.log(`[genLocalCatalog] ${items.length} 件を ${path.relative(process.cwd(), out)} に出力しました。`);
} catch (e) {
  console.error('[genLocalCatalog] 失敗:', e);
  process.exit(1);
}
