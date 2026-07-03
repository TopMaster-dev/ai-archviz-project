// 3Dレンダリング比率の選択（第2段・260703 クライアント合意）。
// 3Dビューの表示比率・AIレンダリングへ渡すアスペクト比・書き出しプリセットを、単一の選択値に連動させる。
// これまで16:9固定だったものを、常識的なAI対応比率から選べるようにする。
// 比率リストはアップロード時クロップ（第1段）と共通の CROP_RATIOS を用いる（いずれも Gemini 対応比率）。
import { CROP_RATIOS, type CropRatio } from './cropToAspect.js';

/** レンダリング比率で選べる対応比率（＝クロップと共通の常識リスト・全て Gemini 対応）。 */
export const RENDER_ASPECT_RATIOS: CropRatio[] = CROP_RATIOS;

/** 既定のレンダリング比率（後方互換＝従来の16:9固定）。 */
export const DEFAULT_RENDER_ASPECT = '16:9';

/** キー（'16:9' 等）が対応リストにあればそのまま、無ければ既定へ丸める。 */
export function normalizeRenderAspectKey(key: string | null | undefined): string {
  if (typeof key === 'string' && RENDER_ASPECT_RATIOS.some((r) => r.key === key)) return key;
  return DEFAULT_RENDER_ASPECT;
}

/** キーから数値比率（幅/高さ）。未知キーは 16:9 相当。 */
export function ratioValueForKey(key: string | null | undefined): number {
  const found = RENDER_ASPECT_RATIOS.find((r) => r.key === key);
  return found ? found.ratio : 16 / 9;
}

/** キーから表示ラベル（'16 : 9' の体裁）。 */
export function aspectLabelForKey(key: string | null | undefined): string {
  const k = normalizeRenderAspectKey(key);
  const [w, h] = k.split(':');
  return w && h ? `${w} : ${h}` : k;
}

export interface FitBox {
  w: number;
  h: number;
}

/**
 * 外枠(outerW×outerH)に収まる、指定比率(ratio=幅/高さ)の「最大の」矩形（レターボックス＝contain）。
 * 3Dビューを選択比率へ整形するのに使う（見た目＝キャプチャ＝生成比率を一致させ、構図ズレを防ぐ）。
 */
export function containBox(outerW: number, outerH: number, ratio: number): FitBox {
  if (!(outerW > 0) || !(outerH > 0) || !(ratio > 0)) return { w: Math.max(0, outerW), h: Math.max(0, outerH) };
  const outerRatio = outerW / outerH;
  if (outerRatio > ratio) {
    // 外枠が目標より横長 → 高さを使い切り、幅を絞る。
    const h = outerH;
    return { w: h * ratio, h };
  }
  // 外枠が目標より縦長（または同じ）→ 幅を使い切り、高さを絞る。
  const w = outerW;
  return { w, h: w / ratio };
}
