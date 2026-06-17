# DB バックアップ運用手順書（管理表 row 29）

Arise の本番 DB（Supabase / PostgreSQL）を日次でバックアップし、障害・誤操作時に復元できるようにするための手順。

## 背景：なぜ DIY バックアップが必要か

Supabase の **無料プランには自動バックアップ（日次バックアップ / PITR）が無い**。
そのため、無料プランで運用している間は `pg_dump` を日次スケジュールで実行して取得する。

- **本番運用での推奨**：Supabase を **Pro 以上にアップグレード**すると、自動日次バックアップ＋
  Point-in-Time Recovery（PITR）が有効になる。これが最も確実で運用負荷も低い。
- 本手順（GitHub Actions + `pg_dump`）は、無料プラン期間の **暫定策**。

実装ファイル：

- `scripts/db-backup.sh` … `pg_dump` 本体（環境非依存。cron / 他CI / 手動でも再利用可）
- `.github/workflows/db-backup.yml` … 日次スケジューラ（GitHub Actions）

## セットアップ（初回のみ）

### 1. 接続文字列を取得する

Supabase ダッシュボード → **Project Settings → Database → Connection string → URI**。

> ⚠️ **重要：接続種別**
> `pg_dump` には **Direct connection（推奨）** または **Session pooler（`:5432`）** を使うこと。
> **Transaction pooler（`:6543`）は `pg_dump` 非対応**（prepared statement を使うため失敗する）。
> IPv4 などで直接接続が使えない場合は Session pooler を使う。接続文字列にはパスワードを含める
> （`postgresql://postgres.<ref>:<password>@...:5432/postgres`）。

### 2. GitHub Secret に登録する

リポジトリ → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `SUPABASE_DB_URL`
- Value: 上で取得した接続文字列（パスワード入り）

> 🔒 接続文字列は DB パスワードを含む機密情報。**コミット禁止**。Secret か各自のローカル環境変数にのみ置く。

## 実行

- **自動**：毎日 **18:00 UTC（03:00 JST）** に GitHub Actions が実行する。
  （GitHub のスケジュールは負荷時に遅延・スキップされ得る。確実性が要る場合は外部スケジューラや
  「夜間アーティファクトが無ければ通知」等の監視を併用する。）
- **手動**：GitHub → **Actions → Nightly DB Backup → Run workflow**。
- **ローカル/サーバ手動**（pg_dump 17 以上が入っている環境）：

  ```bash
  export SUPABASE_DB_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
  bash scripts/db-backup.sh           # → ./backups/arise-db-YYYYMMDD-HHMMSS.dump
  ```

  ※ マルチユーザーのホストでは、引数で渡す接続URL（パスワード含む）が `ps` 等から見える。
    専有環境（CI / 自分の端末）での実行を推奨。

## PostgreSQL クライアントのバージョン

`pg_dump` は **対象サーバと同じか新しいメジャー版**である必要がある。Supabase は現在 **PG17** のため、
ワークフローは `postgresql-client-17` を入れている。新しいクライアントは等しい/古いサーバ（17/16/15）を
安全にダンプできる。Supabase が将来さらに新しいメジャーへ上がった場合は、クライアント版も合わせて上げること。

## 取得物の保存場所と保持期間

- 取得した `.dump` は GitHub Actions の **Artifacts**（該当 run の下部）に保存される。
- 保持期間は **30 日**（`.github/workflows/db-backup.yml` の `retention-days`）。
- ⚠️ Artifacts は**恒久保存ではない**。長期保管が要る場合は次のいずれかを足す：
  - 重要なダンプを定期的に手元へダウンロードして保管する、または
  - `scripts/db-backup.sh` の末尾に外部ストレージ（S3 / Cloudinary / Supabase Storage 等）への
    アップロード処理を追加する。
- ローカル実行で生成される `backups/*.dump` は個人情報を含むため `.gitignore` 済み（コミット禁止）。

## 復元手順

> ⚠️ 復元は不可逆。まずは**検証用の別 DB（ステージング）**へ復元して内容を確認してから本番に適用すること。

1. 対象の `.dump` を Artifacts からダウンロードする。
2. 復元する（`--clean --if-exists` は既存オブジェクトを削除してから入れ直す＝上書き復元）：

   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists \
     -d "<TARGET_DB_URL>" arise-db-YYYYMMDD-HHMMSS.dump
   ```

   - 新規の空 DB へ入れる場合は `--clean --if-exists` を外す。
   - 一部のテーブルだけ戻したい場合は `--table=<name>`（custom 形式なので選択的復元が可能）。
   - バックアップの中身を確認するだけなら `pg_restore --list arise-db-XXXX.dump`。

## 含まれるデータと取り扱い

ダンプには全テーブルのデータが含まれる（`profiles` のメール/電話、`login_events` の IP/端末など個人情報を含む）。
ダウンロードしたダンプは安全に保管・破棄すること。

## 補足

- これは管理対象 DB（`postgres`）の論理ダンプ（スキーマ＋データ）。Supabase 管理ロールは
  `--no-owner/--no-privileges` で除外しており、別環境へも復元しやすい。
- スクリプトはダンプ後に `pg_restore --list` で**アーカイブの妥当性**を検証し、途中切断などで壊れた
  ダンプを「成功」として残さないようにしている。
- ワークフローは `concurrency` で多重起動を防止している。
