import type { InpaintEngine, InpaintOp } from './inpaintTypes.js';
import {
  replicateRemoveEngine,
  replicateFluxFillEngine,
  replicateCutoutEngine,
  replicateIcLightEngine,
} from './replicateEngine.js';

/**
 * インペイントエンジンの登録簿（260711・サーバー側専用）。候補エンジンを id で登録し、操作ごとに env で選ぶ。
 * これにより「複数候補を実機で比較して選定する」（クライアント要望3）を、コード変更なしの環境変数切替で行える。
 * 将来 Bria / 他プロバイダのエンジンを ENGINES に足すだけで候補に加わる。
 */
const ENGINES: Record<string, InpaintEngine> = {
  [replicateRemoveEngine.id]: replicateRemoveEngine,
  [replicateFluxFillEngine.id]: replicateFluxFillEngine,
  [replicateCutoutEngine.id]: replicateCutoutEngine,
  [replicateIcLightEngine.id]: replicateIcLightEngine,
};

const DEFAULT_ENGINE_BY_OP: Record<InpaintOp, string> = {
  remove: replicateRemoveEngine.id,
  generate: replicateFluxFillEngine.id,
  cutout: replicateCutoutEngine.id,
  relight: replicateIcLightEngine.id,
};

// 操作ごとの env 差し替えキー（未設定なら既定エンジン）。
const ENGINE_ENV_BY_OP: Record<InpaintOp, string> = {
  remove: 'INPAINT_REMOVE_ENGINE',
  generate: 'INPAINT_GENERATE_ENGINE',
  cutout: 'INPAINT_CUTOUT_ENGINE',
  relight: 'INPAINT_RELIGHT_ENGINE',
};

/** 操作に対して使うエンジンを解決する。env（INPAINT_{OP}_ENGINE）で差し替え可能。 */
export function resolveInpaintEngine(op: InpaintOp): InpaintEngine | null {
  const id = process.env[ENGINE_ENV_BY_OP[op]] || DEFAULT_ENGINE_BY_OP[op];
  return ENGINES[id] ?? null;
}

/**
 * アプリ保有の共通キー（ユーザーのキーではない）。サーバー env にのみ置く。
 * Vercel の env 欄への貼り付けで前後に空白/改行が混入しやすく、そのまま `Bearer <token>` に入れると
 * Replicate が 401「Invalid token」を返す（260713 実機で発生）。ここで trim して事故を防ぐ。
 */
export function getInpaintApiKey(): string {
  return (process.env.REPLICATE_API_TOKEN || '').trim();
}

/** 登録済みエンジンの一覧（管理画面・診断用）。 */
export function listInpaintEngines(): InpaintEngine[] {
  return Object.values(ENGINES);
}
