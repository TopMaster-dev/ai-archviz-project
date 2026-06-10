-- ============================================================================
--  0005 — projects の RLS ポリシーを正規状態へリセット（削除エラーの修正）
--
--  症状: プロジェクト削除時に
--    「new row violates row-level security policy for table "projects"」
--  が発生して削除できない。
--
--  原因: 削除は論理削除（UPDATE で deleted_at をセット）で実装されている。
--    本番DBに適用されている projects の UPDATE ポリシーが WITH CHECK に
--    「deleted_at IS NULL」相当の条件を含んでいるため、deleted_at をセットした
--    瞬間に WITH CHECK 違反となり UPDATE が拒否される。
--    （0001 の本来のポリシーは owner 限定のみで deleted_at 条件を持たない）
--
--  対処: projects に現在ぶら下がっている全ポリシーを一旦削除し、本来の
--    「owner 本人のみ・deleted_at 条件は SELECT のみ」へ作り直す。これにより
--    どんな名前/条件のポリシーが入っていても確実に正しい状態へ収束させる。
--    INSERT/UPDATE/DELETE の WITH CHECK/USING は owner 限定のみとする。
-- ============================================================================

-- projects テーブルにぶら下がっている全ポリシーを名前不問で削除（冪等・安全）
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'projects'
  loop
    execute format('drop policy if exists %I on public.projects', pol.policyname);
  end loop;
end $$;

-- RLS は有効のまま、本来のポリシーを作り直す。
alter table public.projects enable row level security;

-- 参照: 本人かつ未削除のみ（一覧/取得は論理削除済みを除外）
create policy "projects: owner read" on public.projects
  for select
  using (auth.uid() = owner_id and deleted_at is null);

-- 追加: 本人のみ（INSERT する行の owner_id は本人）
create policy "projects: owner insert" on public.projects
  for insert
  with check (auth.uid() = owner_id);

-- 更新: 本人のみ。WITH CHECK にも deleted_at 条件は付けない
--   → 論理削除（deleted_at セット）も通常の保存も通る。
create policy "projects: owner update" on public.projects
  for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- 物理 DELETE も本人のみ（purge バッチは service_role で実行）
create policy "projects: owner delete" on public.projects
  for delete
  using (auth.uid() = owner_id);
