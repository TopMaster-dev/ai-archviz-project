# 自動アカウントロック 運用手順書（管理表 row 54）

同一PC＋同一回線（IP＋端末フィンガープリント）から短時間に複数アカウントが作成された場合に、
不正利用（多重アカウント）対策として自動的にアカウントをロックする仕組み。row 53（端末/IP記録）の続き。

> ⚠️ **既定は OFF。** 共有Wi-Fi（オフィス等）では正規ユーザーでも誤検知（誤ロック）しやすいため、
> テストマーケティング期は無効のまま運用する。本番開始時に有効化すること。

## 仕組み

1. ログイン記録（`api/session-log`）が `login_events` に IP・端末FP（UA+画面）を記録する（row 53）。
2. `ENABLE_AUTO_ACCOUNT_LOCK=true` のとき、記録直後に **`evaluate_account_lock()`** を評価:
   同一 `IP` かつ同一 `UA+画面` で直近 `AUTO_LOCK_WINDOW_HOURS` 時間内にログインした**異なるアカウント**が
   `AUTO_LOCK_THRESHOLD` 以上なら、そのクラスタの未ロック分を一括ロック（`profiles.locked_at` を設定）。
3. ロックされたアカウントは `AuthGate` がアプリ利用を停止し、ロック画面を表示する。
   `locked_at` はクライアントから更新できない列（列単位 GRANT 対象外）のため、本人は自己解除できない。

「IP単独」ではなく「IP＋端末FP」の一致を条件にすることで、同一オフィスWi-Fiでも**PC が異なれば**
誤検知しない（＝「同一PC＋同一回線で複数アカウント」のみを対象にする）。

## 有効化（本番）

Vercel 環境変数（Production）に設定して**再デプロイ**:

| 変数 | 既定 | 説明 |
|---|---|---|
| `ENABLE_AUTO_ACCOUNT_LOCK` | `false` | `true` で自動ロック検知を有効化 |
| `AUTO_LOCK_THRESHOLD` | `3` | 同一PC/回線で許容する同時アカウント数（これ以上でロック） |
| `AUTO_LOCK_WINDOW_HOURS` | `24` | 検知の時間窓（時間） |

スキーマ（`schema.sql`）の `profiles.locked_at/lock_reason`・`evaluate_account_lock()`・`admin_locked_accounts`
を適用済みであること。

## ロック中アカウントの確認・解除（管理者）

確認（Supabase SQL Editor / service_role）:

```sql
select * from admin_locked_accounts order by locked_at desc;
```

解除（誤検知の救済など）:

```sql
update profiles set locked_at = null, lock_reason = null where id = '<user-id>';
```

手動ロック（必要時）:

```sql
update profiles set locked_at = now(), lock_reason = '手動: 不正利用の疑い' where id = '<user-id>';
```

## 動作確認（有効化後・検証環境推奨）

1. `ENABLE_AUTO_ACCOUNT_LOCK=true`、`AUTO_LOCK_THRESHOLD=2` 等にして再デプロイ（または `npm run dev`）。
2. 同一ブラウザ（同一UA+画面・同一IP）で、別々のテストアカウントに連続ログインする。
3. しきい値到達後、`select * from admin_locked_accounts;` に各アカウントが現れ、
   次回読み込みで対象ユーザーにロック画面が表示されることを確認。
4. `update profiles set locked_at=null ...` で解除し、利用が再開できることを確認。

## 注意・強制範囲（重要）

- 既存ユーザーのロックは `locked_at` が null のため発生しない（有効化後の新規評価でのみロック）。
- 誤検知のリスクがあるため、しきい値・時間窓は運用しながら調整し、`admin_locked_accounts` を
  定期確認して誤ロックを早期に解除すること。穏当に運用したい場合はしきい値を高める／無効化する。
- **ロックの強制は「ログイン／アプリ表示」段階**（AuthGate がロック画面を表示）。本MVPの範囲:
  - **即時サインアウトはしない**。ロックは次回のプロフィール読込（再読込／再ログイン）で反映される。
  - **発行済みセッション（JWT）はデータAPIへ直接アクセスし得る**（RLS は auth.uid() で判定し
    `locked_at` を見ないため）。つまりロックは抑止・導線遮断であり、トークン失効までの完全遮断ではない。
- より強い強制が必要な場合（今後の強化項目・本MVPでは未実装）:
  - (a) ロック時に該当ユーザーのセッションを失効させる（Supabase Admin の signOut / refresh token 失効）、
  - (b) 主要な RLS ポリシーに `and not exists (select 1 from profiles where id = auth.uid() and locked_at is not null)` を追加してデータ面でも遮断する。
