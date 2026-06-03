import type { AiEditObjectReference, AiEditVersion, NormalizedRect } from '../types.js';

function isNormalizedRect(x: unknown): x is NormalizedRect {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    typeof o.width === 'number' &&
    typeof o.height === 'number'
  );
}

function normalizeImageDataUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return null;
  return s;
}

/** API / localStorage 等の生オブジェクトを現行 AiEditObjectReference に正規化 */
export function normalizeObjectReference(raw: unknown): AiEditObjectReference | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const imageDataUrl = normalizeImageDataUrl(o.imageDataUrl);
  const memo = typeof o.memo === 'string' ? o.memo : '';
  let placements: NormalizedRect[] = [];
  if (Array.isArray(o.placements)) {
    placements = o.placements.filter(isNormalizedRect);
  } else if (isNormalizedRect(o.placement)) {
    placements = [o.placement];
  }
  const rawPlacementMemos = Array.isArray(o.placementMemos) ? o.placementMemos : [];
  const placementMemos = placements.map((_, idx) =>
    typeof rawPlacementMemos[idx] === 'string' ? rawPlacementMemos[idx] : ''
  );
  return { id: o.id, imageDataUrl, placements, memo, placementMemos };
}

export function normalizeAiEditVersion(raw: unknown): AiEditVersion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (
    typeof v.id !== 'string' ||
    typeof v.createdAt !== 'number' ||
    typeof v.baseImageDataUrl !== 'string' ||
    typeof v.outputImageDataUrl !== 'string'
  ) {
    return null;
  }
  const parentId = v.parentId === null || typeof v.parentId === 'string' ? v.parentId : null;
  const styleRefDataUrl =
    v.styleRefDataUrl === null || typeof v.styleRefDataUrl === 'string'
      ? v.styleRefDataUrl
      : null;
  const styleMemo = typeof v.styleMemo === 'string' ? v.styleMemo : '';
  const objectsRaw = Array.isArray(v.objects) ? v.objects : [];
  const objects: AiEditObjectReference[] = [];
  for (const item of objectsRaw) {
    const n = normalizeObjectReference(item);
    if (n) objects.push(n);
  }
  return {
    id: v.id,
    parentId,
    createdAt: v.createdAt,
    baseImageDataUrl: v.baseImageDataUrl,
    outputImageDataUrl: v.outputImageDataUrl,
    styleRefDataUrl,
    styleMemo,
    objects,
  };
}

export function normalizeStoredVersions(raw: unknown): AiEditVersion[] {
  if (!Array.isArray(raw)) return [];
  const out: AiEditVersion[] = [];
  for (const item of raw) {
    const ver = normalizeAiEditVersion(item);
    if (ver) out.push(ver);
  }
  return out;
}
