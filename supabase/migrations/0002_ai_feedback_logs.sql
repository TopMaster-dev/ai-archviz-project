-- ============================================================================
--  0002 — AI 学習用フィードバックログ（評価履歴）の「分離ストア」
--
--  目的（クライアント要望 #3 / 至急）:
--   「いいね/悪いね」評価や学習用フィードバックログを、プロジェクトデータの
--   3ヶ月自動削除とは独立して保持する。プロジェクトやアカウントが削除されても
--   学習資産としてログは残る設計とする。
--
--  ポイント:
--   - 3ヶ月削除バッチ（0001 の flag_expired_free_data / purge_soft_deleted_projects）は
--     projects テーブルのみを対象とする。本ファイルのテーブルは対象外＝保持される。
--   - project_id / user_id は ON DELETE SET NULL。削除後も匿名ログとして残存。
--   - 生ログのリアルタイム処理は避け、夜間に日次集計（要約）する（負荷・処理時間対策）。
--     → 「全ユーザー還元型」学習の土台（in-context 活用の入力）になる。
-- ============================================================================

do $$ begin
  create type ai_feedback_verdict as enum ('good', 'bad');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
--  ai_feedback_events — 生の評価イベント（いいね/悪いね）
-- ---------------------------------------------------------------------------
create table if not exists ai_feedback_events (
  id             uuid primary key default gen_random_uuid(),
  -- 削除後も匿名ログとして残すため SET NULL（CASCADE にしない）
  user_id        uuid references auth.users (id) on delete set null,
  project_id     uuid references projects (id) on delete set null,
  feature        text not null default 'ai_design', -- ai_design / area_edit / agent など由来機能
  verdict        ai_feedback_verdict not null,       -- good / bad
  image_ref      text,                               -- 評価対象画像（Cloudinary public_id 等）
  prompt_context jsonb,                              -- 生成時のプロンプト/パラメータ要約（学習用）
  created_at     timestamptz not null default now()
);

create index if not exists idx_feedback_user on ai_feedback_events (user_id, created_at desc);
create index if not exists idx_feedback_feature_day on ai_feedback_events (feature, created_at);

alter table ai_feedback_events enable row level security;
-- 本人は自分の評価を投稿・参照可。集計・全体学習は service_role（RLS バイパス）で実施。
create policy "feedback: insert own" on ai_feedback_events
  for insert with check (auth.uid() = user_id);
create policy "feedback: read own" on ai_feedback_events
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  ai_feedback_daily — 夜間に集計した日次サマリ（全ユーザー還元の土台）
--  生ログをリアルタイムに走査せず、ここを in-context 学習の入力に使う。
-- ---------------------------------------------------------------------------
create table if not exists ai_feedback_daily (
  day         date not null,
  feature     text not null,
  good_count  int not null default 0,
  bad_count   int not null default 0,
  -- 良い例/避けるべき傾向の要約（プロンプトに差し込む in-context 用）。
  summary     jsonb,
  computed_at timestamptz not null default now(),
  primary key (day, feature)
);

alter table ai_feedback_daily enable row level security;
-- 集計結果は全ログインユーザーが参照可（＝サービス全体で学習効果を還元）。書込は service_role のみ。
create policy "feedback_daily: read authenticated" on ai_feedback_daily
  for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
--  夜間集計関数（削除バッチとは別系統の cron で実行）
-- ---------------------------------------------------------------------------
create or replace function aggregate_ai_feedback(target_day date default (current_date - 1))
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into ai_feedback_daily (day, feature, good_count, bad_count, computed_at)
  select target_day,
         feature,
         count(*) filter (where verdict = 'good'),
         count(*) filter (where verdict = 'bad'),
         now()
  from ai_feedback_events
  where created_at >= target_day
    and created_at < target_day + 1
  group by feature
  on conflict (day, feature) do update
    set good_count = excluded.good_count,
        bad_count  = excluded.bad_count,
        computed_at = excluded.computed_at;
  -- NOTE: summary（in-context 用の傾向要約）は、フェーズ1追加分（foundation）の
  --       アプリ/サービス層で good/bad プロンプト傾向を要約して書き込む。
end $$;

-- 夜間（利用の少ない時間帯）に日次集計。3ヶ月削除バッチとは独立。
do $$ begin
  perform cron.unschedule('arise_ai_feedback_aggregate');
exception when others then null; end $$;
select cron.schedule('arise_ai_feedback_aggregate', '0 17 * * *',
  $$ select aggregate_ai_feedback(); $$);

-- ============================================================================
--  確認: 3ヶ月削除は projects のみ。ai_feedback_events / ai_feedback_daily は
--  削除対象に含まれない（＝学習ログは保持される）。手戻りなしで #3 を満たす。
-- ============================================================================
