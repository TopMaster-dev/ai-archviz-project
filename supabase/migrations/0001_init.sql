-- ============================================================================
--  Arise (ai-archviz-pro) — Phase 1 (MVP) 初期スキーマ
--  Supabase / PostgreSQL
--
--  含むもの:
--   - 属性別アカウント（プロ / 学生 / 施主、学生は卒業予定年度必須）
--   - BYOK（各ユーザーの API キー保管。RLS で本人のみ）
--   - プロジェクト（per-user 永続化 / 論理削除 / 共有）
--   - 学生ポートフォリオのステルス蓄積（削除対象データとは別ストアで保護）
--   - フリープランの保存上限 + 登録3ヶ月後の段階的自動削除（論理→物理 / pg_cron）
--
--  すべてのテーブルで Row Level Security を有効化する。
-- ============================================================================

create extension if not exists "pgcrypto";
-- pg_cron は Supabase ダッシュボード（Database > Extensions）で有効化が必要な場合あり。
create extension if not exists "pg_cron";

-- ---------------------------------------------------------------------------
--  列挙型
-- ---------------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('pro', 'student', 'owner');     -- プロ / 学生 / 施主
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_type as enum ('free', 'paid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type share_permission as enum ('view');                 -- フェーズ1は閲覧URLのみ
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
--  共通: updated_at 自動更新トリガ
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
--  profiles — auth.users を拡張する属性プロフィール
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  role            user_role   not null default 'pro',
  display_name    text,
  company         text,
  -- 学生のみ必須（卒業予定年度）。CHECK で属性整合性を担保。
  graduation_year int,
  plan            plan_type   not null default 'free',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint student_requires_graduation_year
    check (role <> 'student' or graduation_year is not null)
);

create trigger trg_profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

alter table profiles enable row level security;

create policy "profiles: read own"   on profiles for select using (auth.uid() = id);
create policy "profiles: update own" on profiles for update using (auth.uid() = id);
create policy "profiles: insert own" on profiles for insert with check (auth.uid() = id);

-- サインアップ時に profiles 行を自動生成（属性はサインアップ metadata から取得）。
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, display_name, company, graduation_year)
  values (
    new.id,
    coalesce((new.raw_user_meta_data ->> 'role')::user_role, 'pro'),
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'company',
    nullif(new.raw_user_meta_data ->> 'graduation_year', '')::int
  );
  return new;
end $$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
--  user_api_keys — BYOK（各ユーザーの Gemini API キー）
--  暗号文のみ保管（アプリ/サービス層で BYOK_ENCRYPTION_KEY により暗号化）。
--  画面表示用に last4 のみ平文。RLS で本人のみ読み書き可。
-- ---------------------------------------------------------------------------
create table if not exists user_api_keys (
  user_id       uuid not null references auth.users (id) on delete cascade,
  provider      text not null default 'gemini',
  key_ciphertext text not null,
  last4         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, provider)
);

create trigger trg_api_keys_updated_at
  before update on user_api_keys
  for each row execute function set_updated_at();

alter table user_api_keys enable row level security;
create policy "api_keys: owner all" on user_api_keys
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  projects — プロジェクト本体（ProjectState を data jsonb に保持）
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  name              text not null default '無題のプロジェクト',
  data              jsonb not null default '{}'::jsonb,   -- 2D/3D/AI編集を含む統合状態
  thumbnail_url     text,
  is_template       boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- 段階的削除: まず deleted_at をセット（論理削除）→ scheduled_purge_at 経過後に物理削除
  deleted_at        timestamptz,
  scheduled_purge_at timestamptz
);

create index if not exists idx_projects_owner on projects (owner_id) where deleted_at is null;
create index if not exists idx_projects_purge on projects (scheduled_purge_at) where deleted_at is not null;

create trigger trg_projects_updated_at
  before update on projects
  for each row execute function set_updated_at();

alter table projects enable row level security;

-- 本人は自分の未削除プロジェクトのみ参照・編集可能
create policy "projects: owner read"   on projects for select
  using (auth.uid() = owner_id and deleted_at is null);
create policy "projects: owner insert" on projects for insert
  with check (auth.uid() = owner_id);
create policy "projects: owner update" on projects for update
  using (auth.uid() = owner_id);
create policy "projects: owner delete" on projects for delete
  using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
--  project_shares — 閲覧用URLの発行（フェーズ1: view のみ）
-- ---------------------------------------------------------------------------
create table if not exists project_shares (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  token       text not null unique default encode(gen_random_bytes(16), 'hex'),
  permission  share_permission not null default 'view',
  created_by  uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked     boolean not null default false
);

create index if not exists idx_shares_token on project_shares (token) where revoked = false;

alter table project_shares enable row level security;
create policy "shares: owner manage" on project_shares
  for all using (auth.uid() = created_by) with check (auth.uid() = created_by);

-- 閲覧URL用: トークンから共有プロジェクトを安全に取得（RLS をバイパスする SECURITY DEFINER）。
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

-- ---------------------------------------------------------------------------
--  student_portfolio_snapshots — 学生ポートフォリオのステルス蓄積
--  将来のスカウト事業用。フリープランのプロジェクト削除でも残るよう「別ストア」に保持。
--  ユーザーからは一切アクセス不可（service_role のみ）。
-- ---------------------------------------------------------------------------
create table if not exists student_portfolio_snapshots (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references auth.users (id) on delete cascade,
  source_project  uuid,                                   -- 元プロジェクト（削除後も値は保持）
  graduation_year int,
  snapshot        jsonb not null,                         -- 匿名化・集約済みの作品データ
  captured_at     timestamptz not null default now()
);

create index if not exists idx_portfolio_student on student_portfolio_snapshots (student_id);

alter table student_portfolio_snapshots enable row level security;
-- ポリシーを一切作らない = 通常ユーザーは読めない。service_role キーのみアクセス可。

-- ---------------------------------------------------------------------------
--  フリープランの保存上限
-- ---------------------------------------------------------------------------
create or replace function free_plan_project_limit()
returns int language sql immutable as $$ select 5; $$;  -- フリープランの保存上限（暫定）

-- 上限超過時に INSERT を拒否（プロ/有料は無制限）。
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
--  段階的自動削除（登録3ヶ月経過したフリープランのデータ）
--   1) flag_expired_free_data(): 論理削除（deleted_at セット）+ 物理削除予約 + 学生は事前スナップショット
--   2) purge_soft_deleted_projects(): 予約時刻を過ぎたものを物理削除
--  ※ 物理削除前に紐づく Cloudinary 資産の削除はアプリ/サービス層で別途実行する（ここでは行レコードのみ）。
-- ---------------------------------------------------------------------------
create or replace function flag_expired_free_data(grace_days int default 14)
returns int language plpgsql security definer set search_path = public as $$
declare flagged int;
begin
  -- 学生ポートフォリオを先に退避（削除しても残す）
  insert into student_portfolio_snapshots (student_id, source_project, graduation_year, snapshot)
  select pr.owner_id, pr.id, pf.graduation_year, pr.data
  from projects pr
  join profiles pf on pf.id = pr.owner_id
  where pf.plan = 'free'
    and pf.role = 'student'
    and pr.deleted_at is null
    and pf.created_at < now() - interval '3 months';

  -- フリープランの 3ヶ月超過プロジェクトを論理削除 + 物理削除予約
  update projects pr
  set deleted_at = now(),
      scheduled_purge_at = now() + make_interval(days => grace_days)
  from profiles pf
  where pf.id = pr.owner_id
    and pf.plan = 'free'
    and pr.deleted_at is null
    and pf.created_at < now() - interval '3 months';

  get diagnostics flagged = row_count;
  return flagged;
end $$;

create or replace function purge_soft_deleted_projects()
returns int language plpgsql security definer set search_path = public as $$
declare purged int;
begin
  delete from projects
  where deleted_at is not null
    and scheduled_purge_at is not null
    and scheduled_purge_at < now();
  get diagnostics purged = row_count;
  return purged;
end $$;

-- pg_cron スケジュール（毎日 JST 03:00 ≒ UTC 18:00 前日）。重複登録を避けるため unschedule を試行。
do $$ begin
  perform cron.unschedule('arise_flag_expired');
exception when others then null; end $$;
do $$ begin
  perform cron.unschedule('arise_purge_deleted');
exception when others then null; end $$;

select cron.schedule('arise_flag_expired',  '0 18 * * *', $$ select flag_expired_free_data(); $$);
select cron.schedule('arise_purge_deleted', '30 18 * * *', $$ select purge_soft_deleted_projects(); $$);
