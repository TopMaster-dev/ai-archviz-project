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
  /** 本登録（招待後の属性入力・規約同意）完了時刻。NULL=本登録待ち（登録画面を表示）。管理表 row 38。 */
  registered_at: string | null;
  /** 利用規約・プライバシーポリシーへの同意時刻。管理表 row 43。 */
  terms_accepted_at: string | null;
  /** 学部（学生のみ）。管理表 row 46。 */
  department: string | null;
  /** 学年（学生のみ）。管理表 row 46。 */
  school_year: string | null;
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
