import type { InpaintEngine, InpaintOp } from './inpaintTypes.js';
import { replicateRemoveEngine, replicateFluxFillEngine } from './replicateEngine.js';

/**
 * インペイントエンジンの登録簿（260711・サーバー側専用）。候補エンジンを id で登録し、操作ごとに env で選ぶ。
 * これにより「複数候補を実機で比較して選定する」（クライアント要望3）を、コード変更なしの環境変数切替で行える。
 * 将来 Bria / 他プロバイダのエンジンを ENGINES に足すだけで候補に加わる。
 */
const ENGINES: Record<string, InpaintEngine> = {
  [replicateRemoveEngine.id]: replicateRemoveEngine,
  [replicateFluxFillEngine.id]: replicateFluxFillEngine,
};

const DEFAULT_REMOVE_ENGINE = replicateRemoveEngine.id;
const DEFAULT_GENERATE_ENGINE = replicateFluxFillEngine.id;

/** 操作に対して使うエンジンを解決する。env（INPAINT_REMOVE_ENGINE / INPAINT_GENERATE_ENGINE）で差し替え可能。 */
export function resolveInpaintEngine(op: InpaintOp): InpaintEngine | null {
  const id =
    op === 'remove'
      ? process.env.INPAINT_REMOVE_ENGINE || DEFAULT_REMOVE_ENGINE
      : process.env.INPAINT_GENERATE_ENGINE || DEFAULT_GENERATE_ENGINE;
  return ENGINES[id] ?? null;
}

/** アプリ保有の共通キー（ユーザーのキーではない）。サーバー env にのみ置く。 */
export function getInpaintApiKey(): string {
  return process.env.REPLICATE_API_TOKEN || '';
}

/** 登録済みエンジンの一覧（管理画面・診断用）。 */
export function listInpaintEngines(): InpaintEngine[] {
  return Object.values(ENGINES);
}
