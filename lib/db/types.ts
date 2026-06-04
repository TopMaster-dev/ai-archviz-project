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

/** 閲覧用URL（共有）から取得するプロジェクト。 */
export interface SharedProject {
  id: string;
  name: string;
  data: ProjectState;
  thumbnail_url: string | null;
}
