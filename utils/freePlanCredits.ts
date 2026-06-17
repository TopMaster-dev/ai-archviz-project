// フリープランの AIクレジット（生成回数）制限。管理表 row 49/50。
//
// 仕様: 本登録時に 50 クレジットを付与し、3ヶ月で失効。AI生成（3Dレンダー / 編集 / コーディネート）
//       1回につき 1 消費する。1クレジット = 生成画像1枚。
//
// クレジットの「付与」（total=50・失効日）はサーバ側（schema.sql の handle_new_user / backfill）で常に
// 行われるため、本フラグの値に関係なく DB には入っている。本モジュールのフラグは
// 「消費（consume_ai_credit 呼び出し）・事前ブロック・残数表示」だけを切り替える。
//
// テストマーケティング期間中は無制限運用のため ENABLE_FREE_PLAN_AI_CREDITS=false で全て無効
// （フリープラン出力制限 ENABLE_FREE_PLAN_OUTPUT_LIMITS と同方針）。本番課金開始時に true へ。

export const ENABLE_FREE_PLAN_AI_CREDITS = false;

/** 付与クレジット数（schema.sql 側の付与値と一致させること）。 */
export const FREE_PLAN_AI_CREDITS = 50;

/** 失効までの日数（参考・表示用。実際の失効日は付与時に DB へ保存）。 */
export const FREE_PLAN_AI_CREDITS_VALID_DAYS = 90;

export interface CreditStatus {
  /** クレジット制御が実際に作用するか（フラグON かつ フリープラン）。false のとき blocked は常に false。 */
  active: boolean;
  total: number;
  used: number;
  /** 残数 = max(0, total - used)。 */
  remaining: number;
  /** 失効済みか。 */
  expired: boolean;
  expiresAt: string | null;
  /** 生成を抑止すべきか（active かつ（残0 または 失効））。 */
  blocked: boolean;
}

/** プロフィールの保持値から表示・ゲート用のクレジット状況を導出する（純粋関数）。 */
export function deriveCreditStatus(args: {
  isFreePlan: boolean;
  total: number | null | undefined;
  used: number | null | undefined;
  expiresAt: string | null | undefined;
  now?: number;
}): CreditStatus {
  const total = args.total ?? 0;
  const used = args.used ?? 0;
  const remaining = Math.max(0, total - used);
  const now = args.now ?? Date.now();
  const expired = args.expiresAt != null && Number.isFinite(Date.parse(args.expiresAt)) && Date.parse(args.expiresAt) < now;
  const active = ENABLE_FREE_PLAN_AI_CREDITS && args.isFreePlan;
  const blocked = active && (remaining <= 0 || expired);
  return { active, total, used, remaining, expired, expiresAt: args.expiresAt ?? null, blocked };
}

/** 生成を抑止する理由メッセージ（事前ブロック時の案内）。blocked でない/未定義の場合は null。 */
export function creditBlockMessage(status: CreditStatus | null | undefined): string | null {
  if (!status || !status.blocked) return null;
  if (status.expired) return '無料クレジットの有効期限が切れました。アップグレードでご利用を継続できます。';
  return '無料プランの生成クレジット（50回）を使い切りました。アップグレードでご利用を継続できます。';
}
