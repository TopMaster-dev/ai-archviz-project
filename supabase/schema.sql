-- ============================================================================
--  Arise (ai-archviz-pro) — 統合スキーマ（migrations 0001〜0007 を1ファイルに集約）
--
--  特徴:
--   - 冪等（何度実行しても安全）。`if not exists` / `create or replace` /
--     `drop ... if exists` → `create` を徹底。
--   - RLS ポリシーは「全削除 → 再作成」で、ドリフト（ダッシュボード等で付いた
--     想定外のポリシー）を確実に正へ収束。これにより
--     「new row violates row-level security policy for table "projects"」
--     （プロジェクト削除エラー）も解消する。
--   - 関数の最新版（handle_new_user は phone 対応＝0006版）を採用。
--   - pg_cron が無い環境でも本体が失敗しないよう cron 操作は例外を握りつぶす。
--
--  使い方: Supabase ダッシュボードの SQL Editor に貼り付けて実行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0) 拡張
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";
do $$ begin
  create extension if not exists "pg_cron";
exception when others then null; end $$;

-- ---------------------------------------------------------------------------
-- 1) 列挙型（冪等）
-- ---------------------------------------------------------------------------
do $$ begin create type user_role as enum ('pro','student','owner'); exception when duplicate_object then null; end $$;
do $$ begin create type plan_type as enum ('free','paid'); exception when duplicate_object then null; end $$;
do $$ begin create type share_permission as enum ('view'); exception when duplicate_object then null; end $$;
do $$ begin create type ai_feedback_verdict as enum ('good','bad'); exception when duplicate_object then null; end $$;
do $$ begin create type upload_kind as enum ('model','texture','image'); exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) 共通: updated_at 自動更新
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3) profiles（phone 含む）+ トリガ + RLS + handle_new_user（0006版）
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  role              user_role   not null default 'pro',
  display_name      text,
  company           text,
  graduation_year   int,
  phone             text,
  plan              plan_type   not null default 'free',
  registered_at     timestamptz,            -- 本登録完了時刻（NULL=招待後の本登録待ち。row 38）
  terms_accepted_at timestamptz,            -- 規約・ポリシー同意時刻（row 43）
  department        text,                   -- 学部（学生のみ。row 46）
  school_year       text,                   -- 学年（学生のみ。row 46）
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint student_requires_graduation_year
    check (role <> 'student' or graduation_year is not null)
);
-- 既存DB（phone 追加前）への安全網
alter table profiles add column if not exists phone text;

-- 招待制の本登録フロー（row 38/43/46）への安全網（idempotent）。
alter table profiles add column if not exists terms_accepted_at timestamptz;
alter table profiles add column if not exists department        text;
alter table profiles add column if not exists school_year       text;
-- registered_at は「列を新設する初回のみ」既存ユーザーを本登録済みとして backfill する
-- （再実行時に、まだ本登録していない招待ユーザーを誤って登録済みにしないため、列の有無で一度だけ判定）。
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'registered_at'
  ) then
    alter table profiles add column registered_at timestamptz;
    update profiles set registered_at = created_at;
  end if;
end $$;

drop trigger if exists trg_profiles_updated_at on profiles;
create trigger trg_profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

alter table profiles enable row level security;
drop policy if exists "profiles: read own"   on profiles;
drop policy if exists "profiles: update own" on profiles;
drop policy if exists "profiles: insert own" on profiles;
create policy "profiles: read own"   on profiles for select using (auth.uid() = id);
create policy "profiles: update own" on profiles for update using (auth.uid() = id);
create policy "profiles: insert own" on profiles for insert with check (auth.uid() = id);

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

-- ---------------------------------------------------------------------------
-- 4) user_api_keys（BYOK）
-- ---------------------------------------------------------------------------
create table if not exists user_api_keys (
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null default 'gemini',
  key_ciphertext text not null,
  last4          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, provider)
);
drop trigger if exists trg_api_keys_updated_at on user_api_keys;
create trigger trg_api_keys_updated_at
  before update on user_api_keys
  for each row execute function set_updated_at();

alter table user_api_keys enable row level security;
drop policy if exists "api_keys: owner all" on user_api_keys;
create policy "api_keys: owner all" on user_api_keys
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 5) projects（本体）+ 正しい RLS（削除エラーの修正の本丸）+ フリープラン上限
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users (id) on delete cascade,
  name               text not null default '無題のプロジェクト',
  data               jsonb not null default '{}'::jsonb,
  thumbnail_url      text,
  is_template        boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  scheduled_purge_at timestamptz
);
create index if not exists idx_projects_owner on projects (owner_id) where deleted_at is null;
create index if not exists idx_projects_purge on projects (scheduled_purge_at) where deleted_at is not null;

drop trigger if exists trg_projects_updated_at on projects;
create trigger trg_projects_updated_at
  before update on projects
  for each row execute function set_updated_at();

alter table projects enable row level security;

-- ★ projects のポリシーを名前不問で全削除（ドリフト除去）→ 正しい4本を再作成。
--   UPDATE の WITH CHECK には deleted_at 条件を付けない＝論理削除(UPDATE)が通る。
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

-- 注意: SELECT ポリシーに「deleted_at is null」を入れると、論理削除(UPDATE で deleted_at
--   をセット)した行が自分の読み取りポリシーに反するため「new row violates RLS」で弾かれる。
--   そのため SELECT は所有者のみとし、論理削除済みの除外はアプリ側クエリ
--   (listProjects/getProject の .is('deleted_at', null)) で行う。
create policy "projects: owner read" on public.projects
  for select using (auth.uid() = owner_id);
create policy "projects: owner insert" on public.projects
  for insert with check (auth.uid() = owner_id);
create policy "projects: owner update" on public.projects
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "projects: owner delete" on public.projects
  for delete using (auth.uid() = owner_id);

-- フリープランのプロジェクト保存上限。260613: テストマーケティング期は 5 → 10（管理表 row 72）。
-- クライアント側ミラー（lib/db/projects.ts FREE_PLAN_PROJECT_LIMIT）と一致させること。
create or replace function free_plan_project_limit()
returns int language sql immutable as $$ select 10; $$;

create or replace function enforce_free_plan_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  user_plan plan_type;
  active_count int;
begin
  select plan into user_plan from profiles where id = new.owner_id;
  if user_plan = 'free' then
    select count(*) into active_count
      from projects where owner_id = new.owner_id and deleted_at is null;
    if active_count >= free_plan_project_limit() then
      raise exception 'FREE_PLAN_LIMIT_REACHED: 保存上限(%件)に達しています', free_plan_project_limit()
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_enforce_free_limit on projects;
create trigger trg_enforce_free_limit
  before insert on projects
  for each row execute function enforce_free_plan_limit();

-- ---------------------------------------------------------------------------
-- 6) project_shares（閲覧用URL）+ 取得RPC + anon/authenticated への EXECUTE 付与
-- ---------------------------------------------------------------------------
create table if not exists project_shares (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  token      text not null unique default encode(gen_random_bytes(16), 'hex'),
  permission share_permission not null default 'view',
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked    boolean not null default false
);
create index if not exists idx_shares_token on project_shares (token) where revoked = false;

alter table project_shares enable row level security;
drop policy if exists "shares: owner manage" on project_shares;
create policy "shares: owner manage" on project_shares
  for all using (auth.uid() = created_by) with check (auth.uid() = created_by);

create or replace function get_shared_project(p_token text)
returns table (id uuid, name text, data jsonb, thumbnail_url text)
language sql security definer set search_path = public as $$
  select p.id, p.name, p.data, p.thumbnail_url
  from project_shares s
  join projects p on p.id = s.project_id
  where s.token = p_token
    and s.revoked = false
    and (s.expires_at is null or s.expires_at > now())
    and p.deleted_at is null;
$$;
revoke execute on function public.get_shared_project(text) from public;
grant  execute on function public.get_shared_project(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) student_portfolio_snapshots（service_role 専用・ポリシー無し）
-- ---------------------------------------------------------------------------
create table if not exists student_portfolio_snapshots (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references auth.users (id) on delete cascade,
  source_project  uuid,
  graduation_year int,
  snapshot        jsonb not null,
  captured_at     timestamptz not null default now()
);
create index if not exists idx_portfolio_student on student_portfolio_snapshots (student_id);
alter table student_portfolio_snapshots enable row level security;

-- ---------------------------------------------------------------------------
-- 8) AI フィードバックログ（0002）
-- ---------------------------------------------------------------------------
create table if not exists ai_feedback_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users (id) on delete set null,
  project_id     uuid references projects (id) on delete set null,
  feature        text not null default 'ai_design',
  verdict        ai_feedback_verdict not null,
  image_ref      text,
  prompt_context jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists idx_feedback_user on ai_feedback_events (user_id, created_at desc);
create index if not exists idx_feedback_feature_day on ai_feedback_events (feature, created_at);

alter table ai_feedback_events enable row level security;
drop policy if exists "feedback: insert own" on ai_feedback_events;
drop policy if exists "feedback: read own"   on ai_feedback_events;
create policy "feedback: insert own" on ai_feedback_events
  for insert with check (auth.uid() = user_id);
create policy "feedback: read own" on ai_feedback_events
  for select using (auth.uid() = user_id);

create table if not exists ai_feedback_daily (
  day         date not null,
  feature     text not null,
  good_count  int not null default 0,
  bad_count   int not null default 0,
  summary     jsonb,
  computed_at timestamptz not null default now(),
  primary key (day, feature)
);
alter table ai_feedback_daily enable row level security;
drop policy if exists "feedback_daily: read authenticated" on ai_feedback_daily;
create policy "feedback_daily: read authenticated" on ai_feedback_daily
  for select using (auth.role() = 'authenticated');

create or replace function aggregate_ai_feedback(target_day date default (current_date - 1))
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into ai_feedback_daily (day, feature, good_count, bad_count, computed_at)
  select target_day, feature,
         count(*) filter (where verdict = 'good'),
         count(*) filter (where verdict = 'bad'),
         now()
  from ai_feedback_events
  where created_at >= target_day and created_at < target_day + 1
  group by feature
  on conflict (day, feature) do update
    set good_count = excluded.good_count,
        bad_count  = excluded.bad_count,
        computed_at = excluded.computed_at;
end $$;

-- ---------------------------------------------------------------------------
-- 9) user_uploads（0003）+ 管理画面ビュー
-- ---------------------------------------------------------------------------
create table if not exists user_uploads (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  kind             upload_kind not null,
  storage_provider text not null default 'cloudinary',
  storage_url      text not null,
  public_id        text,
  original_name    text,
  bytes            bigint,
  project_id       uuid references projects (id) on delete set null,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_user_uploads_owner   on user_uploads (owner_id);
create index if not exists idx_user_uploads_project on user_uploads (project_id) where project_id is not null;
create index if not exists idx_user_uploads_kind    on user_uploads (kind);

drop trigger if exists trg_user_uploads_updated_at on user_uploads;
create trigger trg_user_uploads_updated_at
  before update on user_uploads
  for each row execute function set_updated_at();

alter table user_uploads enable row level security;
drop policy if exists "user_uploads: owner all" on user_uploads;
create policy "user_uploads: owner all" on user_uploads
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create or replace view admin_user_uploads as
  select u.id, u.owner_id, p.display_name as owner_name, p.role as owner_role,
         u.kind, u.storage_provider, u.storage_url, u.public_id, u.original_name,
         u.bytes, u.project_id, u.metadata, u.created_at
  from user_uploads u
  left join profiles p on p.id = u.owner_id;

-- ---------------------------------------------------------------------------
-- 10) Supabase Storage バケット + RLS（0004）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('user-uploads', 'user-uploads', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "user_uploads_storage_insert" on storage.objects;
drop policy if exists "user_uploads_storage_update" on storage.objects;
drop policy if exists "user_uploads_storage_delete" on storage.objects;
drop policy if exists "user_uploads_storage_select_own" on storage.objects;

create policy "user_uploads_storage_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "user_uploads_storage_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "user_uploads_storage_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "user_uploads_storage_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'user-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 11) pg_cron スケジュール（拡張が無い環境でも失敗しないよう例外を握りつぶす）
-- ---------------------------------------------------------------------------
create or replace function flag_expired_free_data(grace_days int default 14)
returns int language plpgsql security definer set search_path = public as $$
declare flagged int;
begin
  insert into student_portfolio_snapshots (student_id, source_project, graduation_year, snapshot)
  select pr.owner_id, pr.id, pf.graduation_year, pr.data
  from projects pr
  join profiles pf on pf.id = pr.owner_id
  where pf.plan = 'free' and pf.role = 'student' and pr.deleted_at is null
    and pf.created_at < now() - interval '3 months';

  update projects pr
  set deleted_at = now(),
      scheduled_purge_at = now() + make_interval(days => grace_days)
  from profiles pf
  where pf.id = pr.owner_id and pf.plan = 'free' and pr.deleted_at is null
    and pf.created_at < now() - interval '3 months';

  get diagnostics flagged = row_count;
  return flagged;
end $$;

create or replace function purge_soft_deleted_projects()
returns int language plpgsql security definer set search_path = public as $$
declare purged int;
begin
  delete from projects
  where deleted_at is not null and scheduled_purge_at is not null and scheduled_purge_at < now();
  get diagnostics purged = row_count;
  return purged;
end $$;

do $$ begin perform cron.unschedule('arise_flag_expired'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('arise_purge_deleted'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('arise_ai_feedback_aggregate'); exception when others then null; end $$;
do $$ begin perform cron.schedule('arise_flag_expired',  '0 18 * * *',  $c$ select flag_expired_free_data(); $c$); exception when others then null; end $$;
do $$ begin perform cron.schedule('arise_purge_deleted', '30 18 * * *', $c$ select purge_soft_deleted_projects(); $c$); exception when others then null; end $$;
do $$ begin perform cron.schedule('arise_ai_feedback_aggregate', '0 17 * * *', $c$ select aggregate_ai_feedback(); $c$); exception when others then null; end $$;

-- ============================================================================
--  完了。確認用:
--   select cmd, qual, with_check from pg_policies
--   where schemaname='public' and tablename='projects' order by cmd;
--  → update 行の with_check が (auth.uid() = owner_id) のみであること。
-- ============================================================================
