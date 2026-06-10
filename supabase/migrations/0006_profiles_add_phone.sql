-- ============================================================================
--  0006 — profiles に電話番号(phone)を追加（クライアント要望 #1a）
--
--  - profiles.phone（text, NULL可）を追加。フォーマット制約は設けない（MVP・
--    クライアント側の任意入力）。RLS は列非依存のため変更不要（本人の read/update 可）。
--  - サインアップ時に profiles を生成する handle_new_user を作り直し、metadata の
--    phone も seed する（関数は ALTER TABLE では更新されないため CREATE OR REPLACE）。
-- ============================================================================

alter table public.profiles add column if not exists phone text;

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, display_name, company, graduation_year, phone)
  values (
    new.id,
    coalesce((new.raw_user_meta_data ->> 'role')::user_role, 'pro'),
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'company',
    nullif(new.raw_user_meta_data ->> 'graduation_year', '')::int,
    new.raw_user_meta_data ->> 'phone'
  );
  return new;
end $$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
