import type { InpaintEngine, InpaintOp, InpaintResult } from './inpaintTypes.js';

/**
 * マスクベース画像編集の中核（260711・フェーズ1）。サーバー側（/api/ai-edit の mode:'inpaint'）から呼ぶ。
 * 検証してエンジンへ委譲するだけの薄い層＝プロバイダ差し替え可能。範囲外の貼り戻し（閉じ込め保証）は
 * クライアント側で行うため、ここではエンジン出力をそのまま返す。失敗は success:false（呼び出し側で Gemini へフェイルソフト）。
 */

export interface InpaintCoreBody {
  imageDataUrl?: string;
  maskDataUrl?: string;
  op?: string;
  prompt?: string;
  referenceImageDataUrl?: string | null;
  backgroundImageDataUrl?: string | null;
}

export type InpaintCoreResult =
  | { success: true; result: InpaintResult }
  | { success: false; status: number; error: string };

const VALID_OPS: InpaintOp[] = ['remove', 'generate', 'cutout', 'relight'];

function normalizeOp(op: unknown): InpaintOp | null {
  return typeof op === 'string' && (VALID_OPS as string[]).includes(op) ? (op as InpaintOp) : null;
}

/** マスクが必須の操作（範囲内を編集するもの）。cutout/relight は画像全体を処理するのでマスク不要。 */
function requiresMask(op: InpaintOp): boolean {
  return op === 'remove' || op === 'generate';
}

/** APIキー・エンジンは呼び出し側（api/ai-edit）が env と registry から解決して渡す前提。 */
export async function runInpaint(
  engine: InpaintEngine | null,
  apiKey: string | null | undefined,
  body: InpaintCoreBody
): Promise<InpaintCoreResult> {
  if (!engine) {
    return { success: false, status: 501, error: 'インペイントエンジンが未設定です（サーバー構成）。' };
  }
  if (!apiKey) {
    return { success: false, status: 500, error: 'エンジンのAPIキーが未設定です（サーバー側 env）。' };
  }
  if (!body?.imageDataUrl) {
    return { success: false, status: 400, error: 'imageDataUrl が必要です。' };
  }
  const op = normalizeOp(body.op);
  if (!op) {
    return { success: false, status: 400, error: "op は 'remove' / 'generate' / 'cutout' / 'relight' のいずれかを指定してください。" };
  }
  // マスクは範囲内編集（remove/generate）のみ必須。cutout/relight は画像全体を処理するため不要。
  if (requiresMask(op) && !body?.maskDataUrl) {
    return { success: false, status: 400, error: 'maskDataUrl が必要です。' };
  }
  if (!engine.supports.includes(op)) {
    return { success: false, status: 400, error: `エンジン ${engine.id} は操作 ${op} に対応していません。` };
  }
  if (op === 'generate' && !body.prompt?.trim() && !body.referenceImageDataUrl) {
    return { success: false, status: 400, error: 'generate には prompt か参照画像が必要です。' };
  }
  // relight は照明の基準となる背景画像が必須（無ければ何に馴染ませるか決まらない）。
  if (op === 'relight' && !body.backgroundImageDataUrl) {
    return { success: false, status: 400, error: 'relight には backgroundImageDataUrl（背景画像）が必要です。' };
  }
  // 参照画像が来たのにエンジンが参照非対応なら、黙って無視した幻覚生成を返さず拒否する（呼び出し側は Gemini へフェイルソフト）。
  if (body.referenceImageDataUrl && !engine.acceptsReference) {
    return { success: false, status: 400, error: `エンジン ${engine.id} は参照画像に対応していません。` };
  }
  try {
    const result = await engine.run(apiKey, {
      imageDataUrl: body.imageDataUrl,
      maskDataUrl: body.maskDataUrl,
      op,
      prompt: body.prompt,
      referenceImageDataUrl: body.referenceImageDataUrl ?? null,
      backgroundImageDataUrl: body.backgroundImageDataUrl ?? null,
    });
    return { success: true, result };
  } catch (e) {
    return { success: false, status: 502, error: e instanceof Error ? e.message : 'インペイント実行エラー' };
  }
}
