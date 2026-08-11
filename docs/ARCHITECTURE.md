# Arise — アーキテクチャ / 初期コード監査（フェーズ1 MVP）

このドキュメントは、(1) 既存プロトタイプの初期コード監査結果、(2) フェーズ1で目指す
ターゲット・アーキテクチャ、(3) 主要な技術判断（ADR）と開発フェーズ計画 をまとめる。
SaaS として複数人が安全に保守・運用できる土台へ作り替えることが本フェーズの目的。

---

## 1. 初期コード監査の要点（現状）

| 領域 | 現状 | 評価 |
|------|------|------|
| 状態管理 | `App.tsx`（約3,323行）に `useState` 50+。中央ストアなし、props バケツリレー5層 | ❌ 要再設計 |
| Undo/Redo | なし（履歴/コマンド基盤が存在しない） | ❌ Ctrl+Z/Ctrl+G の前提が未整備 |
| 永続化 | `localStorage`（3キー）+ Cloudinary のみ。DB/認証なし | ❌ per-user 永続化が未構築 |
| 3D テクスチャ | `RoomViewer.applyRealSizeTextureRepeat()` が実在し RepeatWrapping で実寸投影 | ✅ **実寸投影の土台あり** |
| 2D スケッチ | Canvas2D、mm 座標、グリッド/長さ/角度スナップあり。下絵・グルーピングなし | ⚠️ 拡張で対応 |
| API | `api/*` 5本（Cloudinary/Gemini プロキシ）。**Gemini キーは単一共有** | ❌ BYOK 化が必要 |
| デッドコード | `denoise`（UI未接続）/ 独自GLB読込（ボタン未接続）/ pathtracer（未使用、BVHのみ利用）/ `services/*` 空 | ⚠️ 整理対象 |
| 品質基盤 | TS strict は有効。ESLint/Prettier/テスト/CI なし。**git管理なし** | ❌ 整備済み（本コミット） |

**localStorage キー**: `archviz-camera-presets-v1` / `archviz-ai-edit-session-v2`(+v1 migrate)。

**重要な発見**: 実寸テクスチャ投影は `RoomViewer.tsx` 内に既に存在し、現在は「短辺mm（手動）」で
駆動している。フェーズ1の追加要件は **素材の実寸メタデータ（`/api/materials` が導出）を
この既存関数に流し込む** ことが中心で、エンジンの新規スクラッチは不要。→ リスク低。

---

## 2. ターゲット・アーキテクチャ（フェーズ1）

```
┌──────────────────────── Frontend (React 19 + Vite + TS) ────────────────────────┐
│  UI 3画面: 2Dスケッチ / 3Dビュー / AI画像編集                                      │
│  状態:  Zustand ストア（単一 ProjectState） + コマンド履歴（Undo/Redo・グループ化）  │
│  認証:  @supabase/supabase-js（メール+パスワード、属性別サインアップ）               │
│  永続化: プロジェクト = projects.data(jsonb) に autosave（デバウンス）              │
│  BYOK:  ユーザーが自身の Gemini キーを保存 → API 呼び出し時にヘッダで送信            │
└───────────────┬───────────────────────────────────────────┬─────────────────────┘
                │ supabase-js (RLS)                          │ fetch /api/*
                ▼                                            ▼
┌──────── Supabase ────────┐                    ┌──── Vercel Serverless (api/*) ────┐
│ Auth + Postgres + RLS     │                    │ /materials /furniture /thumbnails  │
│ profiles / projects /     │                    │ /render /ai-edit                   │
│ user_api_keys(BYOK) /     │                    │  └ Cloudinary / Gemini プロキシ     │
│ project_shares /          │                    │  └ BYOK: 受信キーで Gemini を呼ぶ   │
│ student_portfolio_*       │                    └────────────────────────────────────┘
│ pg_cron: 3ヶ月段階削除     │                    Cloudinary: 素材/家具/サムネ + 軽量化
└───────────────────────────┘
```

### データモデル（統合 ProjectState）
現状バラバラの state を 1 つの木に集約する。これが Undo/Redo・autosave・共有の共通土台。
```
ProjectState {
  meta:    { id, name, updatedAt }
  sketch:  { points[], openings[], wallDivisions, underlay? }   // 2D（mm）
  scene:   { roomHeight, furniture[], ceilingObjects[], groups[] } // 3D
  materials: Record<surfaceId, { productId, settings }>          // 実寸投影含む
  aiEdit:  { versions[], activeVersionId, draftObjects[] }
  camera:  { presets[], mode }
}
```

---

## 3. 技術判断（ADR ダイジェスト）

- **バックエンド = Supabase**: 認証 + Postgres + RLS + ストレージ + pg_cron（3ヶ月バッチ）を
  低運用コストで一体提供。Vercel と相性良。→ 自前認証/DBより MVP に最適。
- **素材・画像の保管 = Cloudinary 継続**: `f_auto,q_auto` による軽量化が既に要件を満たす。
  実寸メタは `/api/materials` で画像仕様（1mm=1px / 200dpi / ファイル名コード）から導出。
- **状態管理 = Zustand + immer + コマンド履歴**: Redux より軽量で App.tsx の段階移行に向く。
  履歴スタックで Ctrl+Z/Ctrl+Y、選択集合の `groups[]` で Ctrl+G を実現。
- **BYOK**: キーは `user_api_keys` に暗号化保管（表示用 last4 のみ平文）。呼び出し時のみ復号して
  `api/*` にヘッダ送信。テスト期間は上限なし（計測基盤だけ用意し有効化はしない）。
- **段階的削除**: 論理削除（deleted_at）→ 猶予 → 物理削除（pg_cron）。学生作品は別ストアへ事前退避。

---

## 4. 開発フェーズ計画（実装順）

0. **基盤**（本コミット）: git / ESLint / Prettier / .env.example / 本ドキュメント / 実寸メタ層 / DBスキーマ
1. **バックエンド**: Supabase スキーマ適用、supabase-js クライアント、型生成
2. **認証 + 永続化**: 属性別サインアップ（プロ/学生/施主）、プロジェクト CRUD + autosave
3. **状態リファクタ**: Zustand 統合ストア + Undo/Redo + グループ化（App.tsx 段階移行）
4. **エディタ拡張**: 下絵挿入（PDF/JPEG/PNG）/ Ctrl+Z・Ctrl+G / 寸法スナップ
5. **天井 + 天伏ビュー**: 天井オブジェクト配置 + 平面半透明レイヤの天伏ビュー
6. **実寸投影の結線**: 素材 mm メタを `applyRealSizeTextureRepeat` に流し込む（平面サーフェス）
7. **SaaS ロジック**: 保存上限 / 3ヶ月削除バッチ / 共有（閲覧URL + 複製）
8. **AI 品質の初期チューニング**: 繰り返し編集の品質維持(*3) / 印刷向け高解像度化(*4)（実用水準まで）
9. **最適化・デバッグ + デッドコード整理 + 引き継ぎ設計メモ**

> 確約スコープの境界（重要）: 実寸投影は **平面サーフェス**まで。曲面/外部3D/タイル割付パターンは
> フェーズ2。AI 品質(*3/*4) は **実用水準までの初期チューニング**（無制限の精度追求はフェーズ1.5+）。

---

## 5. 開発手順（ローカル）

```bash
npm install
cp .env.example .env.local   # 各キーを設定（Gemini / Cloudinary / Supabase）
npm run dev                  # Vite + ローカル api ミドルウェア
npm run typecheck            # tsc --noEmit
npm run lint                 # ESLint
npm run format               # Prettier
```

DB は `supabase/migrations/*.sql` を Supabase プロジェクトに適用（Supabase CLI もしくは SQL エディタ）。
