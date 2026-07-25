// AIエージェントの「ルールベース振り分け」（260725・クライアント要望①）。
// AIに複雑さを判定させるとその判定自体に別途モデルコストがかかるため、"測れる客観的な指標" だけで
// (a) 使用モデル（高速・低コストの Flash / 高精度の Pro）と (b) Web検索（グラウンディング）の要否を決める。
//
// 判定に使う客観指標（クライアント指定）:
//  - プロンプトの文字数
//  - 特定の単語（探して/検索して 等の検索意図、比較/検討 等の高負荷意図）
//  - 添付データの総容量（バイト）
//  - 添付ファイル数
//  - 画像以外の書類（PDF/テキスト/コード/資料）の有無
//  - 画像の解像度（サーバでは復号せず、画像添付の総バイトを代理指標にする）
//
// しきい値は保守的な既定。将来 env で調整できるよう関数引数（thresholds）で受けられるようにしておく。

export type AgentTier = 'flash' | 'pro';

export interface AgentRouteInput {
  /** 最新のユーザー発話（振り分けの主対象） */
  text: string;
  /** 添付ファイル数 */
  fileCount: number;
  /** 添付の総容量（生バイト概算） */
  totalAttachmentBytes: number;
  /** 画像以外の書類（PDF/テキスト/コード/資料）が含まれるか */
  hasNonImageDoc: boolean;
  /** 画像（グラウンディング画像 or 画像添付）が含まれるか */
  hasImage: boolean;
}

export interface AgentRouteDecision {
  tier: AgentTier;
  /** Web検索（グラウンディング）を有効にするか＝"必要な時だけ" 発火させコストを抑える */
  useSearch: boolean;
  /** 判定理由（ログ/計測/デバッグ用） */
  reasons: string[];
}

export interface AgentRouteThresholds {
  /** これを超える総添付容量は「高負荷」＝Pro */
  proTotalBytes: number;
  /** これ以上のファイル数は「高負荷」＝Pro */
  proFileCount: number;
  /** これを超えるプロンプト文字数は「複雑」＝Pro */
  proTextLength: number;
}

export const DEFAULT_AGENT_ROUTE_THRESHOLDS: AgentRouteThresholds = {
  proTotalBytes: 4 * 1024 * 1024, // 4MB 超の添付は重い（高解像度画像・重い資料）
  proFileCount: 3, // 3件以上の同時添付は統合負荷が高い
  proTextLength: 600, // 長文の相談は複雑な意図を含みやすい
};

// 検索（実在商品・情報の取得）意図を示す語。1つでも該当すれば Web検索を有効化する。
// 検索/商品特定の意図が明確な語のみ（'教えて' 等の汎用語は誤検知するため含めない）。
// 部分一致で誤検知しやすい語（'いくら'→'いくらでも' 等）は、価格文脈が明確な形に絞る（260725 敵対レビュー指摘）。
const SEARCH_KEYWORDS = [
  '探し', '探す', 'さがし', '検索', 'ググっ', 'ぐぐっ',
  'おすすめ商品', 'おすすめの', 'オススメ商品', '売っ', '購入', '買え', '買う', '通販', '販売',
  '商品', '製品', 'メーカー', '品番', '型番', '価格', '値段', '相場',
  'いくらぐらい', 'いくらくらい', 'いくらですか', 'おいくら', 'いくら？', 'いくら?',
  'url', 'ｕｒｌ', '商品リンク', '商品ページ',
  'search', 'find product', 'where to buy', 'price of', 'product', 'model number', 'purchase',
];

// 家具・建材など「モノ」の提案に繋がりやすい語（検索を有効化しておくと実在商品提案が活きる）。
// 'ライト' は 'ハイライト' 等に部分一致するため含めない（'照明'/'lighting' で十分カバー・260725 敵対レビュー指摘）。
const PRODUCT_INTENT_KEYWORDS = [
  '家具', 'ソファ', 'チェア', '椅子', 'テーブル', 'デスク', '棚', '収納', 'ベッド', '照明', 'ラグ', 'カーテン',
  '建材', '床材', '壁材', 'タイル', 'フローリング', 'クロス', '壁紙', '塗料',
  'furniture', 'sofa', 'chair', 'table', 'desk', 'shelf', 'lighting', 'rug', 'tile', 'flooring',
];

// 高負荷・複雑な思考を要する意図を示す語（該当すれば Pro）。
// '詳しく'/'詳細' 等の日常的な言い換え要求は Pro を無駄に誘発する（常時課金）ため含めない（260725 敵対レビュー指摘）。
const COMPLEX_KEYWORDS = [
  '比較', '比べ', 'くらべ', '検討', '分析', '解析',
  '複数', 'それぞれ', 'まとめて', '一覧', '整理', '根拠', '提案書', 'コンセプト',
  'compare', 'comparison', 'analyze', 'analysis', 'multiple', 'summarize', 'evaluate',
];

function includesAny(haystack: string, needles: string[]): boolean {
  const s = haystack.toLowerCase();
  return needles.some((n) => s.includes(n.toLowerCase()));
}

/**
 * 客観指標だけでモデル（Flash/Pro）と Web検索の要否を決める（AIに複雑さを判定させない）。
 */
export function analyzeAgentRequest(
  input: AgentRouteInput,
  thresholds: AgentRouteThresholds = DEFAULT_AGENT_ROUTE_THRESHOLDS,
): AgentRouteDecision {
  const text = typeof input.text === 'string' ? input.text : '';
  const reasons: string[] = [];

  // --- モデル振り分け（Pro に上げる客観条件のいずれか） ---
  let tier: AgentTier = 'flash';
  if (input.totalAttachmentBytes > thresholds.proTotalBytes) {
    tier = 'pro';
    reasons.push(`大容量の添付(${Math.round(input.totalAttachmentBytes / (1024 * 1024))}MB)`);
  }
  if (input.fileCount >= thresholds.proFileCount) {
    tier = 'pro';
    reasons.push(`多数の添付(${input.fileCount}件)`);
  }
  if (input.hasNonImageDoc) {
    tier = 'pro';
    reasons.push('画像以外の書類の添付');
  }
  if (text.length > thresholds.proTextLength) {
    tier = 'pro';
    reasons.push(`長文の相談(${text.length}文字)`);
  }
  if (includesAny(text, COMPLEX_KEYWORDS)) {
    tier = 'pro';
    reasons.push('高負荷・複雑な意図の語');
  }

  // --- Web検索（グラウンディング）の要否 ---
  // 検索意図/商品意図があるときだけ検索する（雑談・抽象的な相談では検索しない＝グラウンディング枠の節約）。
  const useSearch = includesAny(text, SEARCH_KEYWORDS) || includesAny(text, PRODUCT_INTENT_KEYWORDS);
  if (useSearch) reasons.push('検索/商品意図の語→Web検索ON');
  else reasons.push('検索意図なし→Web検索OFF(カタログ提案)');

  return { tier, useSearch, reasons };
}
