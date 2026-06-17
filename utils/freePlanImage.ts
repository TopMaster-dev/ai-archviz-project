/**
 * フリープランの生成画像 出力制限（管理表 row 51/52）。
 *  - 生成解像度制限: Web確認用に最大辺を縮小（既定 1280px）。
 *  - 透かし（ウォーターマーク）: 画像中央に半透明のサービス名透かしを自動合成。
 *
 * 重要（テストマーケティング運用）:
 *  既定では無効（ENABLE_FREE_PLAN_OUTPUT_LIMITS=false）。テスト中は参加企業の評価を妨げないよう
 *  透かし・縮小をかけない。ローンチ時に true にする（または運営側でテストアカウントを有料プランにする）。
 *  本制限は plan==='free' のユーザーにのみ適用される。
 */
export const ENABLE_FREE_PLAN_OUTPUT_LIMITS = false;

const FREE_PLAN_MAX_SIDE_PX = 1280;

function loadImageEl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    img.src = dataUrl;
  });
}

/**
 * フリープラン制限（縮小＋中央透かし）を適用した data URL を返す。
 * 失敗時は元の dataUrl をそのまま返す（生成結果を失わない安全側）。
 */
export async function applyFreePlanOutputLimits(
  dataUrl: string,
  maxSide = FREE_PLAN_MAX_SIDE_PX
): Promise<string> {
  try {
    const img = await loadImageEl(dataUrl);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) return dataUrl;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);

    // 中央に半透明の透かし（斜め）
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 12);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = Math.round(Math.min(w, h) * 0.14);
    ctx.font = `900 ${fontSize}px Inter, "Noto Sans JP", sans-serif`;
    ctx.lineWidth = Math.max(1, fontSize * 0.03);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.strokeText('Arise', 0, 0);
    ctx.fillText('Arise', 0, 0);
    const sub = Math.round(fontSize * 0.32);
    ctx.font = `700 ${sub}px Inter, "Noto Sans JP", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.26)';
    ctx.fillText('フリープラン サンプル', 0, fontSize * 0.8);
    ctx.restore();

    return canvas.toDataURL('image/png');
  } catch {
    return dataUrl;
  }
}

/** plan がフリーかつ機能有効時のみ制限を適用。それ以外（有料/ゲスト/無効時）は元の dataUrl を返す。 */
export async function maybeApplyFreePlanOutputLimits(
  dataUrl: string,
  isFreePlan: boolean
): Promise<string> {
  if (!ENABLE_FREE_PLAN_OUTPUT_LIMITS || !isFreePlan || !dataUrl) return dataUrl;
  return applyFreePlanOutputLimits(dataUrl);
}
