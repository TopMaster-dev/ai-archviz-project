#!/usr/bin/env bash
#
# Arise DB バックアップ（管理表 row 29）。
#
# Supabase(PostgreSQL) を pg_dump で custom 形式（圧縮・pg_restore で復元可）でダンプする。
# Supabase 無料プランは自動バックアップが無いため、本スクリプトを日次スケジュール
# （GitHub Actions / サーバ cron 等）で実行して取得する。環境に依存しないので手動・他CIでも再利用可。
#
# 必須環境変数:
#   SUPABASE_DB_URL  接続文字列(URI)。必ず「セッションプーラー(:5432)」または「直接接続(:5432)」を使うこと。
#                    トランザクションプーラー(:6543)は pg_dump 非対応（prepared statement を使うため失敗する）。
# 任意環境変数:
#   BACKUP_DIR       出力先ディレクトリ（既定: ./backups）
#
# 注意: pg_dump はサーバと同じか新しいメジャー版が必要（Supabase は現在 PG17 → クライアントも 17 以上）。
# 注意: 接続文字列を引数で渡すため、マルチユーザーのホストでは ps 等にURL（パスワード含む）が見える。
#       CI(専有ランナー)/自分の端末での実行を推奨。共有サーバで使う場合は PGPASSFILE 等の利用を検討。
#
# 例:
#   SUPABASE_DB_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
#     bash scripts/db-backup.sh
#
# 復元（別DBへ・要注意。--clean は既存オブジェクトを削除する）:
#   pg_restore --no-owner --no-privileges --clean --if-exists -d "<TARGET_DB_URL>" backups/arise-db-XXXX.dump

set -euo pipefail

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "ERROR: SUPABASE_DB_URL 環境変数が未設定です。" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump が見つかりません。postgresql-client(17 以上) をインストールしてください。" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/arise-db-$STAMP.dump"

echo "Dumping database to $OUT ..."
# --no-owner / --no-privileges: 別環境へもロール差異なく復元しやすくする。
# --format=custom: 圧縮 + pg_restore による選択的復元が可能。
pg_dump "$SUPABASE_DB_URL" \
  --no-owner \
  --no-privileges \
  --format=custom \
  --file="$OUT"

if [ ! -s "$OUT" ]; then
  echo "ERROR: ダンプ生成に失敗、または空でした（接続文字列・プーラー種別を確認）。" >&2
  exit 1
fi

# 破損検知: custom 形式アーカイブが pg_restore で一覧できること（=有効）を確認する。
# set -e で pg_dump 失敗は既に捕捉されるが、途中切断による「サイズ>0だが壊れている」ケースを追加で弾く。
if ! pg_restore --list "$OUT" >/dev/null 2>&1; then
  echo "ERROR: 生成されたダンプが壊れています（pg_restore --list が失敗）。" >&2
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
echo "Backup complete: $OUT ($SIZE)"
