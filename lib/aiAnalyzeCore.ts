import { generatePlacementNarratives, type DetectedOpeningRect } from './gemini.js';
import type { AiEditObjectReference } from '../types.js';
import { normalizeObjectReference } from './aiEditNormalize.js';

/**
 * エリア編集の「生成前の事前解析」の中核ロジック（260709）。専用エンドポイントは作らず、/api/ai-edit に
 * analyze:true で相乗りして呼ぶ（本番 api/ai-edit.ts と 開発 vite.config.ts が共有＝Hobbyプランの関数数上限12対策）。
 * 生成本体より前にクライアントから単独で呼び、遮蔽判定→クロップ出し分けに使う。
 * 目的: 各領域の「対象が別の家具の後ろに隠れているか（occluded）」を先に判定し、隠れているときだけ切り取り方式
 * （案1）に切り替える、というクライアント要望の出し分けを可能にするため。narratives は生成本体へ渡して再解析を省く。
 */

export interface AiAnalyzeRequestBody {
  baseImage?: string;
  objects?: unknown[];
}

export type AiAnalyzeResult =
  | {
      success: true;
      narratives: Record<string, string>;
      occluded: Record<string, boolean>;
      /** 面仕上げ（壁/床/天井）の内側に検出した窓・ドア等の開口（正規化矩形・260718）。合成で「面から除外＝元のまま保持」する。 */
      openings: Record<string, DetectedOpeningRect[]>;
    }
  | { success: false; status: number; error: string };

/** APIキー抽出済み前提。body を検証し、事前解析（説明＋遮蔽判定）を返す。 */
export async function runAiAnalyze(apiKey: string, body: AiAnalyzeRequestBody): Promise<AiAnalyzeResult> {
  if (!body?.baseImage) {
    return { success: false, status: 400, error: 'baseImage が必要です。' };
  }
  // 呼び出し側（runEdit）は参照画像(imageDataUrl)を外して送る（遮蔽判定は base 画像＋範囲座標だけで足りる＝
  // payload 削減）。ここでは normalizeObjectReference が imageDataUrl=null を許容するのでそのまま扱える（260709）。
  const objects: AiEditObjectReference[] = [];
  if (Array.isArray(body.objects)) {
    for (const item of body.objects) {
      const n = normalizeObjectReference(item);
      if (n) objects.push(n);
    }
  }
  if (objects.length === 0) {
    // 解析対象が無ければ空で返す（エラーにせず、呼び出し側は全画面=非クロップで続行できる）。
    return { success: true, narratives: {}, occluded: {}, openings: {} };
  }
  try {
    const { narratives, occluded, openings } = await generatePlacementNarratives(apiKey, {
      baseImageDataUrl: body.baseImage,
      objects,
    });
    return { success: true, narratives, occluded, openings };
  } catch (e) {
    // 解析失敗は致命ではない（呼び出し側は非クロップで続行）。空を返す。
    return { success: true, narratives: {}, occluded: {}, openings: {} };
  }
}
