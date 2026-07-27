/**
 * 画像ファイルのピクセル寸法を読む（260728 クライアント #5）。
 *
 * 建材アップロード時に「実寸（幅mm）」を1つだけ入力してもらい、高さは画像の縦横比から導くために使う。
 * ユーザーに縦横2つ入れさせないための小さなヘルパー。
 *
 * createImageBitmap が使える環境ではそれを使い（デコードが速く、メインスレッドを塞ぎにくい）、
 * 無ければ <img> + object URL にフォールバックする。どちらも失敗したら reject する
 * （呼び出し側は「実寸なし＝従来どおり1m角」に倒すこと）。
 */
export async function readImageSize(file: File | Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      const size = { width: bmp.width, height: bmp.height };
      // ImageBitmap は明示的に閉じないと GC まで GPU/メモリを保持し得る。
      if (typeof bmp.close === 'function') bmp.close();
      if (size.width > 0 && size.height > 0) return size;
    } catch {
      /* フォールバックへ */
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      if (size.width > 0 && size.height > 0) resolve(size);
      else reject(new Error('画像サイズを取得できませんでした。'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした。'));
    };
    img.src = url;
  });
}
