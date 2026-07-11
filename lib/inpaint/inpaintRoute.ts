/**
 * エリア編集を「どのエンジン・どの操作」で処理するかを決める純粋関数（260711・フェーズ1）。
 *
 * 新方針（適材適所）:
 * - エリア編集（囲った範囲の限定編集）は、マスクベースの専用エンジンで処理する。
 *   ・削除（「消す/削除」等・参照画像なし）→ 物体消去（インペイント remove）。
 *   ・それ以外（置換・追加・素材変更／テキストor参照画像）→ マスク内生成（インペイント generate）。
 * - ただし囲みが実質「全画面」（被覆が非常に大きい）なら、守るべき“外”がほぼ無いので従来の Gemini 全画面に任せる。
 * - コーディネート（部屋全体の再提案）や、専用エンジンが使えない/失敗した場合は Gemini にフォールバックする。
 *
 * ここは外部APIに依存しない純粋な判定のみ（ユニットテスト可能）。実際のエンジン呼び出しは lib/inpaint/inpaintCore。
 */

import { GLOBAL_REGION_COVERAGE } from '../../utils/areaEditDecision.js';

export type AreaEditRoute = 'inpaint-remove' | 'inpaint-generate' | 'gemini';

/** 「全画面」とみなす被覆率（これ以上は守る外がほぼ無いので Gemini 全画面へ）。areaEditDecision と単一ソースに統一（ドリフト防止）。 */
export const INPAINT_GLOBAL_COVERAGE = GLOBAL_REGION_COVERAGE;

// 削除意図を表す語（日本語＋英語）。表記ゆれを広めに拾う。
const REMOVAL_PATTERNS: RegExp[] = [
  /消(?:す|して|し|去|滅)/, // 消す/消して/消し/消去
  /削除/,
  /除去/,
  /取(?:り)?(?:除|払|去)/, // 取り除く/取り払う/取り去る
  /撤去/,
  /どか(?:す|して)/,
  /なく(?:す|して)/,
  /無く(?:す|して)/,
  /\b(?:remove|erase|delete|clear)\b/i,
  /\b(?:take\s+out|get\s+rid\s+of)\b/i,
];

/** 指示文が「削除」の意図か（純関数）。 */
export function isRemovalInstruction(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return REMOVAL_PATTERNS.some((re) => re.test(t));
}

/**
 * エリア編集の処理経路を決める。
 * @param instruction 囲った範囲への指示文（複数領域は結合して渡す）
 * @param hasReferenceImage 参照画像（差し替え/配置する家具の画像）があるか
 * @param unionCoverage 囲みの外接矩形の面積被覆率 0..1
 */
export function chooseAreaEditRoute(params: {
  instruction: string;
  hasReferenceImage: boolean;
  unionCoverage: number;
  globalCoverageThreshold?: number;
}): AreaEditRoute {
  const globalT = params.globalCoverageThreshold ?? INPAINT_GLOBAL_COVERAGE;
  // 実質全画面＝守る外がほぼ無い → 従来の Gemini 全画面（インペイントの利点が無い）。
  if (params.unionCoverage >= globalT) return 'gemini';
  // 参照画像あり（特定商品の差し替え/配置）は当面 Gemini に任せる。フェーズ1の生成エンジン（FLUX Fill）は
  // 参照画像を使わない＝そのまま回すと参照を無視した幻覚生成になり、しかも成功扱いでフェイルソフトしないため。
  // 参照画像の忠実配置はフェーズ2（参照対応エンジン or 決定論合成）で扱う。
  if (params.hasReferenceImage) return 'gemini';
  // 削除意図（参照画像なし）→ 物体消去。
  if (isRemovalInstruction(params.instruction)) return 'inpaint-remove';
  // テキストのみの置換・追加・素材変更 → マスク内生成。
  return 'inpaint-generate';
}
