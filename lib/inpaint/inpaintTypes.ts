/**
 * マスクベース画像編集エンジンの抽象インターフェース（260711・フェーズ1）。
 *
 * 目的: 削除（remove）／マスク内生成（generate）を、Gemini とは別の専用エンジン（LaMa / Bria / FLUX Fill 等）で
 * 処理する。エンジンは差し替え可能にし、クライアントと一緒に実機比較して選定できるようにする（クライアント要望3）。
 * すべてサーバー側で、アプリ保有の共通キー（env）で呼ぶ（ユーザーのキー設定は不要）。
 *
 * ※ 「範囲外を絶対に変えない」保証は、このエンジン出力をそのまま使うのではなく、呼び出し側（クライアント）が
 *    必ず compositeMaskedEdit で範囲外を元画像へ貼り戻すことで担保する（エンジンの挙動に依存しない）。
 */

export type InpaintOp = 'remove' | 'generate' | 'cutout' | 'relight';

export interface InpaintRequest {
  /**
   * 処理対象の画像（data URL）。
   * remove/generate = 編集するベース画像 / cutout = 背景を抜く商品画像 / relight = 合成済み画像。
   */
  imageDataUrl: string;
  /** 編集する範囲のマスク（data URL・白=編集する範囲 / 黒=保持）。remove/generate のみ必須。cutout/relight は不要。 */
  maskDataUrl?: string;
  /**
   * 'remove'=物体消去 / 'generate'=マスク内に prompt/参照で生成 /
   * 'cutout'=商品画像の背景を除去して切り抜き（RGBA）/ 'relight'=合成済み画像を背景の照明へ馴染ませる。
   */
  op: InpaintOp;
  /** generate 時のテキスト指示（例: 木製の椅子を置いて）。remove では未使用。 */
  prompt?: string;
  /** generate 時の参照画像（差し替える家具など・data URL）。任意。 */
  referenceImageDataUrl?: string | null;
  /** relight 時の背景画像（合成先のベース・data URL）。照明の基準に使う。任意。 */
  backgroundImageDataUrl?: string | null;
}

export interface InpaintResult {
  /** 編集後の画像（data URL）。範囲外の貼り戻しは呼び出し側で行う。 */
  imageDataUrl: string;
  /** 使ったエンジン識別子（利用ログ・単価表用）。 */
  engine: string;
  /** 1回あたりの概算コスト（USD・分かる場合）。利用ログ用。 */
  costUsd?: number | null;
}

/** マスクベース編集エンジン。実装は各プロバイダ（Replicate / Bria など）。サーバー側でのみ呼ぶ。 */
export interface InpaintEngine {
  /** エンジン識別子（例: replicate:remove-object, bria:eraser）。 */
  id: string;
  /**
   * このエンジンのAPIキーを保持するサーバー環境変数名（既定 REPLICATE_API_TOKEN）。
   * プロバイダごとにキーが違う（Replicate=REPLICATE_API_TOKEN / Bria=BRIA_API_TOKEN）ため、
   * エンジン解決時にこの名前で env からキーを取り出す（getEngineApiKey）。
   */
  apiKeyEnv?: string;
  /** このエンジンが対応する操作。 */
  supports: InpaintOp[];
  /** 参照画像（差し替える特定商品画像）を実際に使えるか（既定=false）。false のエンジンに参照が来たら実行を拒否しフェイルソフトさせる。 */
  acceptsReference?: boolean;
  /** 1回あたりの概算コスト（USD）。ログ表示用の目安（正確な請求はプロバイダ側）。 */
  approxCostUsd: number;
  /** 実行。失敗時は throw（呼び出し側で Gemini へフェイルソフト）。 */
  run: (apiKey: string, req: InpaintRequest) => Promise<InpaintResult>;
}
