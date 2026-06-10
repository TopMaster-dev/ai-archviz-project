-- ============================================================================
--  0004 — ユーザーアップロード用 Supabase Storage バケット + RLS
--
--  目的（クライアント要望 #6）:
--   ユーザーが独自の 3D モデル / テクスチャをアップロードできるようにする。
--   実体（バイナリ）は Supabase Storage に保存し、メタデータ・所在は 0003 の
--   user_uploads 台帳に記録する（管理画面は service_role で全件把握）。
--
--  なぜ Supabase Storage か:
--   - 既に Supabase（認証 + DB）を利用しており、Cloudinary 未設定でも動作する。
--   - RLS でユーザー単位のアクセス制御が自然に書ける。
--   - user_uploads.storage_provider = 'supabase' で台帳と整合。
--
--  方針:
--   - バケットは public=true。3D/テクスチャURLを認証ヘッダ無しで読み込めるように
--     （Three.js / useGLTF / TextureLoader は素の fetch で取得するため）。
--   - 書き込み/削除は本人フォルダ（先頭パス = auth.uid()）のみに制限。
--     パス規約: "<user_id>/<kind>/<timestamp>-<filename>"
--   - 公開読み取りはバケット public 設定で賄うため select ポリシーは不要。
-- ============================================================================

-- バケット作成（再実行安全）
insert into storage.buckets (id, name, public)
values ('user-uploads', 'user-uploads', true)
on conflict (id) do update set public = excluded.public;

-- 既存ポリシーを掃除してから作成（再実行安全）
drop policy if exists "user_uploads_storage_insert" on storage.objects;
drop policy if exists "user_uploads_storage_update" on storage.objects;
drop policy if exists "user_uploads_storage_delete" on storage.objects;
drop policy if exists "user_uploads_storage_select_own" on storage.objects;

-- アップロード: 認証済みユーザーが自分のフォルダ配下にのみ書き込み可
create policy "user_uploads_storage_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 更新（upsert 等）: 本人フォルダのみ
create policy "user_uploads_storage_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 削除: 本人フォルダのみ
create policy "user_uploads_storage_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 認証ユーザーが自分の資産を一覧（list）できるよう own-select も付与
-- （公開読み取りは public バケットの公開URLで賄うため anon 用 select は不要）
create policy "user_uploads_storage_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
