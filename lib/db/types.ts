import type { ProjectState } from '../project/projectState.js';

// Supabase テーブルの行型（手書き。将来は supabase gen types に置き換え可能）。

export type UserRole = 'pro' | 'student' | 'owner';
export type PlanType = 'free' | 'paid';

export interface Profile {
  id: string;
  role: UserRole;
  display_name: string | null;
  company: string | null;
  graduation_year: number | null;
  phone: string | null;
  plan: PlanType;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  data: ProjectState;
  thumbnail_url: string | null;
  is_template: boolean;
  created_at: string;
  updated_at: string;
}

/** 一覧表示用の軽量サマリ。 */
export interface ProjectSummary {
  id: string;
  name: string;
  thumbnail_url: string | null;
  updated_at: string;
}

/** 論理削除済み（猶予期間内）プロジェクトのサマリ。復元メニュー用（管理表 row 109/110）。 */
export interface DeletedProjectSummary extends ProjectSummary {
  /** 完全削除予定日時。残りの猶予日数の表示に使う。 */
  scheduled_purge_at: string | null;
}

/** 閲覧用URL（共有）から取得するプロジェクト。 */
export interface SharedProject {
  id: string;
  name: string;
  data: ProjectState;
  thumbnail_url: string | null;
}
