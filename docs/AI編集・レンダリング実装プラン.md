# AI 編集・レンダリング実装プラン（チャット合意まとめ）

本ドキュメントは仕様・方針の整理と、**実装済み（2026）**の対応状況を記載します。

---

## 1. 実装済みの前提（B 案ほか）

| 項目 | 内容 |
|------|------|
| オブジェクト配置 | `placements[]`、UI 色は `utils/aiEditObjectPalette.ts` と一致 |
| 編集モード UI | なし（プロンプトは `resolvePromptMode` で自動） |
| スタイル／配置の切替 | ヘッダーのモード UI はなし。**オブジェクトが 0 件**のときはスタイル参照・メモを API に送る。**オブジェクトが 1 件以上**のときはスタイル参照画像は送らず、正規化座標＋（サーバー側で）Gemini Flash による短い位置説明をプロンプトに渡す（`draftObjects.length > 0` で配置パイプライン）。 |
| 配置の伝え方 | **配置マスク PNG は送らない**（出力への焼き付き防止）。**正規化座標のテキスト**が主。**オブジェクトあり時**、`api/ai-edit` 内で先に `generatePlacementNarratives`（Gemini Flash / `GEMINI_PLACEMENT_CAPTION_MODEL` 上書き可）がベース画像＋座標から JSON の短文を生成し、`buildAiEditReferenceGuide` に `placementNarratives` として併記。失敗時は座標のみ。 |
| プロンプト | `lib/aiEditPrompt.ts`：出力に単色面・マスク・凡例を含めない旨を明示。オブジェクトあり時は反射の条件付き許可（マスク前提の文言は廃止）。配置領域内の家具形状はオブジェクト参照画像を正とし、ベースの下絵形状に引っ張られないよう憲章で指示。 |
| スタイル補足 | `styleMemo`（折りたたみ） |
| 履歴 | `selectVersion` でドラフト復元 |
| AI 編集 API | `styleMemo` / `placements` / `aspectRatio` / `imageSize`（マスクフィールドなし）、`api/ai-edit.ts` と Vite `/api/ai-edit` 同期。サーバーで `generatePlacementNarratives` → `generateGeminiImageEdit`。 |
| プレビュー AI レンダ | `useAiRenderer`: 長辺 1600 ダウンスケール → `/api/render` に `16:9` + `1K`。`generateGeminiImage` に `imageConfig` オプション |
| 画像書き出し | **AI 編集**の「画像書き出し」で `HighResExportDialog`。dpi プリセット（API 再レンダ）＋**プレビュー用**（即時 PNG）。3D はプレビュー用 AI レンダのみ。 |
| `/api/render` 統一 | `vite.config.ts` のインライン実装を廃止し `lib/gemini.ts` の `generateGeminiImage` を呼び出し |

---

## 2. スタイル参照と配置（仕様の要約）

- **オブジェクトなし**: スタイル画像・メモを送信。
- **オブジェクトあり**: スタイル参照画像は送らない。配置は **座標テキスト** と **任意の AI 生成短文**（サーバー側）。マスク画像は使用しない。
- 往復可能・ドラフトはクリアしない。

---

## 3. 配置座標と参考説明

- 各 `placement` は正規化矩形。`buildAiEditReferenceGuide` でパーセント表記。
- **サーバー**: `generatePlacementNarratives` がベース画像を見て JSON `descriptions[{objectId,text}]` を返し、プロンプトに「**座標優先、説明は参考**」として追記。
- **形状の優先順位**: 配置矩形内の家具・小物のシルエット・プロポーション・材質はオブジェクト参照画像に従い、ベースに写っている既存家具の輪郭を残した上塗りはプロンプト上禁止。位置の解釈だけ座標と短文説明が矛盾した場合は座標優先。

---

## 4. オブジェクト合成時の反射

- 憲章内で、鏡・床・ガラスの反射のみ条件付きで整合更新可（マスクの有無に依存しない表現）。

---

## 5. 解像度・書き出し

- **プレビュー**: `utils/printExportSpec.ts` の `PREVIEW_RENDER_MAX_SIDE` / `PREVIEW_GEMINI_IMAGE_SIZE`。
- **印刷用（API）**: `EXPORT_PRESETS_16_9`（16:9・複数 DPI 相当）/ `EXPORT_GEMINI_IMAGE_SIZE`（4K）+ `HighResExportDialog`。入力は必要に応じ `EXPORT_RENDER_INPUT_MAX_SIDE` でダウンスケール。
- **そのまま保存**: ダイアログの **プレビュー用**で履歴画像を再生成せず PNG DL。

---

## 6. フェーズ対応表（ビルド可能プラン）

| フェーズ | 状態 | 主なファイル |
|----------|------|----------------|
| A プレビューレンダ | 済 | `hooks/useAiRenderer.ts`, `lib/gemini.ts`, `api/render.ts`, `vite.config.ts` |
| B 高解像書き出し | 済 | `utils/printExportSpec.ts`, `components/HighResExportDialog.tsx`, `components/AiEditWorkspace.tsx` |
| C ワークスペース UI | 済 | `components/AiEditWorkspace.tsx` |
| D 配置プロンプト＋反射 | 済 | `utils/aiEditObjectPalette.ts`, `lib/aiEditPrompt.ts`, `lib/gemini.ts`（`generatePlacementNarratives`）, `api/ai-edit.ts`, `vite.config.ts` |

---

## 7. 未決・後続

- 高解像書き出し後に **編集セッションの画像を置き換えるか**（現状は DL のみ・プレビュー据え置き）。
- 配置モードでスタイルを **任意 ON** にするか。
- Gemini の入力上限に合わせた **書き出し入力のクリップ**（`EXPORT_RENDER_INPUT_MAX_SIDE` 等の調整）。
- `skipPlacementCaption` のような **クライアント指定で説明生成スキップ**（任意）。

---

*実装反映済みセクションを追記更新*
