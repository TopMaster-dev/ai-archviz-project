import { generateVisionProductReply, resolveAgentModel } from '../gemini.js';
import { parseDataUrl } from '../agentAttachments.js';
import { parseVisionWebDetection, buildVisionFindingsText } from '../visionProductSearch.js';
import { resolveProductsFromUrls, buildResolvedProductsText, type ResolvedProduct } from './productResolver.js';
import { findProductPageCandidates, buildProductQuery } from './customSearch.js';
import type { AgentRecommendation } from '../../types.js';

/**
 * 画像内の商品を「特定して探す」処理の共有コア（260726）。
 * Cloudinary Vision（Web Detection＝逆画像検索）→ Gemini 合成。/api/agent（mode=vision-product）と
 * dev サーバ（vite.config.ts）から共通で呼ぶ。単体の Vercel 関数は作らない（Hobby の関数上限に配慮し /api/agent へ相乗り）。
 *
 * 運用: Vision は運営の Google Cloud キー（別課金）。キー未設定なら graceful に disabled を返す。
 * 【重要】運営コストを消費するため、本番公開前に呼び出し元（/api/agent）側で認証/レート制限を入れること（全API共通の宿題）。
 */

const MAX_IMAGE_B64 = 8 * 1024 * 1024;

/** URL のホスト（www を除く）。同じ商品ページかどうかの照合に使う。 */
function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * モデルの出力（推薦）に、ページから実測した確定値を上書きで反映する（260728 要望②③）。
 *
 * 方針は「モデルにURLと数値を書かせない」。
 *  - URL: モデルが書いたものは採用せず、実際に到達できたページのURLだけを使う。
 *         同一ホストの実測商品があればそれに差し替え、無ければ URL を落とす（404 を出さない）。
 *  - 価格/品番/メーカー/画像: 実測値があれば必ず優先（モデルの推測を上書き）。
 * 実測が1件も無い場合は、モデルの推薦から URL を外したうえでそのまま返す（名称は手掛かりとして有用）。
 */
export function mergeResolvedIntoRecommendations(
  recommendations: AgentRecommendation[],
  resolved: ResolvedProduct[],
  opts: { resolvedReason?: string } = {},
): AgentRecommendation[] {
  const list = Array.isArray(recommendations) ? recommendations : [];
  const used = new Set<number>();

  const merged = list.map((r) => {
    // 対応付けは「同一ホスト」だけ。ホストが一致しない実測を当てはめてはいけない
    // （260728 敵対レビュー B1）。以前は余った実測を順番に割り当てていたため、
    // 「Amazonのソファカバーの商品名・URL」と「モデルが推測したカリモクのメーカー/品番/価格」が
    // 1枚のカードに混ざり、しかも『商品ページ確認済み』のバッジが付く、という
    // 元の不具合より悪い状態が作れてしまっていた。
    // 既に検証済みの推薦（カタログ経路＝ユーザーが登録した実データ）はそのまま通す。
    // ここで URL を外すと、運営が手入力した本物の商品URLが失われる（260728 敵対レビュー B3）。
    if (r.verified) return r;

    const idx = resolved.findIndex((p, i) => !used.has(i) && hostOf(p.finalUrl) === hostOf(r.productUrl));
    if (idx < 0) {
      // 実測で裏取りできない推薦は、URLを外し「未確認」として出す（作文URLは渡さない）。
      return { ...r, productUrl: undefined, verified: false };
    }
    used.add(idx);
    const p = resolved[idx];
    // 同一ホストで裏取りできたので、実測値で上書きする（欠けている項目のみモデル値を残す）。
    return {
      ...r,
      name: p.name || r.name,
      brand: p.brand || r.brand,
      modelNumber: p.sku || r.modelNumber,
      price: p.price ?? r.price,
      productUrl: p.finalUrl, // 到達確認済みの個別URLのみ
      imageUrl: p.imageUrl,
      availability: p.availability,
      verified: true,
    };
  });

  // 対応付かなかった実測商品は「独立した候補」として出す（モデルの推測と混ぜない）。
  for (let i = 0; i < resolved.length; i++) {
    if (used.has(i)) continue;
    const p = resolved[i];
    if (!p.name) continue;
    merged.push({
      name: p.name,
      brand: p.brand,
      modelNumber: p.sku,
      price: p.price,
      productUrl: p.finalUrl,
      imageUrl: p.imageUrl,
      availability: p.availability,
      reason: opts.resolvedReason ?? '検索結果の商品ページから取得',
      verified: true,
    });
  }
  return merged.slice(0, 8);
}

function resolveVisionApiKey(): string {
  return (
    process.env.GOOGLE_VISION_API_KEY ||
    process.env.GOOGLE_CLOUD_VISION_API_KEY ||
    process.env.VISION_API_KEY ||
    ''
  ).trim();
}

export interface VisionSearchResult {
  status: number;
  body: Record<string, unknown>;
}

export async function runVisionProductSearch(params: {
  imageDataUrl: string;
  prompt: string;
  geminiKey: string;
}): Promise<VisionSearchResult> {
  const visionKey = resolveVisionApiKey();
  if (!visionKey) {
    return { status: 200, body: { success: false, disabled: true, error: '画像からの商品特定機能は現在無効です。' } };
  }
  if (!params.geminiKey) {
    return { status: 400, body: { success: false, error: 'Gemini APIキーが見つかりません。' } };
  }
  const { base64, mimeType } = parseDataUrl(params.imageDataUrl || '');
  const prompt = (params.prompt || '').trim().slice(0, 500);
  if (!base64 || !mimeType.startsWith('image/')) {
    return { status: 400, body: { success: false, error: '有効な画像が必要です。' } };
  }
  if (base64.length > MAX_IMAGE_B64) {
    return { status: 400, body: { success: false, error: '画像が大きすぎます。縮小して再度お試しください。' } };
  }
  try {
    const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(visionKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: base64 }, features: [{ type: 'WEB_DETECTION', maxResults: 15 }] }] }),
    });
    if (!visionRes.ok) {
      const t = await visionRes.text().catch(() => '');
      console.error('[visionProductSearch] Vision error', visionRes.status, t.slice(0, 300));
      return { status: 502, body: { success: false, error: `画像解析に失敗しました (${visionRes.status})` } };
    }
    const findings = parseVisionWebDetection(await visionRes.json());

    // 【260728 要望②】Vision が返すのは「一致画像のあるページのタイトルとURL」だけで、本文は含まれない。
    // 従来はそれをそのまま Gemini に渡していたため、価格・品番・メーカーはタイトルからの推測になっていた。
    // ここで実際にページを開き、構造化データ（schema.org/Product）から確定値を取り出して渡す。
    // 開けなかったURLは提示対象から外れる＝リンク切れを出さない（到達確認を兼ねる・要望④）。
    // 候補URLを2系統から集める（260728 クライアント承認）。
    //  (a) Vision の逆画像検索が見つけたページ（画像が一致する＝同じ商品である確度が高い）
    //  (b) Vision の推定名・キーワードで Custom Search した「実際に売っているページ」
    // (a) だけだと Pinterest やまとめサイト（構造化データ無し＝価格も品番も取れない）に偏るため、
    // (b) で商品ページの候補を補う。未設定なら (b) は空になり、従来どおり (a) だけで動く。
    const searchQueries = [
      buildProductQuery([findings.bestGuess[0], findings.entities[0]]),
      buildProductQuery([findings.entities[0], findings.entities[1], '通販']),
    ].filter(Boolean);
    const searchHits = await findProductPageCandidates(searchQueries);

    // 値の確定は従来どおり productResolver が行う（実際にページを開いて構造化データを読む＋到達確認）。
    // 検索はあくまで候補URLを増やすだけなので、未検証の情報が利用者へ出ることはない。
    const resolved = await resolveProductsFromUrls([
      ...findings.pages.map((p) => p.url),
      ...searchHits.map((h) => h.url),
    ]);

    const { reply, recommendations, usage } = await generateVisionProductReply(params.geminiKey, {
      imageDataUrl: params.imageDataUrl,
      prompt,
      visionFindingsText: [buildVisionFindingsText(findings), buildResolvedProductsText(resolved)].join('\n\n'),
      model: resolveAgentModel(),
    });

    // 取得済みの確定情報をクライアントへも返す（サムネイル表示・個別URL・見積へのそのまま反映に使う）。
    // モデルの出力より、こちらの実測値を優先させるため recommendations とは別に渡す。
    return {
      status: 200,
      body: {
        success: true,
        reply,
        recommendations: mergeResolvedIntoRecommendations(recommendations, resolved, {
          resolvedReason: '画像と一致した商品ページから取得',
        }),
        usage,
        model: resolveAgentModel(),
        visionPages: findings.pages.slice(0, 5),
        resolvedProducts: resolved.slice(0, 6),
      },
    };
  } catch (e: any) {
    // 上流エラー本文はクライアントへ返さない（内部情報の漏えい防止）。
    console.error('[visionProductSearch] failed', e?.message || e);
    return { status: 500, body: { success: false, error: '商品特定に失敗しました。しばらくして再度お試しください。' } };
  }
}
