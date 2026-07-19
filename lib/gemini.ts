import type { AiEditObjectReference, AgentCatalogEntry, AgentRecommendation } from '../types.js';
import { buildAiEditReferenceGuide, buildHarmonizePrompt, buildNaturalizePrompt, buildEnhanceDetailPrompt, describeObjectPlacements } from './aiEditPrompt.js';
import { resolveAgentRecommendations } from './agentCatalog.js';
import { resolveAttachmentMime, isGeminiInlineSupported, parseDataUrl } from './agentAttachments.js';

// ---------------------------------------------------------------------------
// AI モデルの使い分け（管理表 row 209/258「AIAPIの最適化・選択」）。
// タスクごとに「品質重視の画像モデル」と「低コスト・低レイテンシのテキストモデル」を分け、
// いずれもサーバー環境変数で個別に差し替え可能にする（再デプロイ無しでコスト/品質/レイテンシを調整）。
//   画像生成・編集（高品質が必須）      : GEMINI_IMAGE_MODEL             既定 gemini-3-pro-image-preview
//   配置キャプション（軽量・高頻度）    : GEMINI_PLACEMENT_CAPTION_MODEL 既定 gemini-2.5-flash
//   AIエージェント相談（推論重視）      : GEMINI_AGENT_MODEL             既定=キャプションと同じ
// エージェントだけ別 env にしてあるのは、ローンチ後に相談の回答品質を上げたい場合、
// 影響範囲を generateAgentReply に閉じたまま上位モデルへ差し替えられるようにするため。
// 参考: requirements/AI_API_使い分け検討_260618.md
// ---------------------------------------------------------------------------
const resolveEnvModel = (name: string): string | undefined =>
  (typeof process !== 'undefined' ? process.env?.[name]?.trim() : undefined) || undefined;

/** 画像生成・編集モデル（AIレンダリング / AI画像編集）。品質重視。env GEMINI_IMAGE_MODEL で上書き可。 */
export const GEMINI_IMAGE_MODEL = resolveEnvModel('GEMINI_IMAGE_MODEL') || 'gemini-3-pro-image-preview';

// トークン計測（管理表 row 58）。Gemini generateContent 応答の usageMetadata からトークン数を取り出す。
export interface TokenUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}
export function readUsage(result: unknown): TokenUsage | null {
  const u = (result as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown } })
    ?.usageMetadata;
  if (!u) return null;
  return {
    promptTokenCount: Number(u.promptTokenCount) || 0,
    candidatesTokenCount: Number(u.candidatesTokenCount) || 0,
    totalTokenCount: Number(u.totalTokenCount) || 0,
  };
}

/**
 * 配置キャプション生成用の軽量テキストモデル（高頻度・低コスト）。
 * env `GEMINI_PLACEMENT_CAPTION_MODEL` で上書き可能。
 * 既定は現行モデル gemini-2.5-flash（旧 gemini-2.0-flash は提供終了=404 のため更新・260617）。
 */
export function resolvePlacementCaptionModel(): string {
  return resolveEnvModel('GEMINI_PLACEMENT_CAPTION_MODEL') || 'gemini-2.5-flash';
}

/**
 * AIエージェント相談チャット用モデル。配置キャプションとは別に差し替え可能にし、
 * ローンチ後に相談の回答品質だけを上位モデルへ上げられるようにする（影響範囲は generateAgentReply のみ）。
 * env `GEMINI_AGENT_MODEL` で上書き可能。既定はキャプションモデルと同じ（テストマーケ期は単一ベンダー運用）。
 */
export function resolveAgentModel(): string {
  return resolveEnvModel('GEMINI_AGENT_MODEL') || resolvePlacementCaptionModel();
}

/**
 * Gemini 画像応答から生成画像のデータURLを取り出す。画像が無い場合は、原因（finishReason・
 * セーフティ等のブロック理由・モデルが返したテキスト）を含む日本語エラーを投げる。
 * UI の「全く書き出されない」を、原因の分かる具体的なメッセージにするため（260619 クライアント報告対応）。
 */
function extractGeneratedImage(result: any): string {
  const candidate = result?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part.inlineData?.data && part.inlineData?.mimeType) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
      if (typeof part.text === 'string' && part.text.includes('data:image')) {
        return part.text;
      }
    }
  }
  // 画像が無い: 可能な限り原因を具体的に伝える。
  const finish = candidate?.finishReason;
  const block = result?.promptFeedback?.blockReason;
  const textNote = Array.isArray(parts)
    ? parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join(' ').trim().slice(0, 200)
    : '';
  const reasons: string[] = [];
  if (block) reasons.push(`ブロック理由: ${block}`);
  if (finish && finish !== 'STOP') reasons.push(`finishReason: ${finish}`);
  if (!reasons.length && !candidate) reasons.push('候補なし（応答が空）');
  const detail = reasons.join(' / ') || '原因不明';
  const hint =
    finish === 'IMAGE_SAFETY' || block
      ? 'セーフティフィルタにより画像が生成されませんでした。別の画像や指示でお試しください。'
      : finish === 'MAX_TOKENS'
        ? '生成が途中で打ち切られました。画像サイズを下げて再試行してください。'
        : '画像が生成されませんでした。少し時間をおいて再試行してください。';
  throw new Error(`${hint}（${detail}）${textNote ? ` 応答: ${textNote}` : ''}`);
}

export function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const m = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
  if (m) {
    return { mimeType: m[1], base64: m[2] };
  }
  const stripped = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { mimeType: 'image/png', base64: stripped };
}

/** エージェント添付ファイル（クライアントから {name, dataUrl} で受け取る）。 */
export interface AgentAttachment {
  name?: string;
  dataUrl: string;
}

/** ベース画像と配置座標から、オブジェクトごとの短い日本語位置説明を生成（失敗時は {}） */
/** 検出した開口（窓・ドア・ガラス・建具）の外接矩形（画像全体に対する正規化 0〜1）。 */
export interface DetectedOpeningRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function generatePlacementNarratives(
  apiKey: string,
  params: { baseImageDataUrl: string; objects: AiEditObjectReference[] }
): Promise<{
  narratives: Record<string, string>;
  occluded: Record<string, boolean>;
  openings: Record<string, DetectedOpeningRect[]>;
}> {
  if (!params.objects.length) return { narratives: {}, occluded: {}, openings: {} };

  const spec = params.objects
    .map((o, i) => {
      const pid = JSON.stringify(o.id);
      return `- objectId: ${pid} / 参照番号: ${i + 1} / ${describeObjectPlacements(o)}`;
    })
    .join('\n');

  // 事前解析の強化（260707→260708 クライアント要望）: 位置・向き・前後に加え、重なり時の「差し替える対象」と
  // 「触らず保持すべき手前の家具」を明確にさせる（奥の対象を空き場所へ動かす誤りの防止）。あくまで助言・座標が最優先。
  const userText = `あなたは建築インテリアの画像編集アシスタントです。次の「ベース画像」を見て、各 objectId のフォーカス領域に写っているものを分析し、日本語で短くまとめてください。
各 objectId について、次を1行（120文字以内）に凝縮します: (1)フォーカス領域が指す“差し替える対象”（家具に限らず照明・小物等も含む。例: 奥の白いラウンジチェア）(2)画面上のおおまかな位置と距離感（例: 中央やや右・中景）(3)向き（例: 正面がやや左向き）(4)前後関係と、触らず保持すべき手前の家具（重なりがあれば、対象が手前か奥か・手前に何が重なっているか。例: 手前にソファが重なる＝ソファは保持）(5)同じ種類の家具・オブジェクトが範囲の外の別の場所にもある場合は、それらは編集対象ではない旨（例: 左に別の椅子があるが対象ではない）。
重要: 対象は必ずしも最前面とは限らない。手前の家具の後ろに一部隠れている“奥の対象”でも、その対象自体を差し替える前提で分析し、対象を空いた場所へ動かす想定はしない。範囲外にある“似た種類の家具・オブジェクト”は対象ではないので、それらを差し替える前提にしない。位置・向きは原則そのまま維持する前提。座標の数値は繰り返さない。判断が難しい項目は書かない（誤った断定はしない）。
さらに各 objectId について occluded を判定する: その“差し替える対象”が、別の家具・オブジェクトの後ろに一部隠れている（手前の物に重なって遮蔽されている）なら occluded=true、手前に何も重なっておらず全体がはっきり見えているなら occluded=false。判断が難しい場合は false にする。
さらに各 objectId について openings を検出する: そのフォーカス領域が「壁・床・天井などの面」で、その面の内側（または重なる位置）に、屋外や隣室が見える“本物の建築開口”＝窓・ガラス窓・掃き出し窓・ドア（開き戸/引き戸/ガラスドア）・サッシ建具がある場合のみ、それぞれの外接矩形を openings に列挙する。各矩形は画像全体を基準とした正規化座標 {"x":左端,"y":上端,"w":幅,"h":高さ}（各0〜1）で、ガラス面と建具枠を含む開口全体を過不足なく囲むタイトな矩形にする（周囲の壁を余分に含めない）。
【誤検出を避ける（重要）】次のものは開口ではないので openings に含めない: 鏡・姿見、絵画・写真・ポスター・タペストリー・壁掛けアート、テレビ・モニター・スクリーン、時計、棚・キャビネット・収納の扉、壁の装飾パネルや飾り、単に色や明るさが違うだけの壁面、影・映り込み。判断に迷う矩形は列挙しない（“本物の窓・ドアだと確信できるものだけ”を挙げ、疑わしきは含めない＝取りこぼしの方が誤検出より安全）。開口が無ければ openings は空配列 []。フォーカス領域が面（壁/床/天井）でない（家具の差し替え等）場合も空配列。

【フォーカス領域の仕様（正規化座標が最優先。この分析は参考用）】
${spec}

次の JSON のみを返してください。前後に説明文やマークダウンを付けないこと。
{"descriptions":[{"objectId":"<idと同じ文字列>","text":"<日本語1行・120文字以内>","occluded":true または false,"openings":[{"x":0.0,"y":0.0,"w":0.0,"h":0.0}]}]}`;

  const base = parseImageDataUrl(params.baseImageDataUrl);
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: userText },
          { inlineData: { mimeType: base.mimeType, data: base.base64 } },
        ],
      },
    ],
    generationConfig: {
      // 開口検出は誤検出（幻覚した窓）が「壁に穴が空く」不具合に直結するため、低温で決定論寄りにして精度を優先（260718 監査対応）。
      temperature: 0.2,
      responseModalities: ['TEXT'],
    },
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${resolvePlacementCaptionModel()}:generateContent`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { narratives: {}, occluded: {}, openings: {} };
    const result = await response.json();
    const raw = result.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text;
    if (!raw || typeof raw !== 'string') return { narratives: {}, occluded: {}, openings: {} };
    return parsePlacementNarrativesJson(raw);
  } catch {
    return { narratives: {}, occluded: {}, openings: {} };
  }
}

function clamp01(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** モデルが返した openings 配列（{x,y,w,h}）を、健全な DetectedOpeningRect（[0,1] クランプ・正の面積のみ）へ正規化。 */
function parseOpenings(v: unknown): DetectedOpeningRect[] {
  if (!Array.isArray(v)) return [];
  const out: DetectedOpeningRect[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const x = clamp01(o.x);
    const y = clamp01(o.y);
    let w = clamp01(o.w ?? o.width);
    let h = clamp01(o.h ?? o.height);
    // 画像外へはみ出す矩形は内側にクランプ。
    w = Math.min(w, 1 - x);
    h = Math.min(h, 1 - y);
    if (w > 0.002 && h > 0.002) out.push({ x, y, width: w, height: h });
    if (out.length >= 12) break; // 暴走防止（1面あたりの開口上限）
  }
  return out;
}

function parsePlacementNarrativesJson(raw: string): {
  narratives: Record<string, string>;
  occluded: Record<string, boolean>;
  openings: Record<string, DetectedOpeningRect[]>;
} {
  const narratives: Record<string, string> = {};
  const occluded: Record<string, boolean> = {};
  const openings: Record<string, DetectedOpeningRect[]> = {};
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  if (fence) s = fence[1].trim();
  try {
    const parsed = JSON.parse(s) as {
      descriptions?: Array<{ objectId?: string; text?: string; occluded?: unknown; openings?: unknown }>;
    };
    const arr = parsed.descriptions;
    if (!Array.isArray(arr)) return { narratives, occluded, openings };
    for (const row of arr) {
      if (row && typeof row.objectId === 'string') {
        if (typeof row.text === 'string') {
          narratives[row.objectId] = row.text.trim().slice(0, 200); // 暴走防止に上限
        }
        // occluded は true 明示（真偽値/文字列"true"）のときだけ true。曖昧・欠落は false（案1を無闇に発動させない）。
        occluded[row.objectId] = row.occluded === true || row.occluded === 'true';
        const rects = parseOpenings(row.openings);
        if (rects.length > 0) openings[row.objectId] = rects;
      }
    }
  } catch {
    return { narratives, occluded, openings };
  }
  return { narratives, occluded, openings };
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** エージェントの家具推薦（index ベース・カタログ参照）。lib/agentCatalog で実データへ解決する（Tier2）。 */
export interface AgentRecommendationPick {
  index: number;
  name?: string;
  reason?: string;
}

/**
 * AIエージェント相談（建築・内装デザインのアドバイス）。Flash モデルで JSON 応答（管理表 row 208/214）。
 * 直近の会話履歴を contents に変換し、最新のユーザー発話にだけ現在の画像を参考添付する。
 * Tier2（260620）: カタログを渡すと、家具/コーディネート提案時に該当商品を index で推薦する
 * （reply=会話文、recommendations=index付き推薦）。失敗時は全文を reply 扱い（推薦なし）にフォールバック。
 */
/** エージェントの会話 contents を組み立てる（画像/添付は最新ユーザー発話にのみ付与）。 */
function buildAgentContents(params: {
  messages: AgentChatMessage[];
  imageDataUrl?: string | null;
  files?: AgentAttachment[];
}) {
  const files = params.files ?? [];
  const lastIdx = params.messages.length - 1;
  return params.messages.map((m, i) => {
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: m.content }];
    if (m.role === 'user' && i === lastIdx) {
      if (params.imageDataUrl) {
        const img = parseImageDataUrl(params.imageDataUrl);
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
      }
      if (files.length) {
        // 添付ファイル：Gemini が扱える形式は inlineData で本体を渡し、扱えない形式（Officeバイナリ等）は
        // ファイル名だけをテキストで知らせてリクエスト全体が 400 で失敗しないようにする（260702）。
        const unsupported: string[] = [];
        for (const f of files) {
          const { mimeType: dm, base64 } = parseDataUrl(f?.dataUrl || '');
          const mime = resolveAttachmentMime(f?.name, dm);
          if (base64 && isGeminiInlineSupported(mime)) parts.push({ inlineData: { mimeType: mime, data: base64 } });
          else if (f?.name) unsupported.push(f.name);
        }
        const names = files.map((f) => f?.name).filter(Boolean) as string[];
        if (names.length) {
          let hint = `（添付ファイル: ${names.join(', ')}）`;
          if (unsupported.length) {
            hint += `\n※ 次のファイルは形式的にAIが直接読み取れないため、ファイル名のみ共有します: ${unsupported.join(', ')}`;
          }
          parts.push({ text: hint });
        }
      }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

/** テキストから最初の JSON オブジェクトを取り出す（```json フェンスや前後の地の文・出典表記に耐える）。 */
function extractJsonObject(text: string): string | null {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return null;
}

/** Web検索由来の推薦（モデルが直接返した実在商品フィールド）を AgentRecommendation へ正規化。 */
function parseAgentWebRecommendations(v: unknown): AgentRecommendation[] {
  if (!Array.isArray(v)) return [];
  const out: AgentRecommendation[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) continue;
    const rawPrice =
      typeof o.price === 'number'
        ? o.price
        : typeof o.price === 'string'
        ? Number(o.price.replace(/[^0-9.]/g, ''))
        : NaN;
    const url = typeof o.productUrl === 'string' ? o.productUrl.trim() : '';
    out.push({
      name,
      brand: typeof o.brand === 'string' ? o.brand.trim() : '',
      modelNumber: typeof o.modelNumber === 'string' ? o.modelNumber.trim() || undefined : undefined,
      price: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : undefined,
      productUrl: /^https?:\/\//i.test(url) ? url : undefined,
      reason: typeof o.reason === 'string' ? o.reason.trim() || undefined : undefined,
    });
    if (out.length >= 6) break;
  }
  return out;
}

const AGENT_ADVISOR_INTRO = `あなたは建築・内装に精通したプロのAIデザインアドバイザーです。Arise（2D作図→3D→AIパース→概算見積もりの空間デザインツール）のユーザーを支援します。
- 配色・素材・家具・照明・レイアウト・コーディネート、見積もりや進め方の相談に、日本語で具体的かつ実務的に助言する。
- 不要な前置きは避け、要点は短い段落や箇条書きで簡潔に。
- 画像が添付されている場合は、その空間を踏まえて助言する。画像に写っている建材・家具・素材・色・テイストを具体的に読み取る。
- 推薦した商品はユーザーが「見積に追加」ボタンでそのまま概算見積もりへ反映できる。これがツールの強みなので、画像内の建材・家具に対しては積極的に実在商品を提案する。`;

/** 従来のカタログ index 方式（Web検索グラウンディングが使えない環境のフォールバック・捏造防止）。 */
async function catalogAgentReply(
  apiKey: string,
  contents: ReturnType<typeof buildAgentContents>,
  catalog: AgentCatalogEntry[]
): Promise<{ reply: string; recommendations: AgentRecommendation[]; usage: TokenUsage | null }> {
  const catalogBlock = catalog.length
    ? `\n\n【利用可能な家具カタログ（家具提案は必ずこの中から index で指定。ここに無い商品は提案しない）】\n` +
      catalog
        .map(
          (c, i) =>
            `${i}: ${c.name}（${c.type}）${c.brand ? ` / ${c.brand}` : ''}${c.modelNumber ? ` / 品番${c.modelNumber}` : ''}${
              c.price !== undefined ? ` / ¥${c.price.toLocaleString()}` : ''
            }`
        )
        .join('\n')
    : '';
  const system = `${AGENT_ADVISOR_INTRO}
- 家具やコーディネートを提案するときは、上記カタログから該当商品を index で挙げる（カタログに無いものは挙げない）。家具提案が不要な相談では空配列にする。メーカー・品番・価格・商品URLは表示側がカタログから自動付与するため、reason には選定理由のみを簡潔に書く。
- 出力は必ず次の形式の JSON のみ（前後に説明やマークダウンを付けない）:
{"reply":"<会話的な日本語の助言。必須。recommendationsの有無に関わらず必ず入れる>","recommendations":[{"index":<カタログ番号(整数)>,"name":"<見積もりに載せる自然な日本語名>","reason":"<短い推薦理由>"}]}${catalogBlock}`;
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.6, responseMimeType: 'application/json' },
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${resolveAgentModel()}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const t = await response.text().catch(() => '');
    throw new Error(`エージェント応答の取得に失敗しました (${response.status}) ${t.slice(0, 200)}`);
  }
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text;
  if (!text || typeof text !== 'string') throw new Error('エージェントの応答が空でした。');

  let reply = '';
  let picks: AgentRecommendationPick[] = [];
  let parsedOk = false;
  try {
    const parsed = JSON.parse(text) as unknown;
    parsedOk = true;
    if (typeof parsed === 'string') {
      reply = parsed.trim();
    } else if (parsed && typeof parsed === 'object') {
      const r = (parsed as { reply?: unknown }).reply;
      if (typeof r === 'string') reply = r.trim();
      const recs = (parsed as { recommendations?: unknown }).recommendations;
      if (Array.isArray(recs)) {
        picks = recs
          .map((x): AgentRecommendationPick | null => {
            if (!x || typeof x !== 'object') return null;
            const idx = (x as { index?: unknown }).index;
            if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) return null;
            const name = (x as { name?: unknown }).name;
            const reason = (x as { reason?: unknown }).reason;
            return {
              index: idx,
              name: typeof name === 'string' ? name : undefined,
              reason: typeof reason === 'string' ? reason : undefined,
            };
          })
          .filter((x): x is AgentRecommendationPick => x !== null)
          .slice(0, 6);
      }
    }
  } catch {
    reply = text.trim();
  }
  if (!reply) reply = parsedOk ? '回答を取得できませんでした。もう一度お試しください。' : text.trim();
  const recommendations = resolveAgentRecommendations(catalog, picks);
  return { reply, recommendations, usage: readUsage(result) };
}

/**
 * AIエージェント相談（建築・内装デザインのアドバイス）。
 * 1a（260720 クライアント要望）: 家具/建材の品番・メーカー・価格・URLを **Web検索グラウンディング** で実在情報から提案する。
 * グラウンディングは responseMimeType(JSON) と併用できないため、プロンプトでJSON出力を指示し頑健にパースする。
 * グラウンディングが使えない環境（キー/モデル未対応など）では、従来のカタログ index 方式（catalogAgentReply）へフォールバック。
 * ※ Web由来の品番/価格/URLは正確性を保証しないため、実機での品質確認が前提（在庫・価格・リンク切れ等）。
 */
export async function generateAgentReply(
  apiKey: string,
  params: { messages: AgentChatMessage[]; imageDataUrl?: string | null; catalog?: AgentCatalogEntry[]; files?: AgentAttachment[] }
): Promise<{ reply: string; recommendations: AgentRecommendation[]; usage: TokenUsage | null }> {
  const catalog = params.catalog ?? [];
  const contents = buildAgentContents(params);

  const groundedSystem = `${AGENT_ADVISOR_INTRO}
- 家具・建材を提案するときは、Web検索で「実在する商品」を調べ、メーカー名・品番・参考価格（税込・日本円）・商品ページURLを可能な限り正確に添える。憶測で品番やURLを作らない（検索で確認できたものだけ記載し、不明な項目は空にする）。日本国内で入手しやすい商品を優先する。
- 家具提案が不要な相談では recommendations は空配列にする。
- 出力は必ず次の JSON のみ（前後に説明・マークダウン・出典表記を付けない）:
{"reply":"<日本語の助言。必須>","recommendations":[{"name":"<商品名>","brand":"<メーカー>","modelNumber":"<品番>","price":<参考価格の数値・任意>,"productUrl":"<商品ページURL>","reason":"<短い推薦理由>"}]}`;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${resolveAgentModel()}:generateContent`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: groundedSystem }] },
        contents,
        tools: [{ googleSearch: {} }], // Web検索グラウンディング（1a）
        generationConfig: { temperature: 0.4 },
      }),
    });
    if (response.ok) {
      const result = await response.json();
      const text: string = (result.candidates?.[0]?.content?.parts ?? [])
        .filter((p: { text?: string }) => typeof p.text === 'string')
        .map((p: { text?: string }) => p.text as string)
        .join('\n');
      const jsonStr = text ? extractJsonObject(text) : null;
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr) as { reply?: unknown; recommendations?: unknown };
        const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
        if (reply) {
          return { reply, recommendations: parseAgentWebRecommendations(parsed.recommendations), usage: readUsage(result) };
        }
      }
      // ok だが JSON を取り出せない → フォールバックへ
    }
  } catch {
    /* グラウンディング非対応/ネットワーク等 → フォールバックへ */
  }
  // フォールバック: 従来のカタログ index 方式（グラウンディングが使えなくても提案が動く）。
  return await catalogAgentReply(apiKey, contents, catalog);
}

/** マルチ参照対応のインテリア編集（ベース + スタイル0〜1 + オブジェクト複数） */
export async function generateGeminiImageEdit(
  apiKey: string,
  params: {
    baseImageDataUrl: string;
    styleImageDataUrl: string | null;
    /** コーディネートのスタイル参照画像（複数対応・260707）。指定時はこちらを優先し全て入力に添付する。 */
    styleImageDataUrls?: string[];
    styleMemo?: string;
    objects: AiEditObjectReference[];
    /** Gemini imageConfig.aspectRatio（例: 16:9） */
    aspectRatio?: string;
    /** 例: 1K, 2K, 4K */
    imageSize?: string;
    placementNarratives?: Record<string, string>;
    /** コーディネート（完全お任せ）モード。個別指定なしで空間全体を再コーディネート（row 207/213）。 */
    coordinate?: boolean;
    /** in-context反映（row 211/219）: 過去に高評価した傾向。プロンプト末尾に参考添付。 */
    learnedHints?: string[];
    /** 継ぎ目なじませ（全体を1枚に均一化）パス（260706）。true のとき創作系を使わずベース1枚のみを均一化する。 */
    harmonize?: boolean;
    /** 環境になじませる（1枚の自然な写真に統合）最終パス（260714）。true のときベース1枚のみを、置かれた家具は変えず
     * 接地影・落ち影・前後関係・光/色調・継ぎ目だけ環境へなじませる（harmonize より一歩踏み込む）。 */
    naturalize?: boolean;
    /** 画質を高める（精細化）パス（260710）。true のときベース1枚のみを、内容を変えずに精細化する（見本画像は渡さない）。 */
    enhanceDetail?: boolean;
    /** 「範囲外を変えない（はみ出し防止）」トグル（260708）。true=厳密に閉じ込め、false（既定）=自然な統合を優先。 */
    strictConfine?: boolean;
    /** 画質を保つハイブリッド（260708）: 最初のレンダー画像を「画質・素材の見本」として渡す（形・位置・変更には使わない）。 */
    qualityRefImageDataUrl?: string | null;
  }
): Promise<{ url: string; usage: TokenUsage | null }> {
  // 単一画像パス（harmonize=継ぎ目なじませ / enhanceDetail=精細化）: ベース1枚だけを入力にする＝
  // スタイル・見本・オブジェクト参照など2枚目以降を一切添付しない（＝重ね焼き＝ゴーストが構造的に起きない）。
  const singlePass = !!params.harmonize || !!params.naturalize || !!params.enhanceDetail;
  // スタイル参照は複数対応（260707）。配列があれば優先、無ければ後方互換の単数を1枚として扱う。
  const styleUrls = singlePass
    ? []
    : params.styleImageDataUrls && params.styleImageDataUrls.length > 0
      ? params.styleImageDataUrls
      : params.styleImageDataUrl
        ? [params.styleImageDataUrl]
        : [];
  // 見本（最初のレンダー）は単一画像パスでは使わない。
  const qualityRefUrl = singlePass ? null : params.qualityRefImageDataUrl || null;
  const instruction = params.harmonize
    ? buildHarmonizePrompt()
    : params.naturalize
    ? buildNaturalizePrompt()
    : params.enhanceDetail
    ? buildEnhanceDetailPrompt()
    : buildAiEditReferenceGuide({
        hasStyle: styleUrls.length > 0,
        styleImageCount: styleUrls.length,
        styleMemo: params.styleMemo?.trim() || undefined,
        objects: params.objects,
        placementNarratives: params.placementNarratives,
        coordinate: params.coordinate,
        learnedHints: params.learnedHints,
        strictConfine: params.strictConfine,
        hasQualityRef: !!qualityRefUrl,
      });

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: instruction },
  ];

  const base = parseImageDataUrl(params.baseImageDataUrl);
  parts.push({
    inlineData: { mimeType: base.mimeType, data: base.base64 },
  });

  // 画質を保つ見本（最初のレンダー）は base の直後に添付＝プロンプトの入力順（画像2）と一致させる（260708）。
  if (qualityRefUrl) {
    const qr = parseImageDataUrl(qualityRefUrl);
    parts.push({
      inlineData: { mimeType: qr.mimeType, data: qr.base64 },
    });
  }

  // 均一化パスはベース1枚のみを入力（スタイル/オブジェクト参照は使わない＝全体ドリフト防止）。
  // スタイル参照は複数対応（260707）: 画像2..(1+N) の順で全て添付（プロンプトの入力順と一致）。
  for (const url of styleUrls) {
    const st = parseImageDataUrl(url);
    parts.push({
      inlineData: { mimeType: st.mimeType, data: st.base64 },
    });
  }

  if (!singlePass) {
    for (const o of params.objects) {
      if (!o.imageDataUrl) continue;
      const ob = parseImageDataUrl(o.imageDataUrl);
      parts.push({
        inlineData: { mimeType: ob.mimeType, data: ob.base64 },
      });
    }
  }

  const aspectRatio = params.aspectRatio || '16:9';
  const imageSize = params.imageSize || '2K';

  const payload = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      // 均一化・精細化は最小変更＝低温度で（構図/内容を動かさない）。
      temperature: params.harmonize ? 0.1 : params.naturalize ? 0.15 : params.enhanceDetail ? 0.12 : 0.25,
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio,
        imageSize,
      },
    },
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API 通信エラー: ${response.status} - ${errText}`);
  }

  const result = await response.json();
  return { url: extractGeneratedImage(result), usage: readUsage(result) };
}

export type RenderTimeOfDay = 'day' | 'evening' | 'night';

export type GeminiClayRenderOptions = {
  aspectRatio?: string;
  imageSize?: string;
  /** ユーザーが設定した時間帯（昼/夕方/夜）。窓がアングル外でも室内全体の光に反映する（260717）。 */
  timeOfDay?: RenderTimeOfDay;
};

// 時間帯の明示指定。窓の色からの推論より優先し、窓がアングル内に無くても室内全体の光へ反映する（260717 クライアント要望）。
const RENDER_TIME_OF_DAY_INSTRUCTION: Record<RenderTimeOfDay, string> = {
  day: '【時間帯の指定：昼】この指定を最優先とし、窓ガラスの色からの推論より優先してください。窓がアングル内に無くても、室内全体を明るい自然光（昼光・ニュートラル〜やや涼しい色温度、はっきりした明るさ）で照らしてください。窓が見える場合のみ、青空や明るい屋外を、室内露出に合わせてやや白飛び気味に描写してください。',
  evening: '【時間帯の指定：夕方】この指定を最優先とし、窓ガラスの色からの推論より優先してください。窓がアングル内に無くても、室内全体を夕方の暖色光（オレンジ〜ゴールドの低い色温度、長く柔らかい影、落ち着いた明るさ）で照らしてください。窓が見える場合のみ、夕焼けやマジックアワーの空を描写してください。',
  night: '【時間帯の指定：夜】この指定を最優先とし、窓ガラスの色からの推論より優先してください。窓がアングル内に無くても、室内照明を主光源とした夜の雰囲気（暗めの環境光、暖色の室内灯、強めのコントラスト）で描いてください。窓が見える場合のみ、暗い夜空や遠くの街明かり、窓ガラスへの室内灯の反射を描写してください。',
};

export async function generateGeminiImage(
  apiKey: string,
  baseImageBase64: string,
  userInstruction: string = '',
  options?: GeminiClayRenderOptions
): Promise<{ url: string; usage: TokenUsage | null }> {
  // 時間帯が明示指定されていれば、窓の色推論より優先する一文を差し込む（未指定は従来の推論のみ）。
  const timeOfDayInstruction = options?.timeOfDay ? `${RENDER_TIME_OF_DAY_INSTRUCTION[options.timeOfDay]}\n` : '';
  const proVisualizerPrompt = `
1. 役割と専門性
あなたは、建築ビジュアライゼーション（Architectural Visualization）に特化した、世界最高峰のAIレタッチ・エンジニアです。
ユーザーがアップロードする画像を読み取り、画角や構図、テクスチャの意匠、色、パターンを100%維持しながら、実写写真のような質感、反射、空気感を付与した画像を生成・提案することが任務です。

2. 画質とカメラ設定の共通定義
すべての画像生成において、以下の「物理的なカメラ設定」を前提としてください。
カメラ: 高性能デジタル一眼レフ（DSLR）、35mm単焦点レンズ。
設定: 絞り値 f/8、ISO 100。室内の明るさに露出を合わせてください。
品質: 8k解像度、極めて精細なディテール、フォトリアル、建築写真クオリティ。

3. テクスチャ保護（最優先事項）
ユーザーの意匠を尊重するため、以下のルールを厳守してください。
非破壊的向上: 元の画像のテクスチャ（木目、布の柄、タイルの割り付け、色味）を勝手に変更したり、別の素材に置き換えたりしないでください。
ディテール強化: 素材を「変える」のではなく、表面の微細な凹凸（マイクロサーフェス）、光沢、反射のみを強調してください。
パースの維持: 直線的な建具のラインや家具のスケール感を歪ませないでください。

4. ライティングと影の処理
元の画像はフラットなベースカラー画像です。あなたは自然な太陽光やダウンライトの環境光（Global Illumination）、およびリアルな影（Ambient Occlusion）をゼロから計算して美しく描き込んでください。
元の画像に含まれる物理的なライティング（パストレーシングによる光の回り込み）を正解として扱ってください。
間接照明: 壁や天井の隅（アンビエントオクルージョン）の自然な陰影を深めてください。
反射: 床や金属面への映り込み（レイトレーシング反射）をより鮮明に、かつリアルに表現してください。

5. 窓と屋外風景（時間帯）の表現
${timeOfDayInstruction}元の画像における「窓ガラス」の越しの背景色を基準に、屋外の時間帯と風景を推論して描き込んでください。
- 窓が「白や明るい色」の場合：自然光があふれる昼の風景（青空、樹木など）。室内に露出を合わせたカメラの性質を再現し、やや白飛び気味（オーバーエクスポージャー）で柔らかく表現してください。
- 窓が「黒や暗い色」の場合：夜の風景（暗い空、遠くの街明かりなど）。室内照明が窓ガラスに反射する様子や、夜特有の落ち着いた空気感を描写してください。
- 窓が「オレンジや暖色系」の場合：夕景やマジックアワーの風景（美しい夕焼け空など）。暖かみのある夕日が室内に差し込む様子を表現してください。
いずれの時間帯においても、風景は主張しすぎず、室内のライティング（床に落ちる光や影）と完全に矛盾しないように自然に馴染ませてください。

${userInstruction}
`;

  const genCfg: Record<string, unknown> = {
    temperature: 0.2,
    responseModalities: ['IMAGE'],
  };
  if (options?.aspectRatio?.trim() || options?.imageSize?.trim()) {
    genCfg.imageConfig = {
      aspectRatio: options?.aspectRatio?.trim() || '16:9',
      imageSize: options?.imageSize?.trim() || '2K',
    };
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: proVisualizerPrompt },
          {
            inlineData: {
              mimeType: 'image/png',
              data: baseImageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: genCfg,
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API 通信エラー: ${response.status} - ${errText}`);
  }

  const result = await response.json();
  return { url: extractGeneratedImage(result), usage: readUsage(result) };
}
