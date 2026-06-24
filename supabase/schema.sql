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
  ai_credits_total      int not null default 0, -- フリープラン付与クレジット総数（row 49/50）
  ai_credits_used       int not null default 0, -- 消費済みクレジット数（consume_ai_credit で加算）
  ai_credits_expires_at timestamptz,            -- クレジット失効時刻（付与+3ヶ月）
  locked_at         timestamptz,            -- アカウントロック時刻（NULL=有効。自動/管理ロック・row 54）
  lock_reason       text,                   -- ロック理由（監査用）
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

-- フリープラン AIクレジット（生成回数）: 本登録時に 50 付与・3ヶ月失効（row 49/50）への安全網（idempotent）。
alter table profiles add column if not exists ai_credits_total      int not null default 0;
alter table profiles add column if not exists ai_credits_used       int not null default 0;
alter table profiles add column if not exists ai_credits_expires_at timestamptz;
-- 既存ユーザー（付与前=total 0）へ初期 50 付与（登録/作成日 +3ヶ月で失効）。
-- total は減算しない（消費は used を加算）ため、使い切った人（total 50/used 50）は再付与されず、
-- where ai_credits_total = 0 により再実行も no-op（冪等）。
update profiles
  set ai_credits_total = 50,
      ai_credits_expires_at = coalesce(registered_at, created_at) + interval '3 months'
  where ai_credits_total = 0;

-- 自動アカウントロック（row 54）への安全網（idempotent）。locked_at/lock_reason は
-- クライアントの更新対象（下の grant）に含めない＝本人が自分でロック解除できない（サーバのみ）。
alter table profiles add column if not exists locked_at   timestamptz;
alter table profiles add column if not exists lock_reason text;

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

-- 列単位の書き込み制限（RLS は行単位のみのため、本人でも改竄できる列を権限で塞ぐ）。
-- plan（自己アップグレード防止）と ai_credits_*（残高改竄防止）はクライアントから直接 UPDATE 不可にする。
-- これらの正規の書き換えはサーバ側のみ＝plan は service_role、付与は handle_new_user、消費は
-- consume_ai_credit（いずれも SECURITY DEFINER / 管理ロール）で行う。
-- 付与する列はクライアントの更新対象（ProfilePatch）と一致させること。
revoke update on profiles from authenticated;
grant  update (role, display_name, company, graduation_year, phone,
               department, school_year, registered_at, terms_accepted_at)
  on profiles to authenticated;

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 新規ユーザーにフリープラン 50 クレジットを付与し、3ヶ月後に失効させる（row 49/50）。
  -- サーバ側（SECURITY DEFINER）で付与するため、クライアントから total/失効日を改竄できない。
  insert into public.profiles (id, role, display_name, company, graduation_year, phone,
                               ai_credits_total, ai_credits_used, ai_credits_expires_at)
  values (
    new.id,
    coalesce((new.raw_user_meta_data ->> 'role')::user_role, 'pro'),
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'company',
    nullif(new.raw_user_meta_data ->> 'graduation_year', '')::int,
    new.raw_user_meta_data ->> 'phone',
    50, 0, now() + interval '3 months'
  );
  return new;
end $$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- AIクレジット消費（row 49/50）。本人の ai_credits_used を +1 し、残数（total-used, 下限0）を返す。
-- SECURITY DEFINER + auth.uid() 固定により、クライアントから used を直接書き換えられない（改竄防止）。
-- 生成成功ごとにアプリ側が1回呼ぶ。失効・残0の判定（事前ブロック）はアプリ側で行う。
create or replace function consume_ai_credit()
returns int language plpgsql security definer set search_path = public as $$
declare tot int; usd int;
begin
  -- 残数があり、かつ未失効のときだけ +1（used が total を超えない・失効後は消費しない）。
  update profiles
    set ai_credits_used = ai_credits_used + 1
    where id = auth.uid()
      and ai_credits_used < ai_credits_total
      and (ai_credits_expires_at is null or ai_credits_expires_at > now())
    returning ai_credits_total, ai_credits_used into tot, usd;
  if tot is null then
    -- 更新されなかった（残0/失効/該当行なし）。現在値から残数を返す（無ければ 0）。
    select ai_credits_total, ai_credits_used into tot, usd from profiles where id = auth.uid();
    if tot is null then return 0; end if;
  end if;
  return greatest(0, tot - usd);
end $$;
revoke execute on function public.consume_ai_credit() from public;
grant  execute on function public.consume_ai_credit() to authenticated;

-- 自動アカウントロック（row 54）。同一「IP＋端末FP(UA+画面)」から直近 window 内に
-- ログインした異なるアカウントが threshold 以上なら、そのクラスタの未ロック分を一括ロックする。
-- IP単独だと共有Wi-Fiで誤検知しやすいため、端末FP(UA+画面)の一致も条件にして「同一PC＋同一回線」に絞る。
-- ログイン記録時（api/session-log）に評価。SECURITY DEFINER（サーバの service_role のみ実行）。
create or replace function evaluate_account_lock(
  p_ip text,
  p_user_agent text,
  p_screen text,
  p_threshold int default 3,
  p_window_hours int default 24
)
returns int language plpgsql security definer set search_path = public as $$
declare cluster_users uuid[]; locked_count int;
begin
  if p_ip is null or p_user_agent is null then return 0; end if;
  select array_agg(distinct user_id) into cluster_users
  from login_events
  where ip = p_ip
    and user_agent = p_user_agent
    and (p_screen is null or screen = p_screen)
    and created_at > now() - make_interval(hours => greatest(1, p_window_hours));
  if cluster_users is null or array_length(cluster_users, 1) < greatest(2, p_threshold) then
    return 0;
  end if;
  update profiles
    set locked_at = now(),
        lock_reason = format('auto: %s accounts from same device/IP within %sh',
                             array_length(cluster_users, 1), p_window_hours)
    where id = any(cluster_users) and locked_at is null;
  get diagnostics locked_count = row_count;
  return locked_count;
end $$;
revoke execute on function public.evaluate_account_lock(text,text,text,int,int) from public, anon, authenticated;

-- 管理用: ロック中アカウント一覧（解除は locked_at=null に更新）。email を含むため service_role 限定。
create or replace view admin_locked_accounts as
  select p.id, p.display_name, p.role, p.locked_at, p.lock_reason, u.email
  from profiles p
  join auth.users u on u.id = p.id
  where p.locked_at is not null;
revoke all on admin_locked_accounts from anon, authenticated;

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
  scheduled_purge_at timestamptz,
  auto_expired       boolean not null default false, -- ライフサイクル自動論理削除か（手動削除は false）。row 106
  purge_warned_at    timestamptz                     -- 事前削除通知メール送信済み時刻（重複送信防止）。row 106
);
-- 既存DBへの安全網（idempotent）。
alter table projects add column if not exists auto_expired    boolean not null default false;
alter table projects add column if not exists purge_warned_at timestamptz;
create index if not exists idx_projects_owner on projects (owner_id) where deleted_at is null;
create index if not exists idx_projects_purge on projects (scheduled_purge_at) where deleted_at is not null;
-- 事前通知メールの対象抽出用（自動失効・未通知のみ）。
create index if not exists idx_projects_purge_warn on projects (scheduled_purge_at)
  where deleted_at is not null and auto_expired and purge_warned_at is null;

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
  insert into ai_feedback_daily (day, feature, good_count, bad_count, summary, computed_at)
  select target_day, feature,
         count(*) filter (where verdict = 'good'),
         count(*) filter (where verdict = 'bad'),
         -- 暗黙的フィードバックの重み付き合計（260625）。weight 欠損の旧データは 1.0 とみなす。
         jsonb_build_object(
           'good_weight', coalesce(sum(coalesce((prompt_context->>'weight')::numeric, 1.0)) filter (where verdict = 'good'), 0),
           'bad_weight',  coalesce(sum(coalesce((prompt_context->>'weight')::numeric, 1.0)) filter (where verdict = 'bad'), 0)
         ),
         now()
  from ai_feedback_events
  where created_at >= target_day and created_at < target_day + 1
  group by feature
  on conflict (day, feature) do update
    set good_count  = excluded.good_count,
        bad_count   = excluded.bad_count,
        summary     = excluded.summary,
        computed_at = excluded.computed_at;
end $$;

-- ---------------------------------------------------------------------------
-- 8a-2) AI in-context 学習: 全体共有「学習ヒント」プール（0006・管理表 row 211/219・Plan A「全体浸透」）
--     個人ごとの getRecentGoodHints とは別に、複数ユーザーにまたがって good 評価された
--     短い意匠フレーズ（styleMemo）だけを匿名・集約し、全ユーザーの生成プロンプトへ in-context で差し込む。
--     プライバシー: user_id は保持しない。distinct ユーザー数しきい値（既定3）＋文字数上限で、
--     個人特有の長文・固有情報の混入を防ぐ（＝複数人にまたがる「傾向」だけが残る）。
--     書き込みは集計関数(security definer)のみ。読み取りは authenticated 全員（全体浸透のため）。
-- ---------------------------------------------------------------------------
create table if not exists ai_learned_hints (
  id            uuid primary key default gen_random_uuid(),
  feature       text not null default 'ai_design',
  hint          text not null,
  sample_count  int not null default 0,   -- 採用された good イベント数
  user_count    int not null default 0,   -- distinct ユーザー数（>= p_min_users のみ採用）
  score         numeric not null default 0,
  updated_at    timestamptz not null default now(),
  unique (feature, hint)
);
alter table ai_learned_hints enable row level security;
drop policy if exists "learned_hints: read authenticated" on ai_learned_hints;
create policy "learned_hints: read authenticated" on ai_learned_hints
  for select using (auth.role() = 'authenticated');

-- 夜間集計: 直近 p_days 日の good イベントから styleMemo を抽出し、
-- distinct ユーザー数 >= p_min_users のものだけを feature ごと上位 p_limit 件、全体プールへ入れ替え反映する。
-- delete+insert は同一関数（=同一トランザクション）内なので原子的（失敗時はロールバック）。
create or replace function aggregate_learned_hints(
  p_days      int default 30,
  p_min_users int default 3,
  p_limit     int default 20,
  p_max_len   int default 60
) returns void language plpgsql security definer set search_path = public as $$
begin
  delete from ai_learned_hints;
  insert into ai_learned_hints (feature, hint, sample_count, user_count, score)
  select feature, hint, sample_count, user_count, score
  from (
    select feature, hint, sample_count, user_count, net_weight,
           (user_count * 2 + net_weight)::numeric as score,
           row_number() over (partition by feature
                              order by (user_count * 2 + net_weight) desc, hint) as rn
    from (
      -- 暗黙的フィードバックの「重み付き」集約（260625）: good を +weight・bad（再生成/削除等）を -weight として
      -- 各意匠フレーズ(styleMemo)の純スコア net_weight を出す。weight 欠損の旧データは 1.0 とみなす。
      -- ヒント化は「good を付けた異なるユーザーが p_min_users 以上」かつ「net_weight が正」のものに限る
      -- （好評だが削除/再生成で敬遠されている案は学習ヒントから外す）。
      select coalesce(feature, 'ai_design')                              as feature,
             btrim(prompt_context->>'styleMemo')                          as hint,
             count(*) filter (where verdict = 'good')                     as sample_count,
             count(distinct user_id) filter (where verdict = 'good')      as user_count,
             sum(
               case when verdict = 'good'
                    then  coalesce((prompt_context->>'weight')::numeric, 1.0)
                    else -coalesce((prompt_context->>'weight')::numeric, 1.0)
               end
             )                                                            as net_weight
      from ai_feedback_events
      where user_id is not null
        and created_at >= now() - make_interval(days => p_days)
        and prompt_context ? 'styleMemo'
        and length(btrim(coalesce(prompt_context->>'styleMemo', ''))) between 2 and p_max_len
      group by 1, 2
      having count(distinct user_id) filter (where verdict = 'good') >= p_min_users
         and sum(
               case when verdict = 'good'
                    then  coalesce((prompt_context->>'weight')::numeric, 1.0)
                    else -coalesce((prompt_context->>'weight')::numeric, 1.0)
               end
             ) > 0
    ) agg
    where hint <> ''
  ) ranked
  where rn <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- 8b) ai_usage_events（トークン計測の基礎・管理表 row 58。テスト中は無効＝記録なし）
--     AI生成（レンダー/編集/コーディネート/エージェント）ごとのトークン消費を記録する土台。
--     記録はクライアント（recordAiUsage, RLS insert own）。本人は自分の利用を read 可。
-- ---------------------------------------------------------------------------
create table if not exists ai_usage_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users (id) on delete set null,
  project_id    uuid references projects (id) on delete set null,
  feature       text not null default 'ai',   -- render / ai_edit / ai_coordinate / agent
  model         text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  total_tokens  int not null default 0,
  image_count   int not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists idx_ai_usage_user on ai_usage_events (user_id, created_at desc);
create index if not exists idx_ai_usage_feature_day on ai_usage_events (feature, created_at);

alter table ai_usage_events enable row level security;
drop policy if exists "ai_usage: insert own" on ai_usage_events;
drop policy if exists "ai_usage: read own"   on ai_usage_events;
create policy "ai_usage: insert own" on ai_usage_events for insert with check (auth.uid() = user_id);
create policy "ai_usage: read own"   on ai_usage_events for select using (auth.uid() = user_id);

-- 管理用: ユーザー×機能ごとのトークン集計（請求/原価管理の基礎）。email 等を含むため service_role 限定。
create or replace view admin_ai_usage as
  select e.user_id, p.display_name, p.role, e.feature,
         count(*)            as event_count,
         sum(e.total_tokens) as total_tokens,
         sum(e.image_count)  as image_count,
         max(e.created_at)   as last_used_at
  from ai_usage_events e
  left join profiles p on p.id = e.user_id
  group by e.user_id, p.display_name, p.role, e.feature;
revoke all on admin_ai_usage from anon, authenticated;

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
-- 9b) login_events（端末・IP ログイン記録／不正利用防止の監査証跡・管理表 row 53）
--    INSERT はサーバ（api/session-log）が service_role で行う＝クライアントから IP/端末を偽装不可。
--    本人は自分の履歴を SELECT 可。自動ロック（row 54）は本フェーズでは未実装（記録のみ）。
-- ---------------------------------------------------------------------------
create table if not exists login_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  ip          text,
  user_agent  text,
  screen      text,
  timezone    text,
  language    text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_login_events_user on login_events (user_id, created_at desc);

alter table login_events enable row level security;
-- 本人は自分のログイン履歴を閲覧可。INSERT ポリシーは作らない＝authenticated/anon は挿入不可で、
-- 記録はサーバの service_role（RLS バイパス）経由のみ。これによりクライアントからの偽装記録を防ぐ。
drop policy if exists "login_events: read own" on login_events;
create policy "login_events: read own" on login_events for select using (auth.uid() = user_id);

create or replace view admin_login_events as
  select e.id, e.user_id, p.display_name as user_name, p.role as user_role,
         e.ip, e.user_agent, e.screen, e.timezone, e.language, e.created_at
  from login_events e
  left join profiles p on p.id = e.user_id;

-- 管理用ビューはオーナー権限で実行され RLS を迂回するため、PostgREST 経由で anon/authenticated に
-- 全件露出させない。参照は service_role（管理ツール）のみに限定する（監査データの機密性確保）。
revoke all on admin_login_events from anon, authenticated;
revoke all on admin_user_uploads  from anon, authenticated;

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
      scheduled_purge_at = now() + make_interval(days => grace_days),
      auto_expired = true,       -- 自動失効マーク（手動削除と区別し、これだけ事前通知メールの対象にする）
      purge_warned_at = null     -- 新規フラグごとに通知可能に（復元→再失効でも再通知される）
  from profiles pf
  where pf.id = pr.owner_id and pf.plan = 'free' and pr.deleted_at is null
    and pf.created_at < now() - interval '3 months';

  get diagnostics flagged = row_count;
  return flagged;
end $$;

-- 事前削除通知メール（row 106）の送信対象を返す。自動失効（auto_expired）かつ未通知の論理削除済みのみ。
-- SECURITY DEFINER で auth.users の email を結合する。サーバ（cron）が service_role で RPC 実行する。
create or replace function purge_warning_targets()
returns table (project_id uuid, project_name text, owner_id uuid, owner_email text, scheduled_purge_at timestamptz)
language sql security definer set search_path = public as $$
  select p.id, p.name, p.owner_id, u.email, p.scheduled_purge_at
  from projects p
  join auth.users u on u.id = p.owner_id
  where p.deleted_at is not null
    and p.scheduled_purge_at is not null
    and p.auto_expired
    and p.purge_warned_at is null
    and u.email is not null;
$$;
-- 個人情報（メール）を返すため anon/authenticated には公開しない（cron の service_role のみ）。
revoke execute on function public.purge_warning_targets() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 容量警告メール（管理表 row 31）。本人のアップロード総容量がしきい値（既定=上限500MBの80%=400MB）に
-- 達したユーザーへ日次でメール通知する（Vercel Cron → api/cron/storage-warning）。重複送信防止に
-- storage_warnings へ最終通知時刻と通知時点の総容量を記録し、クールダウン期間内かつ容量が増えていなければ
-- 再送しない。書き込みは cron の service_role のみ（INSERT/UPDATE ポリシーを作らない＝RLSで一般ユーザー不可）。
-- ---------------------------------------------------------------------------
create table if not exists storage_warnings (
  owner_id    uuid primary key references auth.users (id) on delete cascade,
  warned_at   timestamptz not null default now(),
  total_bytes bigint not null default 0
);
alter table storage_warnings enable row level security;
drop policy if exists "storage_warnings: read own" on storage_warnings;
create policy "storage_warnings: read own" on storage_warnings
  for select using (auth.uid() = owner_id);

-- 通知対象（本人の総容量がしきい値以上で、未通知 or クールダウン経過 or 前回通知時より容量増加）を返す。
-- 個人情報（メール）を返すため anon/authenticated には公開しない（cron の service_role のみ）。
create or replace function storage_warning_targets(
  p_threshold_bytes bigint default 419430400,  -- 既定 400MB（= 500MB 上限の 80%）
  p_cooldown_days   int    default 7
)
returns table (owner_id uuid, owner_email text, total_bytes bigint)
language sql security definer set search_path = public as $$
  select t.owner_id, u.email, t.total_bytes
  from (
    select owner_id, sum(coalesce(bytes, 0))::bigint as total_bytes
    from user_uploads
    group by owner_id
  ) t
  join auth.users u on u.id = t.owner_id
  left join storage_warnings w on w.owner_id = t.owner_id
  where t.total_bytes >= p_threshold_bytes
    and u.email is not null
    and (
      w.owner_id is null
      or w.warned_at < now() - make_interval(days => p_cooldown_days)
      or t.total_bytes > w.total_bytes
    );
$$;
revoke execute on function public.storage_warning_targets(bigint, int) from public, anon, authenticated;

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
do $$ begin perform cron.schedule('arise_learned_hints', '15 17 * * *', $c$ select aggregate_learned_hints(); $c$); exception when others then null; end $$;

-- ============================================================================
--  完了。確認用:
--   select cmd, qual, with_check from pg_policies
--   where schemaname='public' and tablename='projects' order by cmd;
--  → update 行の with_check が (auth.uid() = owner_id) のみであること。
-- ============================================================================
