import { getSupabase } from './supabaseClient.js';

// AIクレジット消費（管理表 row 49/50）。
// サーバ側の SECURITY DEFINER 関数 consume_ai_credit() を RPC で呼び、本人の ai_credits_used を
// +1 して残数を返す（クライアントからは used を直接書き換えられない＝改竄防止）。
// 生成自体は既に成功しているため、消費の失敗で UX を止めない（失敗時は null を返すだけ）。
export async function consumeAiCredit(): Promise<number | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.rpc('consume_ai_credit');
  if (error) {
    console.error('[credits] consume_ai_credit failed', error);
    return null;
  }
  return typeof data === 'number' ? data : null;
}
