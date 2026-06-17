# 事前削除通知メール 運用手順書（管理表 row 106）

自動失効（ライフサイクル）で論理削除されたデータが**物理削除される前に**、所有者へ SMTP で警告メールを送る仕組み。

## 仕組み

1. `flag_expired_free_data`（pg_cron・日次）が保存期間切れのフリープランデータを論理削除し、
   `auto_expired=true` / `scheduled_purge_at=now+猶予日数` / `purge_warned_at=null` を設定。
2. **`/api/cron/purge-warning`**（Vercel Cron・日次, `vercel.json`）が、`auto_expired` かつ未通知
   （`purge_warned_at is null`）の対象を `purge_warning_targets()` で取得し、**所有者ごとに1通** SMTP 送信。
   送信できた分だけ `purge_warned_at` を記録（重複送信を防ぐ／失敗分は次回再送）。
3. `purge_soft_deleted_projects`（pg_cron・日次）が猶予期間経過後に物理削除。

手動削除（ユーザー自身の操作）は `auto_expired=false` のため**通知対象外**（復元はホームの「削除済み」から）。

実装: `lib/server/purgeWarning.ts`（中核）/ `api/cron/purge-warning.ts`（Vercel関数）/ `vite.config.ts`（dev版）/ `supabase/schema.sql`（列・関数）。

## セットアップ

### 1. SMTP 資格情報（送信元）

利用する SMTP サーバ（メール配信サービスや自社メール）から取得し、**Vercel 環境変数（Production）**に設定して**再デプロイ**:

| 変数 | 例 / 説明 |
|---|---|
| `SMTP_HOST` | 例: `smtp.example.com` |
| `SMTP_PORT` | `587`（STARTTLS）または `465`（SSL） |
| `SMTP_SECURE` | `465` のとき `true`、`587` のとき `false` |
| `SMTP_USER` / `SMTP_PASS` | SMTP 認証情報（不要なら空） |
| `SMTP_FROM` | 差出人（例: `Arise <no-reply@example.com>`） |
| `CRON_SECRET` | 任意の十分長いランダム文字列（エンドポイント保護用） |

> `SUPABASE_SERVICE_ROLE_KEY` と `VITE_SUPABASE_URL`（または `SUPABASE_URL`）も必要（既設）。

### 2. スケジュール

`vercel.json` に Cron を設定済み（毎日 19:00 UTC = 翌 04:00 JST）。`CRON_SECRET` を設定すると Vercel Cron が
`Authorization: Bearer <CRON_SECRET>` を自動付与する。デプロイ後 Vercel の **Settings → Cron Jobs** で確認できる。

Vercel Cron が使えない/別運用にする場合は、任意のスケジューラから同じヘッダで叩けばよい:

```bash
curl -X POST https://<your-app>/api/cron/purge-warning -H "Authorization: Bearer $CRON_SECRET"
```

## 動作確認

1. 検証用に、自分のテストプロジェクトを1件、SQLで自動失効状態にする（本番では使わないこと）:
   ```sql
   update projects set deleted_at = now(), scheduled_purge_at = now() + interval '14 days',
                       auto_expired = true, purge_warned_at = null
     where id = '<test-project-id>';
   ```
2. エンドポイントを起動（ローカルは `npm run dev` 後）:
   ```bash
   curl -X POST http://localhost:3000/api/cron/purge-warning -H "Authorization: Bearer <CRON_SECRET>"
   ```
3. レスポンスで原因が分かる:
   - `{"success":true,"warned":1,"recipients":1}` … 送信成功。
   - `{"reason":"smtp-not-configured","pending":1}` … 対象はあるが SMTP 未設定。
   - `{"reason":"server-not-configured"}` … SUPABASE_URL / service_role 未設定。
   - `401 Unauthorized` … CRON_SECRET 未設定 or ヘッダ不一致。
4. メール受信を確認し、SQLで `purge_warned_at` が入っていることを確認（再実行しても二重送信されない）。

## 補足
- 通知は**1ユーザー1通**にまとめ、最も早い削除予定日を案内する。
- 物理削除自体は pg_cron（DB側）が継続実行する。本ジョブはその「事前通知」のみを担う。
