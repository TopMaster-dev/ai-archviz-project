import { v2 as cloudinary } from 'cloudinary';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';

type FurnitureMetaMap = Record<string, { widthMm?: number; depthMm?: number; forwardYawDeg?: number }>;
type FootprintMeta = { widthMm: number; depthMm: number; forwardYawDeg: number };
type Vec3 = [number, number, number];
type MetaSource = 'cloudinary' | 'sidecar' | 'computed' | 'fallback';

type CatalogItem = {
  id: string;
  name: string;
  type: string;
  url: string;
  defaultScale: number;
  defaultY: number;
  footprint2d: { widthMm: number; depthMm: number };
  forwardYawDeg: number;
};

type CatalogStats = {
  scanned: number;
  computed: number;
  writebackFailed: number;
  sidecarMigrated: number;
  sidecarMigrateFailed: number;
};

const FALLBACK_FOOTPRINT: FootprintMeta = { widthMm: 1000, depthMm: 700, forwardYawDeg: 0 };
const FOOTPRINT_MIN_MM = 200;
const FOOTPRINT_MAX_MM = 10000;
const LAZY_COMPUTE_LIMIT = 4;
const META_WIDTH_KEY = 'footprint_width_mm';
const META_DEPTH_KEY = 'footprint_depth_mm';
const META_YAW_KEY = 'forward_yaw_deg';
const inFlightFootprintWrite = new Set<string>();

const loadFurnitureMeta = (): FurnitureMetaMap => {
  try {
    const p = path.join(process.cwd(), 'public', 'models', 'furniture-metadata.json');
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as FurnitureMetaMap) : {};
  } catch {
    return {};
  }
};

const normalizeKey = (value: string) =>
  decodeURIComponent(value).toLowerCase().replace(/\\/g, '/').split('?')[0].split('#')[0];

const splitFileParts = (value: string): { withExt: string; withoutExt: string } => {
  const normalized = normalizeKey(value);
  const last = normalized.split('/').pop() ?? normalized;
  const withoutExt = last.replace(/\.[a-z0-9]+$/i, '');
  return { withExt: last, withoutExt };
};

const clampMm = (v: number) => Math.max(FOOTPRINT_MIN_MM, Math.min(FOOTPRINT_MAX_MM, v));

const toFiniteNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const normalizeFootprint = (
  widthMm?: number,
  depthMm?: number,
  forwardYawDeg?: number
): FootprintMeta | undefined => {
  if (!Number.isFinite(widthMm) || !Number.isFinite(depthMm)) return undefined;
  return {
    widthMm: clampMm(Number(widthMm)),
    depthMm: clampMm(Number(depthMm)),
    forwardYawDeg: Number.isFinite(forwardYawDeg) ? Number(forwardYawDeg) : 0
  };
};

const contextObjectFromResource = (resItem: any): Record<string, string> => {
  const rawContext = resItem?.context;
  if (!rawContext || typeof rawContext !== 'object') return {};
  const custom = rawContext.custom && typeof rawContext.custom === 'object' ? rawContext.custom : rawContext;
  return Object.entries(custom).reduce<Record<string, string>>((acc, [k, v]) => {
    if (typeof v === 'string') acc[k] = v;
    return acc;
  }, {});
};

const resolveMetaFromCloudinary = (resItem: any): FootprintMeta | undefined => {
  const ctx = contextObjectFromResource(resItem);
  const md = resItem?.metadata && typeof resItem.metadata === 'object' ? resItem.metadata : {};
  const widthMm =
    toFiniteNumber(ctx[META_WIDTH_KEY]) ??
    toFiniteNumber(ctx.widthMm) ??
    toFiniteNumber(md[META_WIDTH_KEY]) ??
    toFiniteNumber(md.widthMm);
  const depthMm =
    toFiniteNumber(ctx[META_DEPTH_KEY]) ??
    toFiniteNumber(ctx.depthMm) ??
    toFiniteNumber(md[META_DEPTH_KEY]) ??
    toFiniteNumber(md.depthMm);
  const forwardYawDeg =
    toFiniteNumber(ctx[META_YAW_KEY]) ??
    toFiniteNumber(ctx.forwardYawDeg) ??
    toFiniteNumber(md[META_YAW_KEY]) ??
    toFiniteNumber(md.forwardYawDeg) ??
    0;
  return normalizeFootprint(widthMm, depthMm, forwardYawDeg);
};

const parseDataUriToBuffer = (uri: string): Buffer | null => {
  const m = uri.match(/^data:.*?;base64,(.*)$/i);
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64');
  } catch {
    return null;
  }
};

const parseGlb = (glb: Buffer): { json: any; buffers: Buffer[] } | null => {
  if (glb.byteLength < 20) return null;
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const length = dv.getUint32(8, true);
  if (magic !== 0x46546c67 || version !== 2 || length > glb.byteLength) return null;
  let off = 12;
  let jsonChunk: Buffer | null = null;
  let binChunk: Buffer | null = null;
  while (off + 8 <= length) {
    const chunkLength = dv.getUint32(off, true);
    const chunkType = dv.getUint32(off + 4, true);
    off += 8;
    if (off + chunkLength > length) return null;
    const chunk = glb.subarray(off, off + chunkLength);
    off += chunkLength;
    if (chunkType === 0x4e4f534a) jsonChunk = chunk;
    if (chunkType === 0x004e4942) binChunk = chunk;
  }
  if (!jsonChunk) return null;
  try {
    const json = JSON.parse(jsonChunk.toString('utf8').replace(/\0+$/g, ''));
    const buffers: Buffer[] = [];
    if (Array.isArray(json?.buffers)) {
      for (let i = 0; i < json.buffers.length; i += 1) {
        const b = json.buffers[i];
        if (typeof b?.uri === 'string' && b.uri.startsWith('data:')) {
          const decoded = parseDataUriToBuffer(b.uri);
          if (!decoded) return null;
          buffers.push(decoded);
        } else if (i === 0 && binChunk) {
          buffers.push(binChunk);
        } else {
          return null;
        }
      }
    }
    return { json, buffers };
  } catch {
    return null;
  }
};

const resolveUrl = (baseUrl: string, maybeRelative: string): string => {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative;
  }
};

const identity4 = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const mulMat4 = (a: number[], b: number[]): number[] => {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
};

const trsMat4 = (t?: Vec3, r?: [number, number, number, number], s?: Vec3): number[] => {
  const tx = t?.[0] ?? 0;
  const ty = t?.[1] ?? 0;
  const tz = t?.[2] ?? 0;
  const qx = r?.[0] ?? 0;
  const qy = r?.[1] ?? 0;
  const qz = r?.[2] ?? 0;
  const qw = r?.[3] ?? 1;
  const sx = s?.[0] ?? 1;
  const sy = s?.[1] ?? 1;
  const sz = s?.[2] ?? 1;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1
  ];
};

const transformPoint = (m: number[], p: Vec3): Vec3 => {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
};

const componentSize = (componentType: number): number => {
  switch (componentType) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      return 0;
  }
};

const typeComponents = (type: string): number => {
  switch (type) {
    case 'SCALAR':
      return 1;
    case 'VEC2':
      return 2;
    case 'VEC3':
      return 3;
    case 'VEC4':
      return 4;
    default:
      return 0;
  }
};

const readComponent = (view: DataView, componentType: number, byteOffset: number): number => {
  switch (componentType) {
    case 5120:
      return view.getInt8(byteOffset);
    case 5121:
      return view.getUint8(byteOffset);
    case 5122:
      return view.getInt16(byteOffset, true);
    case 5123:
      return view.getUint16(byteOffset, true);
    case 5125:
      return view.getUint32(byteOffset, true);
    case 5126:
      return view.getFloat32(byteOffset, true);
    default:
      return NaN;
  }
};

const accessorMinMaxVec3 = (
  gltf: any,
  accessorIndex: number,
  buffers: Buffer[]
): { min: Vec3; max: Vec3 } | null => {
  const accessor = gltf?.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== 'VEC3') return null;
  if (Array.isArray(accessor.min) && Array.isArray(accessor.max) && accessor.min.length >= 3 && accessor.max.length >= 3) {
    return {
      min: [Number(accessor.min[0]), Number(accessor.min[1]), Number(accessor.min[2])],
      max: [Number(accessor.max[0]), Number(accessor.max[1]), Number(accessor.max[2])]
    };
  }
  const bufferView = gltf?.bufferViews?.[accessor.bufferView];
  if (!bufferView) return null;
  const buf = buffers[bufferView.buffer];
  if (!buf) return null;
  const comps = typeComponents(accessor.type);
  const compSize = componentSize(accessor.componentType);
  if (comps !== 3 || compSize <= 0 || !Number.isFinite(accessor.count)) return null;
  const count = Number(accessor.count);
  const baseOffset = Number(bufferView.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0);
  const stride = Number(bufferView.byteStride ?? comps * compSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    const start = baseOffset + i * stride;
    const x = readComponent(view, accessor.componentType, start);
    const y = readComponent(view, accessor.componentType, start + compSize);
    const z = readComponent(view, accessor.componentType, start + compSize * 2);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) return null;
  return { min, max };
};

const applyBoundsWithMatrix = (min: Vec3, max: Vec3, matrix: number[], worldMin: Vec3, worldMax: Vec3) => {
  const corners: Vec3[] = [
    [min[0], min[1], min[2]],
    [min[0], min[1], max[2]],
    [min[0], max[1], min[2]],
    [min[0], max[1], max[2]],
    [max[0], min[1], min[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], min[2]],
    [max[0], max[1], max[2]]
  ];
  for (const c of corners) {
    const p = transformPoint(matrix, c);
    if (p[0] < worldMin[0]) worldMin[0] = p[0];
    if (p[1] < worldMin[1]) worldMin[1] = p[1];
    if (p[2] < worldMin[2]) worldMin[2] = p[2];
    if (p[0] > worldMax[0]) worldMax[0] = p[0];
    if (p[1] > worldMax[1]) worldMax[1] = p[1];
    if (p[2] > worldMax[2]) worldMax[2] = p[2];
  }
};

const computeFootprintFromParsed = (
  gltf: any,
  buffers: Buffer[],
  worldMin: Vec3 = [Infinity, Infinity, Infinity],
  worldMax: Vec3 = [-Infinity, -Infinity, -Infinity]
): { widthMm: number; depthMm: number } | null => {
  if (!gltf || typeof gltf !== 'object') return null;
  const visitNode = (nodeIndex: number, parentMatrix: number[]) => {
    const node = gltf?.nodes?.[nodeIndex];
    if (!node) return;
    const local = Array.isArray(node.matrix) && node.matrix.length === 16
      ? node.matrix.map((v: unknown) => Number(v))
      : trsMat4(node.translation as Vec3 | undefined, node.rotation as [number, number, number, number] | undefined, node.scale as Vec3 | undefined);
    const world = mulMat4(parentMatrix, local);
    const mesh = gltf?.meshes?.[node.mesh];
    if (mesh?.primitives && Array.isArray(mesh.primitives)) {
      for (const p of mesh.primitives) {
        const accessorIndex = p?.attributes?.POSITION;
        if (!Number.isInteger(accessorIndex)) continue;
        const bounds = accessorMinMaxVec3(gltf, accessorIndex, buffers);
        if (!bounds) continue;
        applyBoundsWithMatrix(bounds.min, bounds.max, world, worldMin, worldMax);
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (Number.isInteger(child)) visitNode(child, world);
      }
    }
  };
  const sceneIndex = Number.isInteger(gltf.scene) ? gltf.scene : 0;
  const scene = gltf?.scenes?.[sceneIndex];
  if (!scene || !Array.isArray(scene.nodes)) return null;
  for (const rootNode of scene.nodes) {
    if (Number.isInteger(rootNode)) visitNode(rootNode, identity4());
  }
  if (!Number.isFinite(worldMin[0]) || !Number.isFinite(worldMax[0])) return null;
  return {
    widthMm: clampMm(Math.abs(worldMax[0] - worldMin[0]) * 1000),
    depthMm: clampMm(Math.abs(worldMax[2] - worldMin[2]) * 1000)
  };
};

const estimateFootprintMmFromGltf = async (modelUrl: string): Promise<{ widthMm: number; depthMm: number } | null> => {
  const r = await fetch(modelUrl);
  if (!r.ok) return null;
  const gltf = await r.json();
  if (!gltf || typeof gltf !== 'object' || !Array.isArray(gltf.buffers)) return null;
  const buffers: Buffer[] = [];
  for (let i = 0; i < gltf.buffers.length; i += 1) {
    const b = gltf.buffers[i];
    if (!b?.uri || typeof b.uri !== 'string') return null;
    if (b.uri.startsWith('data:')) {
      const decoded = parseDataUriToBuffer(b.uri);
      if (!decoded) return null;
      buffers.push(decoded);
    } else {
      const br = await fetch(resolveUrl(modelUrl, b.uri));
      if (!br.ok) return null;
      buffers.push(Buffer.from(await br.arrayBuffer()));
    }
  }
  return computeFootprintFromParsed(gltf, buffers);
};

const estimateFootprintMmFromGlb = async (modelUrl: string): Promise<{ widthMm: number; depthMm: number } | null> => {
  const r = await fetch(modelUrl);
  if (!r.ok) return null;
  const bin = Buffer.from(await r.arrayBuffer());
  const parsed = parseGlb(bin);
  if (!parsed) return null;
  return computeFootprintFromParsed(parsed.json, parsed.buffers);
};

const estimateFootprintMmFromModel = async (url: string, format?: string): Promise<{ widthMm: number; depthMm: number } | null> => {
  const ext = (format ? String(format) : splitFileParts(url).withExt.split('.').pop() ?? '').toLowerCase();
  if (ext === 'gltf') return estimateFootprintMmFromGltf(url);
  if (ext === 'glb') return estimateFootprintMmFromGlb(url);
  return null;
};

const writeBackCloudinaryContext = async (resItem: any, footprint: FootprintMeta): Promise<void> => {
  const existing = contextObjectFromResource(resItem);
  const merged = {
    ...existing,
    [META_WIDTH_KEY]: String(Math.round(footprint.widthMm)),
    [META_DEPTH_KEY]: String(Math.round(footprint.depthMm)),
    [META_YAW_KEY]: String(Math.round(footprint.forwardYawDeg))
  };
  const context = Object.entries(merged)
    .map(([k, v]) => `${k}=${String(v).replace(/\|/g, ' ')}`)
    .join('|');
  await cloudinary.api.update(resItem.public_id, {
    resource_type: resItem.resource_type || 'raw',
    type: resItem.type || 'upload',
    context
  });
};

const resolveMetaFromResource = (
  resItem: any,
  metaMap: FurnitureMetaMap
): { meta?: FootprintMeta; source: MetaSource } => {
  const cloudMeta = resolveMetaFromCloudinary(resItem);
  if (cloudMeta) return { meta: cloudMeta, source: 'cloudinary' };
  const keySet = new Set<string>();
  const push = (raw?: string | null) => {
    if (!raw) return;
    const parts = splitFileParts(raw);
    if (parts.withExt) keySet.add(parts.withExt);
    if (parts.withoutExt) keySet.add(parts.withoutExt);
  };
  push(resItem?.filename);
  push(resItem?.public_id);
  push(resItem?.secure_url);
  if (resItem?.filename && resItem?.format) push(`${resItem.filename}.${String(resItem.format).toLowerCase()}`);
  for (const k of keySet) {
    const hit = metaMap[k];
    if (hit) {
      const normalized = normalizeFootprint(hit.widthMm, hit.depthMm, hit.forwardYawDeg);
      if (normalized) return { meta: normalized, source: 'sidecar' };
    }
  }
  return { source: 'fallback' };
};

const inferTypeFromFilename = (filename: string): string => {
  const lower = filename.toLowerCase();
  if (lower.includes('sofa')) return 'Sofa';
  if (lower.includes('chair')) return 'Chair';
  if (lower.includes('table') || lower.includes('desk')) return 'Table';
  if (lower.includes('bed')) return 'Bed';
  if (lower.includes('lamp') || lower.includes('light')) return 'Lamp';
  if (lower.includes('shelf') || lower.includes('cabinet')) return 'Storage';
  return 'Furniture';
};

export async function getFurnitureCatalog(options?: { debug?: boolean }): Promise<{ items: CatalogItem[]; stats: CatalogStats }> {
  const metaMap = loadFurnitureMeta();
  const computedByPublicId = new Map<string, FootprintMeta>();
  const stats: CatalogStats = {
    scanned: 0,
    computed: 0,
    writebackFailed: 0,
    sidecarMigrated: 0,
    sidecarMigrateFailed: 0
  };

  const result = await cloudinary.search
    .expression('folder:3d_assets')
    .with_field('context')
    .with_field('metadata')
    .max_results(500)
    .execute();

  const resources: any[] = Array.isArray(result?.resources) ? result.resources : [];
  stats.scanned = resources.length;

  let computeCount = 0;
  for (const resItem of resources) {
    if (computeCount >= LAZY_COMPUTE_LIMIT) break;
    const existing = resolveMetaFromResource(resItem, metaMap);
    if (existing.meta) {
      if (existing.source === 'sidecar') {
        const publicId = String(resItem?.public_id ?? '');
        if (publicId && !inFlightFootprintWrite.has(publicId)) {
          inFlightFootprintWrite.add(publicId);
          writeBackCloudinaryContext(resItem, existing.meta)
            .then(() => {
              stats.sidecarMigrated += 1;
            })
            .catch((e: any) => {
              stats.sidecarMigrateFailed += 1;
              console.error('[furniture-meta-sidecar-migrate] failed', {
                publicId,
                message: e?.message ?? String(e),
                http_code: e?.http_code
              });
            })
            .finally(() => {
              inFlightFootprintWrite.delete(publicId);
            });
        }
      }
      continue;
    }
    const publicId = String(resItem?.public_id ?? '');
    if (!publicId || inFlightFootprintWrite.has(publicId)) continue;
    const url = String(resItem?.secure_url ?? '');
    if (!url) continue;
    inFlightFootprintWrite.add(publicId);
    try {
      const dims = await estimateFootprintMmFromModel(url, resItem?.format);
      if (!dims) continue;
      const computed: FootprintMeta = { widthMm: dims.widthMm, depthMm: dims.depthMm, forwardYawDeg: 0 };
      computedByPublicId.set(publicId, computed);
      await writeBackCloudinaryContext(resItem, computed);
      computeCount += 1;
      stats.computed += 1;
    } catch (e: any) {
      stats.writebackFailed += 1;
      console.error('[furniture-meta-writeback] failed', {
        publicId,
        resourceType: resItem?.resource_type || 'raw',
        deliveryType: resItem?.type || 'upload',
        message: e?.message ?? String(e),
        http_code: e?.http_code
      });
    } finally {
      inFlightFootprintWrite.delete(publicId);
    }
  }

  const items = resources.map((resItem: any): CatalogItem => {
    const resolved = resolveMetaFromResource(resItem, metaMap);
    const meta = computedByPublicId.get(resItem.public_id) ?? resolved.meta;
    return {
      id: resItem.public_id,
      name: resItem.filename,
      type: inferTypeFromFilename(resItem.filename),
      url: resItem.secure_url,
      defaultScale: 1.0,
      defaultY: 0,
      footprint2d: {
        widthMm: meta?.widthMm ?? FALLBACK_FOOTPRINT.widthMm,
        depthMm: meta?.depthMm ?? FALLBACK_FOOTPRINT.depthMm
      },
      forwardYawDeg: Number.isFinite(meta?.forwardYawDeg) ? Number(meta!.forwardYawDeg) : FALLBACK_FOOTPRINT.forwardYawDeg
    };
  });

  if (options?.debug) {
    return { items, stats };
  }
  return { items, stats };
}
