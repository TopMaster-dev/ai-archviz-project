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

export type InpaintOp = 'remove' | 'generate';

export interface InpaintRequest {
  /** 編集対象のベース画像（data URL）。 */
  imageDataUrl: string;
  /** 編集する範囲のマスク（data URL・白=編集する範囲 / 黒=保持）。 */
  maskDataUrl: string;
  /** 'remove'=物体消去（背景で埋める）/ 'generate'=マスク内に prompt/参照で生成。 */
  op: InpaintOp;
  /** generate 時のテキスト指示（例: 木製の椅子を置いて）。remove では未使用。 */
  prompt?: string;
  /** generate 時の参照画像（差し替える家具など・data URL）。任意。 */
  referenceImageDataUrl?: string | null;
}

export interface InpaintResult {
  /** 編集後の画像（data URL）。範囲外の貼り戻しは呼び出し側で行う。 */
  imageDataUrl: string;
  /** 使ったエンジン識別子（利用ログ・単価表用）。 */
  engine: string;
  /** 1回あたりの概算コスト（USD・分かる場合）。利用ログ用。 */
  costUsd?: number | null;
}

/** マスクベース編集エンジン。実装は各プロバイダ（Replicate など）。サーバー側でのみ呼ぶ。 */
export interface InpaintEngine {
  /** エンジン識別子（例: replicate:lama, replicate:flux-fill）。 */
  id: string;
  /** このエンジンが対応する操作。 */
  supports: InpaintOp[];
  /** 参照画像（差し替える特定商品画像）を実際に使えるか（既定=false）。false のエンジンに参照が来たら実行を拒否しフェイルソフトさせる。 */
  acceptsReference?: boolean;
  /** 1回あたりの概算コスト（USD）。ログ表示用の目安（正確な請求はプロバイダ側）。 */
  approxCostUsd: number;
  /** 実行。失敗時は throw（呼び出し側で Gemini へフェイルソフト）。 */
  run: (apiKey: string, req: InpaintRequest) => Promise<InpaintResult>;
}
