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
 * 高解像度書き出しのファイル名 = 日付＋プロジェクト名＋DPI＋寸法＋.png（260625 クライアント要望 #1）。
 * 複数プリセット（300/250/200/150 dpi）をダウンロードした際に、ファイル名で各種設定の違いが分かるようにする。
 */
export function buildHiResFileName(
  projectName: string | null | undefined,
  spec: { dpi: number; width: number; height: number },
  now: Date = new Date(),
): string {
  const safe = sanitizeFileNamePart((projectName ?? '').trim()) || 'プロジェクト';
  return `${exportDateStamp(now)}_${safe}_${spec.dpi}dpi_${spec.width}x${spec.height}.png`;
}
