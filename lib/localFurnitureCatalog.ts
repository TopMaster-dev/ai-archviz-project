import * as fs from 'node:fs';
import * as path from 'node:path';

// Cloudinary 未構成時の、ローカル開発用フォールバック家具カタログ。
// public/models/*.gltf|glb をスキャンし、furniture-metadata.json の足跡寸法を併用する。
// これにより、Cloudinary を設定しなくても家具の配置・移動・Undo/Redo をローカルで試せる。
// （本番 api/furniture.ts は Cloudinary を使用。本フォールバックは dev ミドルウェア専用。）

export type LocalCatalogItem = {
  id: string;
  name: string;
  type: string;
  url: string;
  defaultScale: number;
  defaultY: number;
  footprint2d: { widthMm: number; depthMm: number };
  forwardYawDeg: number;
};

function inferType(base: string): string {
  const b = base.toLowerCase();
  if (b.includes('sofa')) return 'Sofa';
  if (b.includes('chair')) return 'Chair';
  if (b.includes('table')) return 'Table';
  if (b.includes('lamp') || b.includes('light')) return 'Lamp';
  if (b.includes('bed')) return 'Bed';
  if (b.includes('shelf')) return 'Shelf';
  return 'Other';
}

export function getLocalFurnitureCatalog(): LocalCatalogItem[] {
  try {
    const dir = path.join(process.cwd(), 'public', 'models');
    let meta: Record<string, { widthMm?: number; depthMm?: number; forwardYawDeg?: number }> = {};
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
  } catch {
    return [];
  }
}
