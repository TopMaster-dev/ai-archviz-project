import type { InpaintEngine, InpaintRequest, InpaintResult } from './inpaintTypes.js';

/**
 * Replicate 上のマスクベース編集エンジン（260711・フェーズ1・**サーバー側専用**）。
 * クライアントから import してはいけない（APIキー・Node API を使う）。/api/ai-edit の mode:'inpaint' から呼ぶ。
 *
 * API仕様（2026-07-11 時点の Replicate 公式ドキュメント準拠）:
 * - 認証: Authorization: Bearer <REPLICATE_API_TOKEN>
 * - 画像入力: 1〜2MP は data URI 上限（256KB/1MB）を超えるため Files API でアップロード → 返る urls.get を入力に使う。
 * - 予測作成: POST /v1/models/{owner}/{name}/predictions（公式/コミュニティとも最新版で実行可）＋ Prefer: wait で同期待ち。
 * - 完了しなければ urls.get をポーリング（status: starting/processing/succeeded/failed/canceled）。
 * - 出力: output は URI 文字列（配列のこともある）。認証なしGETでバイト取得（約1時間で自動削除→即取得して data URL 化）。
 * - マスク慣例: **白 = 変更する範囲**（remove=消して埋める / fill=生成）。黒 = 保持。
 */

const REPLICATE_BASE = 'https://api.replicate.com/v1';
// Vercel の関数最大実行時間（vercel.json api/**: maxDuration 60s）に収める予算。wait で大半を待ち、
// 残りをポーリング。総時間が MAX_TOTAL_MS を超えたら諦めて throw → クライアントは Gemini へフェイルソフト。
const WAIT_SECONDS = 50; // Prefer: wait の秒数
const POLL_INTERVAL_MS = 1500;
const MAX_TOTAL_MS = 57_000; // 作成前からの総時間の上限（60s 関数枠に対し余裕を残す）

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function parseDataUrl(dataUrl: string) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('data URL の形式が不正です');
  // Node Buffer をそのまま Blob へ渡すと型が合わない（ArrayBufferLike）ため、素の ArrayBuffer を確保してコピーする。
  const raw = Buffer.from(m[2], 'base64');
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);
  return { mime: m[1], bytes };
}

/** Files API へアップロードし、入力に使える URL（urls.get）を返す。 */
async function uploadFile(apiKey: string, dataUrl: string, filename: string): Promise<string> {
  const { mime, bytes } = parseDataUrl(dataUrl);
  const form = new FormData();
  form.append('content', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(`${REPLICATE_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Replicate files アップロード失敗: ${res.status} ${await safeText(res)}`);
  const data = (await res.json()) as { urls?: { get?: string } };
  const url = data?.urls?.get;
  if (typeof url !== 'string' || !url) throw new Error('Replicate files: URL を取得できませんでした');
  return url;
}

interface Prediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

function outputUrl(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0];
  throw new Error('Replicate: 出力の形式が想定外です');
}

/** 出力（URL または data URL）を data URL 化して返す。 */
async function outputToDataUrl(output: unknown): Promise<string> {
  const url = outputUrl(output);
  if (url.startsWith('data:')) return url;
  const res = await fetch(url); // replicate.delivery は認証不要
  if (!res.ok) throw new Error(`Replicate 出力の取得失敗: ${res.status}`);
  const mime = res.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 予測を作成（Prefer: wait）し、未完了ならポーリングして成功出力の data URL を返す。失敗は throw。 */
async function createAndAwait(
  apiKey: string,
  modelPath: string,
  input: Record<string, unknown>
): Promise<string> {
  const startedAt = Date.now(); // wait も含めた総時間を関数枠(60s)内に収めるため、作成前から計測する。
  const res = await fetch(`${REPLICATE_BASE}/models/${modelPath}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Prefer: `wait=${WAIT_SECONDS}`,
    },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    throw new Error(`Replicate 予測作成失敗: ${res.status} ${await safeText(res)}`);
  }
  let pred = (await res.json()) as Prediction;

  while (pred.status !== 'succeeded') {
    if (pred.status === 'failed' || pred.status === 'canceled') {
      const msg = typeof pred.error === 'string' ? pred.error : 'Replicate 予測が失敗しました';
      throw new Error(msg);
    }
    if (Date.now() - startedAt > MAX_TOTAL_MS) {
      throw new Error('Replicate 予測がタイムアウトしました');
    }
    const getUrl = pred.urls?.get;
    if (!getUrl) throw new Error('Replicate: ポーリング用URLがありません');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const gres = await fetch(getUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!gres.ok) throw new Error(`Replicate ポーリング失敗: ${gres.status}`);
    pred = (await gres.json()) as Prediction;
  }
  return outputToDataUrl(pred.output);
}

/**
 * 共通ランナー: 画像とマスクを Files API へ上げ、指定モデルで実行して結果の data URL を返す。
 * config.buildInput でモデルごとの input を組み立てる（remove は image/mask のみ、fill は prompt も）。
 */
async function runReplicate(
  apiKey: string,
  modelPath: string,
  req: InpaintRequest,
  buildInput: (imageUrl: string, maskUrl: string) => Record<string, unknown>
): Promise<string> {
  if (!req.maskDataUrl) throw new Error('mask が必要です');
  const [imageUrl, maskUrl] = await Promise.all([
    uploadFile(apiKey, req.imageDataUrl, 'base.png'),
    uploadFile(apiKey, req.maskDataUrl, 'mask.png'),
  ]);
  return createAndAwait(apiKey, modelPath, buildInput(imageUrl, maskUrl));
}

/** マスク無し（画像1枚を処理）モデル用ランナー。cutout（背景除去）などに使う。 */
async function runReplicateImageOnly(
  apiKey: string,
  modelPath: string,
  imageDataUrl: string,
  buildInput: (imageUrl: string) => Record<string, unknown>
): Promise<string> {
  const imageUrl = await uploadFile(apiKey, imageDataUrl, 'input.png');
  return createAndAwait(apiKey, modelPath, buildInput(imageUrl));
}

/** 物体消去（LaMa 系）。image + mask（白=消す）→ 背景で埋めた画像。 */
export const replicateRemoveEngine: InpaintEngine = {
  id: 'replicate:remove-object',
  supports: ['remove'],
  approxCostUsd: 0.0006,
  async run(apiKey, req): Promise<InpaintResult> {
    const url = await runReplicate(apiKey, 'zylim0702/remove-object', req, (image, mask) => ({
      image,
      mask,
    }));
    return { imageDataUrl: url, engine: this.id, costUsd: this.approxCostUsd };
  },
};

/** テキスト指示でのマスク内生成（FLUX Fill）。image + mask（白=生成）+ prompt。 */
export const replicateFluxFillEngine: InpaintEngine = {
  id: 'replicate:flux-fill-pro',
  supports: ['generate'],
  approxCostUsd: 0.05,
  async run(apiKey, req): Promise<InpaintResult> {
    const prompt = req.prompt?.trim() || '';
    const url = await runReplicate(apiKey, 'black-forest-labs/flux-fill-pro', req, (image, mask) => ({
      image,
      mask,
      prompt,
      output_format: 'png',
    }));
    return { imageDataUrl: url, engine: this.id, costUsd: this.approxCostUsd };
  },
};

/**
 * 商品画像の背景除去＝切り抜き（cutout・フェーズ2）。image → RGBA（背景透明）PNG。
 * 決定論合成で「そのまま貼る」ための素材を作る（モデルは生成に関与しない）。安価（約 $0.0005/回）。
 */
export const replicateCutoutEngine: InpaintEngine = {
  id: 'replicate:background-remover',
  supports: ['cutout'],
  approxCostUsd: 0.0005,
  async run(apiKey, req): Promise<InpaintResult> {
    const url = await runReplicateImageOnly(apiKey, '851-labs/background-remover', req.imageDataUrl, (image) => ({
      image,
      // RGBA=背景を透明にして返す（合成でそのまま重ねられる）。threshold 0＝アルファを二値化せず滑らかに残す。
      background_type: 'rgba',
      threshold: 0,
      format: 'png',
    }));
    return { imageDataUrl: url, engine: this.id, costUsd: this.approxCostUsd };
  },
};

/**
 * 合成済み画像を背景の照明へ馴染ませる（relight・IC-Light 系）。フェーズ2の「任意・既定OFF」トグル。
 * ※ 未検証のダークシップ: 実キー（REPLICATE_API_TOKEN）＋ VITE_ENABLE_RELIGHT=true で有効化して実機確認する前提。
 *    入力スキーマ（subject/background の項目名）はモデル更新で変わりうる。失敗しても合成結果は保たれる設計
 *    （呼び出し側で relight 失敗時は合成のまま採用）。有効化前に必ずライブで出力を確認すること。
 */
export const replicateIcLightEngine: InpaintEngine = {
  id: 'replicate:ic-light-background',
  supports: ['relight'],
  acceptsReference: true,
  approxCostUsd: 0.01,
  async run(apiKey, req): Promise<InpaintResult> {
    const subject = req.imageDataUrl;
    const background = req.backgroundImageDataUrl || req.imageDataUrl;
    const [subjectUrl, bgUrl] = await Promise.all([
      uploadFile(apiKey, subject, 'subject.png'),
      uploadFile(apiKey, background, 'bg.png'),
    ]);
    const url = await createAndAwait(apiKey, 'zsxkib/ic-light-background', {
      subject_image: subjectUrl,
      background_image: bgUrl,
      prompt: req.prompt?.trim() || 'natural interior lighting, photorealistic',
    });
    return { imageDataUrl: url, engine: this.id, costUsd: this.approxCostUsd };
  },
};
