/**
 * 書き出し画像のファイル名生成（260625 クライアント要望）。
 * プレビューPNGの書き出しは「日付」＋「プロジェクト名」＋.png にする。
 */

/** ファイル名に使えない文字（Windows 等の予約文字）を除去し、空白を _ に。日本語はそのまま許可。 */
export function sanitizeFileNamePart(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_') // OS で使えない文字
    .replace(/\s+/g, '_') // 連続空白（全角空白含む）を 1 つの _ に
    .replace(/_+/g, '_') // 連続 _ を 1 つに
    .replace(/^[._]+|[._]+$/g, '') // 先頭・末尾の . _ を除去
    .slice(0, 80); // 長すぎる名前を抑制
}

/** ローカル日付 YYYY-MM-DD。 */
export function exportDateStamp(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** プレビューPNGの書き出しファイル名 = 日付＋プロジェクト名＋.png。名前が空なら既定値にフォールバック。 */
export function buildPreviewFileName(projectName?: string | null, now: Date = new Date()): string {
  const safe = sanitizeFileNamePart((projectName ?? '').trim()) || 'プロジェクト';
  return `${exportDateStamp(now)}_${safe}.png`;
}

/**
 * 高解像度書き出しのファイル名 = 日付＋プロジェクト名＋「高解像度」＋.png。
 *
 * 【260803 クライアント要望E】以前は `_300dpi_4961x2790` を付けていたが、
 * この 300dpi は用紙サイズから逆算した出力の画素数であって、
 * 元画像がその情報量を持っているという意味ではない（実効は約230dpi相当）。
 * 実際より高い品質を名乗ることになるため、dpi と寸法の表記をやめる。
 * 例: 2026-08-03_マイプロジェクト_高解像度.png
 */
export function buildHiResFileName(
  projectName: string | null | undefined,
  now: Date = new Date(),
): string {
  const safe = sanitizeFileNamePart((projectName ?? '').trim()) || 'プロジェクト';
  return `${exportDateStamp(now)}_${safe}_高解像度.png`;
}

/**
 * 用紙サイズ書き出しのファイル名 = 日付＋プロジェクト名＋用紙＋DPI＋寸法＋.png（第3段 260703）。
 * 例: 2026-07-03_リビング_A4_300dpi_2480x3508.png
 */
export function buildPaperFileName(
  projectName: string | null | undefined,
  spec: { paper: string; dpi: number; width: number; height: number },
  now: Date = new Date(),
): string {
  const safe = sanitizeFileNamePart((projectName ?? '').trim()) || 'プロジェクト';
  return `${exportDateStamp(now)}_${safe}_${spec.paper}_${spec.dpi}dpi_${spec.width}x${spec.height}.png`;
}
