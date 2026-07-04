/**
 * フリープランの高解像度ダウンロード月次制限（260624 クライアント要望）。
 *  - 無料プランのユーザーは「高解像度DL（dpiプリセットでの書き出し）」を 月3回 まで無償。
 *  - 4回目以降の高解像度DLには「フリープラン サンプル」透かしが入る（段階的制限）。
 *  - プレビュー（等倍そのまま保存）は対象外＝無償・無制限。
 *
 * 重要:
 *  - 既存の ENABLE_FREE_PLAN_AI_CREDITS / ENABLE_FREE_PLAN_OUTPUT_LIMITS（テストマーケ中は false）とは異なり、
 *    本制限はクライアント要望により **既定 ON**。テスト企業から要望があれば本フラグを false にして即解除できる。
 *  - v1 はカウンタを **localStorage（ユーザー×月）** に置く。マイグレーション不要で即時に効くが、端末ごと・
 *    ストレージ消去で回避可能（透かしという soft 制限なので許容）。本格的な非回避は v2 で DB（profiles 列＋RPC、
 *    ai_credits と同形）へ移行する想定（period/カウント仕様はそのまま流用できる）。
 *  - 未ログイン（ゲスト＝userId 無し）は対象外（無制限）。制限は実在の無料プラン「アカウント」に対して適用する。
 */
// 260704: 機能確認・テストマーケティング期間中はクライアント要望により一旦オフ（無料プランの
// 高解像度DL回数制限・透かしを無効化）。本格運用を再開する際は true に戻す。
// （ENABLE_FREE_PLAN_AI_CREDITS / ENABLE_FREE_PLAN_OUTPUT_LIMITS と同様、テスト期間中は false 運用）。
export const ENABLE_FREE_PLAN_HIRES_DL_LIMIT = false;

/** 無料プランの月あたり高解像度DL無償回数。 */
export const FREE_PLAN_HIRES_DL_PER_MONTH = 3;

const KEY_PREFIX = 'arise.hiResDl.';

/** 月キー（ローカル時刻 YYYY-MM）。月替わりで自動的に別キー＝カウント0から（リセットジョブ不要）。 */
export function hiResPeriod(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function storageKey(userId: string, now: Date): string {
  return `${KEY_PREFIX}${userId}.${hiResPeriod(now)}`;
}

function readCount(userId: string, now: Date): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  try {
    const raw = window.localStorage.getItem(storageKey(userId, now));
    const n = raw == null ? 0 : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 制限が実際に効く対象か（フラグON・無料プラン・ログイン済み userId あり）。 */
function isActive(userId: string | null | undefined, isFreePlan: boolean): userId is string {
  return ENABLE_FREE_PLAN_HIRES_DL_LIMIT && isFreePlan && !!userId;
}

/** 今月の高解像度DL回数（表示用）。対象外なら 0。 */
export function getHiResDownloadCount(
  userId: string | null | undefined,
  isFreePlan: boolean,
  now: Date = new Date()
): number {
  if (!isActive(userId, isFreePlan)) return 0;
  return readCount(userId, now);
}

/** 次の高解像度DLが透かし対象か（＝今月すでに上限回数を消費済み）。 */
export function isOverHiResLimit(
  userId: string | null | undefined,
  isFreePlan: boolean,
  now: Date = new Date()
): boolean {
  if (!isActive(userId, isFreePlan)) return false;
  return readCount(userId, now) >= FREE_PLAN_HIRES_DL_PER_MONTH;
}

/** 今月の残り無償回数（表示用）。対象外なら Infinity。 */
export function hiResRemaining(
  userId: string | null | undefined,
  isFreePlan: boolean,
  now: Date = new Date()
): number {
  if (!isActive(userId, isFreePlan)) return Infinity;
  return Math.max(0, FREE_PLAN_HIRES_DL_PER_MONTH - readCount(userId, now));
}

/** 高解像度DL成功時に 1 消費（対象外・localStorage不可時は no-op）。 */
export function incrementHiResDownloadCount(
  userId: string | null | undefined,
  isFreePlan: boolean,
  now: Date = new Date()
): void {
  if (!isActive(userId, isFreePlan)) return;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const next = readCount(userId, now) + 1;
    window.localStorage.setItem(storageKey(userId, now), String(next));
  } catch {
    /* 容量超過等は無視（soft 制限・記録漏れは数回の無透かしDLに留まる） */
  }
}
