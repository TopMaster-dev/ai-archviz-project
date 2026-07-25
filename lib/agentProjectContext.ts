// エージェントへ「ユーザーが今作っている部屋の情報」を渡すためのサマリ生成（260725・クライアント要望①）。
// 汎用チャットではなく Arise ならではの助言（寸法・予算・既存の家具/建材との調和を踏まえた提案）を可能にする。
// 純関数（App 側で store から数値を組み立てて渡す）。トークン節約のため簡潔にまとめ、全体長を上限で切る。

export interface AgentProjectFurniture {
  name: string;
  count?: number;
  widthMm?: number;
  depthMm?: number;
}

export interface AgentProjectMaterial {
  /** 面の種別ラベル（例: 床/壁/天井） */
  surface: string;
  name: string;
}

export interface AgentProjectContextInput {
  floorAreaM2?: number | null;
  roomWidthM?: number | null;
  roomDepthM?: number | null;
  ceilingHeightMm?: number | null;
  wallCount?: number | null;
  furniture?: AgentProjectFurniture[];
  materials?: AgentProjectMaterial[];
  budgetYen?: number | null;
}

const MAX_FURNITURE = 14;
const MAX_MATERIALS = 10;
const MAX_SUMMARY_LEN = 1400;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 家具配列を「名称×数量（寸法）」へ集約（同名はまとめる）。 */
function summarizeFurniture(items: AgentProjectFurniture[]): string[] {
  const byName = new Map<string, { count: number; widthMm?: number; depthMm?: number }>();
  for (const f of items) {
    const name = (f?.name ?? '').trim();
    if (!name) continue;
    const prev = byName.get(name);
    const add = num(f.count) ?? 1;
    if (prev) prev.count += add;
    else byName.set(name, { count: add, widthMm: num(f.widthMm) ?? undefined, depthMm: num(f.depthMm) ?? undefined });
  }
  const out: string[] = [];
  for (const [name, v] of byName) {
    const dim = v.widthMm && v.depthMm ? `・約${Math.round(v.widthMm)}×${Math.round(v.depthMm)}mm` : '';
    out.push(`${name}×${v.count}${dim}`);
    if (out.length >= MAX_FURNITURE) break;
  }
  return out;
}

/**
 * ユーザーの現在のプロジェクト情報を、エージェントのシステムプロンプトへ添えるための簡潔なテキストにする。
 * 有意な情報が何も無ければ null（＝文脈を付けない）。
 */
export function buildAgentProjectSummary(input: AgentProjectContextInput): string | null {
  const lines: string[] = [];

  const area = num(input.floorAreaM2);
  const w = num(input.roomWidthM);
  const d = num(input.roomDepthM);
  const h = num(input.ceilingHeightMm);
  const walls = num(input.wallCount);
  const roomParts: string[] = [];
  if (area && area > 0.5 && area < 100000) {
    // 幅・奥行は面積とは独立に妥当域でクランプ（自己交差等で面積は妥当でも bbox が異常な場合に誤表示しない）。
    const dim = w && d && w > 0.3 && d > 0.3 && w < 1000 && d < 1000 ? `（幅${w.toFixed(1)}m×奥行${d.toFixed(1)}m・概形）` : '';
    roomParts.push(`約${area.toFixed(1)}㎡${dim}`);
  }
  if (h && h > 0) roomParts.push(`天井高 ${Math.round(h)}mm`);
  if (walls && walls >= 3) roomParts.push(`壁 ${Math.round(walls)}面`);
  if (roomParts.length) lines.push(`- 部屋: ${roomParts.join(' / ')}`);

  const furniture = Array.isArray(input.furniture) ? summarizeFurniture(input.furniture) : [];
  if (furniture.length) lines.push(`- 配置中の家具: ${furniture.join(', ')}`);

  const materials = Array.isArray(input.materials) ? input.materials.filter((m) => m && (m.name ?? '').trim()) : [];
  if (materials.length) {
    const mtext = materials
      .slice(0, MAX_MATERIALS)
      .map((m) => `${(m.surface ?? '').trim() || '面'}=${m.name.trim()}`)
      .join(', ');
    lines.push(`- 選択中の建材: ${mtext}`);
  }

  const budget = num(input.budgetYen);
  if (budget && budget > 0) lines.push(`- 概算見積もり（現時点）: ¥${Math.round(budget).toLocaleString('ja-JP')}`);

  if (lines.length === 0) return null;

  const body =
    '【現在のプロジェクト情報（このユーザーが作成中の空間）】\n' +
    lines.join('\n') +
    '\nこの空間の寸法・予算・既に選ばれている家具/建材との調和を踏まえて、具体的で実務的に助言・提案してください。';
  return body.length > MAX_SUMMARY_LEN ? body.slice(0, MAX_SUMMARY_LEN) : body;
}
