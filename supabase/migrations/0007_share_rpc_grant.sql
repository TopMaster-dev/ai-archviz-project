-- 0007_share_rpc_grant.sql
-- 閲覧用URL（共有・2b）の匿名読み取りを「明示的に」許可するハードニング。
--
-- get_shared_project(text) は SECURITY DEFINER で projects / project_shares の RLS を
-- バイパスし、「失効(revoked)・期限切れ(expires_at)・削除済み(deleted_at)でない」共有のみ
-- name / data / thumbnail_url を返す（migration 0001 で定義）。
--
-- public スキーマの関数は通常 PUBLIC へ EXECUTE が既定付与されるため、未ログインの
-- 訪問者（anon ロール）でも呼び出せる。ただしこれは「暗黙の既定」に依存しており、
-- 将来 `revoke execute on all functions ... from public` 等のハードニングが入ると
-- 共有リンクが無言で壊れる。そこで anon / authenticated に明示付与して固定する。
-- （冪等: 繰り返し実行しても安全。）

revoke execute on function public.get_shared_project(text) from public;
grant execute on function public.get_shared_project(text) to anon, authenticated;
