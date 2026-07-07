import { generateGeminiImageEdit, generatePlacementNarratives, GEMINI_IMAGE_MODEL } from './gemini.js';
import type { AiEditObjectReference } from '../types.js';
import { normalizeObjectReference } from './aiEditNormalize.js';
import type { TokenUsage } from './gemini.js';

/**
 * /api/ai-edit の中核ロジック（本番 api/ai-edit.ts と 開発 vite.config.ts の両方が呼ぶ共有ハンドラ・260707）。
 * 以前は両者が別実装で乖離し（styleImages/harmonize/placementMemos 等が dev で未対応）、開発と本番で挙動が
 * 食い違っていた。ここに1本化して二重実装ずれを根絶する。req/res の取り回しと APIキー抽出は各呼び出し側が担う。
 */

export interface AiEditRequestBody {
  baseImage?: string;
  styleImage?: string | null;
  styleImages?: unknown[];
  styleMemo?: string;
  objects?: unknown[];
  aspectRatio?: string;
  imageSize?: string;
  coordinate?: boolean;
  harmonize?: boolean;
  learnedHints?: unknown;
  /** 「範囲外を変えない（はみ出し防止）」トグル（260708）。true=厳密に閉じ込め、false（既定）=自然な統合を優先。 */
  strictConfine?: boolean;
}

export type AiEditResult =
  | { success: true; url: string; usage: TokenUsage | null; model: string }
  | { success: false; status: number; error: string };

function normalizeImageDataUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return null;
  return s;
}

/** APIキー抽出済み前提。body を検証し、必要なら事前解析を挟んで画像編集を実行する。 */
export async function runAiEdit(apiKey: string, body: AiEditRequestBody): Promise<AiEditResult> {
  if (!body?.baseImage) {
    return { success: false, status: 400, error: 'baseImage が必要です。' };
  }

  // コーディネート（完全お任せ）モード（row 207/213）: 個別の入力は不要なため入力必須チェックを省く。
  const coordinate = body.coordinate === true;
  // 継ぎ目なじませ（全体を1枚に均一化）パス（260706）: ベース1枚だけを入力に均一化する。個別入力は不要。
  const harmonize = body.harmonize === true;
  // in-context反映（row 211/219）: 過去の高評価傾向。プロンプト末尾に参考添付。
  const learnedHints = Array.isArray(body.learnedHints)
    ? body.learnedHints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).slice(0, 5)
    : undefined;

  const objects: AiEditObjectReference[] = [];
  if (Array.isArray(body.objects)) {
    for (const item of body.objects) {
      const n = normalizeObjectReference(item);
      if (n) objects.push(n);
    }
  }

  const styleMemo =
    typeof body.styleMemo === 'string' && body.styleMemo.trim() ? body.styleMemo.trim() : undefined;
  // スタイル参照は複数対応（260707）。配列があれば優先、無ければ後方互換の単数を1枚として扱う。
  const styleImageDataUrls: string[] = [];
  if (Array.isArray(body.styleImages)) {
    for (const s of body.styleImages) {
      const n = normalizeImageDataUrl(s);
      if (n) styleImageDataUrls.push(n);
    }
  }
  const styleSingle = normalizeImageDataUrl(body.styleImage);
  if (styleImageDataUrls.length === 0 && styleSingle) styleImageDataUrls.push(styleSingle);
  const styleImageDataUrl = styleImageDataUrls[0] ?? null;

  const hasSituationInput = styleImageDataUrls.length > 0 || !!styleMemo;
  const hasAreaEditInput = objects.some(
    (o) =>
      !!normalizeImageDataUrl(o.imageDataUrl) ||
      o.memo.trim().length > 0 ||
      o.placementMemos.some((m) => m.trim().length > 0)
  );
  const areaPlacementCount = objects.reduce((sum, o) => sum + o.placements.length, 0);
  if (!coordinate && !harmonize && !hasSituationInput && !hasAreaEditInput) {
    return {
      success: false,
      status: 400,
      error: 'AIデザインまたはエリア編集で、画像かテキストを1つ以上設定してください。',
    };
  }
  if (hasAreaEditInput && areaPlacementCount === 0) {
    return {
      success: false,
      status: 400,
      error: 'エリア編集を使う場合は、範囲選択を1つ以上設定してください。',
    };
  }

  const aspectRatio =
    typeof body.aspectRatio === 'string' && body.aspectRatio.trim() ? body.aspectRatio.trim() : undefined;
  const imageSize =
    typeof body.imageSize === 'string' && body.imageSize.trim() ? body.imageSize.trim() : undefined;

  // 事前解析（generatePlacementNarratives）: 範囲ごとに対象・位置・向き・前後・維持対象を読み取り、生成の参考に
  // 添える（あくまで助言。座標が最優先）。失敗時は解析なしで生成を続行する（ベストエフォート）。
  let placementNarratives: Record<string, string> | undefined;
  if (!harmonize && objects.length > 0) {
    placementNarratives = await generatePlacementNarratives(apiKey, {
      baseImageDataUrl: body.baseImage,
      objects,
    });
    if (placementNarratives && Object.keys(placementNarratives).length === 0) {
      placementNarratives = undefined;
    }
  }

  try {
    const { url, usage } = await generateGeminiImageEdit(apiKey, {
      baseImageDataUrl: body.baseImage,
      styleImageDataUrl,
      styleImageDataUrls,
      styleMemo,
      objects,
      aspectRatio,
      imageSize,
      placementNarratives,
      coordinate,
      harmonize,
      learnedHints,
      strictConfine: body.strictConfine === true,
    });
    return { success: true, url, usage, model: GEMINI_IMAGE_MODEL };
  } catch (e) {
    return { success: false, status: 500, error: e instanceof Error ? e.message : 'エラー' };
  }
}
