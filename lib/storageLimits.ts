// ストレージ容量の単一の真実源（管理表 row 31）。
// クライアントの使用量表示・追加ブロック（lib/db/uploads.ts → UploadPanel）と、
// 容量警告メール（api/cron/storage-warning.ts, vite dev mirror, lib/server/storageWarning.ts）で同じ値を使う。
// 依存のない純粋モジュールなので、クライアント・サーバ双方から安全に import できる。
// 注: supabase/schema.sql の storage_warning_targets() の引数デフォルト（73400320=70MB）も
//     この警告しきい値に合わせる。サーバ(cron)は常に明示値を渡すため、SQL側の既定は手動起動時のバックアップ。
// 容量の計測は user_uploads 台帳ではなく Storage バケット実体（storage.objects）の合計を真実源とする
//     （AI生成画像＝台帳に無いオブジェクトも含めて数えるため。schema.sql の storage_usage_self / storage_warning_targets）。

/** アップロード総容量のソフト上限（バイト）。テストマーケ運用で 1人 100MB（260626 クライアント決定）。 */
export const STORAGE_SOFT_LIMIT_BYTES = 100 * 1024 * 1024; // 100MB

/** 上限に対する「接近」とみなす割合（この割合で表示警告・メール通知）。上限の70%=70MB（260626 クライアント決定）。 */
export const STORAGE_WARN_FRACTION = 0.7;

/** 容量警告（接近表示・メール）を発するしきい値（バイト）。既定 = 上限の70% = 70MB。 */
export const STORAGE_WARN_THRESHOLD_BYTES = Math.round(STORAGE_SOFT_LIMIT_BYTES * STORAGE_WARN_FRACTION);

/** 1ファイルあたりの「大きめ」警告しきい値（バイト）。5MB 以上で警告（260716 クライアント要望）。
 *  テクスチャは自動縮小するので情報表示、3Dモデルは縮小できないため確認（続行/中止）に使う。 */
export const FILE_SIZE_WARN_BYTES = 5 * 1024 * 1024; // 5MB
