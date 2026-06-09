-- ============================================================================
--  0003 — ユーザーアップロード資産の管理台帳（user_uploads）
--
--  目的（クライアント要望 #6 / 将来を見据えて）:
--   ユーザーがアップロードする 3D モデル・テクスチャ等を、弊社（管理画面）側で
--   把握・管理できるよう、保存先（Cloudinary 等）と独立した「台帳」を持つ。
--   実体（バイナリ）はストレージに置き、ここにはメタデータと所在を記録する。
--
--  ポイント:
--   - RLS は本人のみ読み書き可。管理画面は service_role（RLS バイパス）で全件参照する。
--   - storage_provider を持たせ、Cloudinary 以外（将来の S3 等）へ拡張可能にする。
--   - project_id は ON DELETE SET NULL（プロジェクト削除後も資産台帳は残す）。
--   - 物理削除時に紐づくストレージ資産を消すため public_id を保持する。
--   - 実際の行 INSERT は各アップロード API（api/thumbnails 等）側で行う（本ファイルは器のみ）。
-- ============================================================================

do $$ begin
  create type upload_kind as enum ('model', 'texture', 'image');
exception when duplicate_object then null; end $$;

create table if not exists user_uploads (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  kind             upload_kind not null,
  storage_provider text not null default 'cloudinary',   -- 将来 's3' 等へ拡張可
  storage_url      text not null,                          -- 公開/署名URL（表示・読み込み用）
  public_id        text,                                   -- ストレージ側ID（物理削除に使用）
  original_name    text,                                   -- アップロード時のファイル名
  bytes            bigint,                                 -- 元ファイルサイズ
  -- プロジェクトに紐づく場合のリンク（削除後も台帳は残すため SET NULL）
  project_id       uuid references projects (id) on delete set null,
  -- 種別ごとの付加情報（例: texture なら {category, repeatWidthMm, ...}、model なら {footprint2d, ...}）
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_user_uploads_owner   on user_uploads (owner_id);
create index if not exists idx_user_uploads_project on user_uploads (project_id) where project_id is not null;
create index if not exists idx_user_uploads_kind    on user_uploads (kind);

-- updated_at 自動更新（set_updated_at は 0001 で定義済み）
create trigger trg_user_uploads_updated_at
  before update on user_uploads
  for each row execute function set_updated_at();

alter table user_uploads enable row level security;

-- 本人のみ自分のアップロード台帳を参照・編集可能（管理画面は service_role で別途全件参照）
create policy "user_uploads: owner all" on user_uploads
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
--  管理画面向け: 全ユーザーのアップロードを集計するビュー（service_role 専用）。
--  RLS 下の通常ユーザーからは own 行のみ見える（user_uploads の RLS を継承）。
--  service_role での参照時は全件集計として機能する。
-- ---------------------------------------------------------------------------
create or replace view admin_user_uploads as
  select
    u.id,
    u.owner_id,
    p.display_name as owner_name,
    p.role         as owner_role,
    u.kind,
    u.storage_provider,
    u.storage_url,
    u.public_id,
    u.original_name,
    u.bytes,
    u.project_id,
    u.metadata,
    u.created_at
  from user_uploads u
  left join profiles p on p.id = u.owner_id;
