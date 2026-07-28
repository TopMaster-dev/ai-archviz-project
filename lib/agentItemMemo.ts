import type { AgentRecommendation } from '../types.js';
import { isOutOfStock } from './productExtract.js';

/**
 * エージェントの推薦を「見積に追加」したときのメモ欄文言（260728 クライアント要望）。
 *
 * クライアントの意向:
 *   「100%の正確性は保証できない（在庫切れ・廃番・価格改定）」点は理解しており、
 *   見積に追加した際にメモ欄へその旨を自動記載する運用でカバーしたい。
 *
 * そこで、Webから取得した情報である旨・取得日・要確認である旨を必ず残す。
 * 取得日を入れるのは、後から見たときに情報の鮮度を判断できるようにするため
 * （見積は長期間残るので「いつ時点の価格か」が分からないと使えない）。
 *
 * @param now テスト用に注入可能（既定は現在時刻）。
 */
export function buildAgentItemMemo(rec: Pick<AgentRecommendation, 'reason' | 'availability' | 'verified'>, now: Date = new Date()): string {
  const parts: string[] = [];

  // 推薦理由（あれば先頭に残す。ユーザーが後から見返す主要情報）。
  const reason = (rec.reason ?? '').trim();
  if (reason) parts.push(reason);

  const dateLabel = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;

  // 在庫切れ・廃番が判明している場合は、より強い注意文にする。
  const soldOut = isOutOfStock(rec.availability);
  if (soldOut) {
    parts.push(`※Web取得情報（${dateLabel}時点）。取得時点で在庫切れ／廃番の表示あり。要確認`);
  } else if (rec.verified) {
    parts.push(`※Web取得情報（${dateLabel}時点）。在庫切れ・廃番・価格改定の可能性があるため要確認`);
  } else {
    // ページで確認できていない＝価格や品番がAIの推測である可能性がある。より強く注意喚起する。
    parts.push(`※未確認情報（${dateLabel}時点・AI提案）。商品名／品番／価格は必ず一次情報でご確認ください`);
  }

  // メモ欄は単一行の <input> なので、改行はブラウザに除去され区切りが消える
  // （理由と注記が繋がって読めなくなる・260728 敵対レビュー B5）。' / ' で連結する。
  return parts.join(' / ');
}
