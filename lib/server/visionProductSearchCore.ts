import { generateVisionProductReply, resolveAgentModel } from '../gemini.js';
import { parseDataUrl } from '../agentAttachments.js';
import { parseVisionWebDetection, buildVisionFindingsText, type VisionMatchingPage } from '../visionProductSearch.js';
import { resolveProductsFromUrls, buildResolvedProductsText, type ResolvedProduct } from './productResolver.js';
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

/**
 * 提示する候補の数（260729 クライアント要望「精度が高ければ3つほどで十分」）。
 * 少なく出すほど1件あたりの精度が問われるので、順位付け（matchRank）とセットで意味を持つ。
 */
const MAX_CANDIDATES = 3;

/**
 * 「似ている画像」を何枚まで再検索するか（260729）。
 * 1枚につき Vision 1回ぶんの費用がかかるので、増やすほど線形に高くなる。
 * 2枚あれば候補3件はたいてい埋まるので、既定は 2。
 */
const MAX_SIMILAR_EXPANSIONS = 2;

interface VisionCallResult {
  ok: boolean;
  status: number;
  findings: ReturnType<typeof parseVisionWebDetection>;
}

/**
 * Vision Web Detection を1回呼ぶ。画像は「バイト列」でも「URL」でも渡せる。
 * URL 指定（imageUri）は Google 側が取得するので、我々のサーバが第三者へ取りに行くことはない。
 * 失敗しても throw せず ok:false を返す（1枚の失敗で全体を止めない）。
 */
async function callVisionWebDetection(
  apiKey: string,
  image: { content: string } | { imageUri: string },
): Promise<VisionCallResult> {
  const empty = parseVisionWebDetection(null);
  try {
    const body = {
      requests: [
        {
          image: 'content' in image ? { content: image.content } : { source: { imageUri: image.imageUri } },
          features: [{ type: 'WEB_DETECTION', maxResults: 15 }],
        },
      ],
    };
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[visionProductSearch] Vision error', res.status, t.slice(0, 300));
      return { ok: false, status: res.status, findings: empty };
    }
    return { ok: true, status: 200, findings: parseVisionWebDetection(await res.json()) };
  } catch (e: any) {
    console.error('[visionProductSearch] Vision call failed', e?.message || e);
    return { ok: false, status: 500, findings: empty };
  }
}

/**
 * 商品ページになり得ないホスト（260729）。
 *
 * Vision の一致ページには動画・SNS・ピン留めサイトが普通に混ざる（実際クライアントの検証でも
 * YouTube のリンクが並んでいた）。これらを商品カードとして出すと「商品ではないもの」が
 * 見積の候補として並ぶことになり、要望の意図（見た目の一致した"商品"を出す）から外れる。
 * ここで落とすのは「詳細が取れないから」ではなく「そもそも商品ページではないから」。
 */
const NON_PRODUCT_HOSTS = [
  'youtube.com',
  'youtu.be',
  'pinterest.com',
  'pinterest.jp',
  'instagram.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
];

function isNonProductHost(url: string): boolean {
  const h = hostOf(url);
  if (!h) return true; // ホストが取れないURLは出さない
  return NON_PRODUCT_HOSTS.some((bad) => h === bad || h.endsWith(`.${bad}`));
}

/**
 * 見た目の一致だけを根拠に、提示する候補ページを選ぶ（260729）。
 * 並びは matchRank（完全一致→部分一致）優先。同一ホストは1件までにして、
 * 同じ通販サイトの色違い・サイズ違いで候補が埋まるのを防ぐ。
 */
export function pickVisualCandidates(pages: VisionMatchingPage[], max = MAX_CANDIDATES): VisionMatchingPage[] {
  const seenHost = new Set<string>();
  const out: VisionMatchingPage[] = [];
  // matchRank 降順（同順位は Vision の順序を維持＝安定ソート）。
  const ordered = [...(pages ?? [])].sort((a, b) => (b.matchRank ?? 0) - (a.matchRank ?? 0));
  for (const p of ordered) {
    if (!p?.url || isNonProductHost(p.url)) continue;
    const h = hostOf(p.url);
    if (seenHost.has(h)) continue;
    seenHost.add(h);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Vision の一致ページ（＝見た目の根拠）を主、ページから取れた詳細を従として商品カードを作る（260729）。
 *
 * 重要な性質:
 *  - 並び順は Vision の一致順のまま。詳細が取れたかどうかで順位を変えない。
 *  - サムネイルは「Vision が一致と判断した画像」を最優先に使う。利用者はこれを見て似ているか判断するので、
 *    ページ側の og:image（別カットや別商品のことがある）より一致画像の方が正しい。
 *  - 詳細が取れなければ空のまま出す（要望「情報が付与できなくても表示なし（または空欄）で問題ない」）。
 */
export function buildCandidateRecommendations(
  pages: VisionMatchingPage[],
  resolved: ResolvedProduct[],
): AgentRecommendation[] {
  const byUrl = new Map<string, ResolvedProduct>();
  for (const r of resolved) {
    // requestedUrl（渡した元URL）で引く。リダイレクトで finalUrl が変わるため finalUrl では引けない。
    if (r.requestedUrl) byUrl.set(r.requestedUrl, r);
  }
  return pages.map((p) => {
    const r = byUrl.get(p.url);
    const detailed = !!r && r.source !== 'unresolved';
    return {
      // 名称はページから取れた商品名 → ページタイトル → Vision のタイトルの順。
      name: (detailed ? r?.name : '') || r?.pageTitle || p.title || '',
      brand: detailed ? r?.brand : undefined,
      modelNumber: detailed ? r?.sku : undefined,
      price: detailed ? r?.price : undefined,
      // 到達確認できていればその最終URL、できていなければ Vision のURL（表示はするが未確認）。
      productUrl: r?.finalUrl ?? p.url,
      // 見た目の根拠そのもの。ページ側の画像しか無い場合のみそちらへ退く。
      imageUrl: p.imageUrl ?? r?.imageUrl,
      availability: detailed ? r?.availability : undefined,
      reason:
        p.matchRank === 2
          ? '画像が完全に一致したページ'
          : p.matchRank === 1
            ? '画像の一部が一致したページ'
            : '画像から見つかったページ',
      // 「確認済み」は商品ページとして中身まで取れたものだけ。
      // 見た目一致だけの候補は未確認として出す（バッジで区別する）。
      verified: detailed,
    };
  });
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
  imageDataUrl?: string;
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

  const imageDataUrl = params.imageDataUrl || '';

  const { base64, mimeType } = parseDataUrl(imageDataUrl);
  const prompt = (params.prompt || '').trim().slice(0, 500);
  if (!base64 || !mimeType.startsWith('image/')) {
    return { status: 400, body: { success: false, error: '有効な画像が必要です。' } };
  }
  if (base64.length > MAX_IMAGE_B64) {
    return { status: 400, body: { success: false, error: '画像が大きすぎます。縮小して再度お試しください。' } };
  }
  try {
    const first = await callVisionWebDetection(visionKey, { content: base64 });
    if (!first.ok) {
      return { status: 502, body: { success: false, error: `画像解析に失敗しました (${first.status})` } };
    }
    const findings = first.findings;

    /*
     * 【260729 クライアント要望「見た目一致を絶対優先」】ここが本機能の設計の要。
     *
     * 従来: Vision の一致ページを「URLの供給源」としてしか使わず、
     *       ①キーワード検索（Custom Search）で候補を水増しし、
     *       ②商品情報を取り出せたページだけに絞り込み、
     *       ③最終的な候補一覧は Gemini に書かせていた。
     *   だが Gemini は候補ページの見た目を一切見ていない（渡しているのはタイトルとURLの文字列だけ）。
     *   つまり「見た目が似た商品を選ぶ」判断を、見た目を見られない相手にさせていた。
     *   結果、画像一致で見つけた本命ほど②で落ち、モデルが名前から推測した候補が先頭に並んでいた。
     *
     * 変更後: 候補一覧はサーバが Vision の一致順から決定論的に組み立てる。
     *   Gemini の役割は本文（reply）を書くことだけに限定し、候補の取捨選択はさせない。
     *   キーワード検索による水増しは行わない（要望）。
     */
    let candidatePages = pickVisualCandidates(findings.pages, MAX_CANDIDATES);

    /*
     * 【260729・重要】1段目だけでは AI 生成画像に対して候補が出ない。
     *
     * pagesWithMatchingImages は「この画像そのものが載っているページ」を探す機能なので、
     * Web に存在しない AI 生成画像では、そもそも一致するページが無いか、
     * あっても無関係なノイズ（動画・ピン留めサイト）しか返らない。
     * 一方 visuallySimilarImages（似ている画像）は実在する商品写真がちゃんと返る。
     * ただしこちらは画像URLだけで、どのページの画像かが分からない。
     *
     * そこで「似ている画像」をもう一度だけ逆画像検索して、その画像の掲載ページを得る。
     * 実在する写真なので今度は掲載ページが見つかる。
     * これはキーワード検索ではなく画像から画像への連鎖なので、
     * 「見た目の一致を最優先」という方針は保たれる（クライアント要望の趣旨どおり）。
     */
    let expandedFrom = 0;
    if (candidatePages.length < MAX_CANDIDATES && findings.similarImageUrls.length > 0) {
      const seeds = findings.similarImageUrls.slice(0, MAX_SIMILAR_EXPANSIONS);
      const expansions = await Promise.all(
        seeds.map(async (imageUri) => {
          const r = await callVisionWebDetection(visionKey, { imageUri });
          if (!r.ok) return [];
          // 掲載ページのサムネイルは「元画像に似ていると判定された画像」で固定する。
          // 利用者はこれを見て似ているかを判断するので、ページ側の別カットに差し替えてはいけない。
          return r.findings.pages.map((p) => ({ ...p, imageUrl: p.imageUrl ?? imageUri }));
        }),
      );
      expandedFrom = seeds.length;
      candidatePages = pickVisualCandidates([...findings.pages, ...expansions.flat()], MAX_CANDIDATES);
    }

    console.info(
      '[visionProductSearch] pages=%d similar=%d expandedFrom=%d candidates=%d',
      findings.pages.length,
      findings.similarImageUrls.length,
      expandedFrom,
      candidatePages.length,
    );

    // 詳細（価格・品番・メーカー）は取れれば付ける、取れなくても候補は落とさない。
    // 到達確認だけは通すのでリンク切れは出ない（要望「リンクさえあれば詳細は自分で入れる」）。
    const resolved = await resolveProductsFromUrls(
      candidatePages.map((p) => p.url),
      { keepUnresolved: true, limit: Math.max(6, MAX_CANDIDATES) },
    );

    // Vision の一致順を保ったまま、取れた詳細を重ねて商品カードにする。
    const recommendations = buildCandidateRecommendations(candidatePages, resolved);

    const { reply, usage } = await generateVisionProductReply(params.geminiKey, {
      imageDataUrl,
      prompt,
      visionFindingsText: [buildVisionFindingsText(findings), buildResolvedProductsText(resolved)].join('\n\n'),
      model: resolveAgentModel(),
    });

    // 候補が1件も出せなかったときは、その事実と次の一手を明示する。
    // 何も出ないまま一般論のコメントだけが返ると、利用者には「壊れている」ようにしか見えない。
    const noCandidateNote =
      recommendations.length === 0
        ? '\n\n※今回は見た目が一致する商品ページを見つけられませんでした。対象をもう少し大きく囲む、正面から写っている画像を選ぶ、家具1点だけを囲む、のいずれかで見つかりやすくなります。'
        : '';

    return {
      status: 200,
      body: {
        success: true,
        reply: `${reply}${noCandidateNote}`,
        recommendations,
        usage,
        model: resolveAgentModel(),
        resolvedProducts: resolved.slice(0, MAX_CANDIDATES),
      },
    };
  } catch (e: any) {
    // 上流エラー本文はクライアントへ返さない（内部情報の漏えい防止）。
    console.error('[visionProductSearch] failed', e?.message || e);
    return { status: 500, body: { success: false, error: '商品特定に失敗しました。しばらくして再度お試しください。' } };
  }
}
