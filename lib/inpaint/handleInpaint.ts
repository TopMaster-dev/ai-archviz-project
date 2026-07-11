import { runInpaint, type InpaintCoreBody, type InpaintCoreResult } from './inpaintCore.js';
import { resolveInpaintEngine, getInpaintApiKey } from './engineRegistry.js';

/**
 * /api/ai-edit の mode:'inpaint' の共有ハンドラ（260711）。本番 api/ai-edit.ts と 開発 vite.config.ts の
 * 両方から呼び、挙動差を無くす（aiEditCore と同方針）。op で操作を決め、env の登録エンジンと共通キーで実行する。
 * 失敗は success:false（呼び出し側＝クライアントが Gemini へフェイルソフト）。
 */
export async function handleInpaintRequest(body: InpaintCoreBody): Promise<InpaintCoreResult> {
  const op = body.op === 'remove' ? 'remove' : body.op === 'generate' ? 'generate' : null;
  if (!op) {
    return { success: false, status: 400, error: "op は 'remove' または 'generate' を指定してください。" };
  }
  const engine = resolveInpaintEngine(op);
  const apiKey = getInpaintApiKey();
  return runInpaint(engine, apiKey, { ...body, op });
}
