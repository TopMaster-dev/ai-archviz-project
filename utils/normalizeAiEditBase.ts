/**
 * 「AIで写真編集」の土台画像を、「図面からパース作成」と同じ出力サイズへ揃える
 * （260812 クライアント要望「どちらも同じ仕様（出力サイズ）にしてほしい」）。
 *
 * 【なぜ2つのプロジェクトで出力サイズが違っていたか】
 * どちらも生成は 2K（imageSize）で共通だが、「1つ目の版（＝土台）」の作られ方が違っていた。
 *
 *  ・図面からパース作成 … 1つ目の版は AIレンダリングの生成結果そのもの。
 *                        つまり最初から 2K ネイティブ（長辺≒2688px）で始まる。
 *  ・AIで写真編集       … 1つ目の版は利用者がアップロードした写真そのもの。
 *                        上限（AREA_EDIT_BASE_MAX_SIDE）で頭打ちにするだけなので、
 *                        写真が小さければ小さいまま、大きければ 3072px になる。
 *
 * その後のAI編集は、生成結果を必ず「1つ目の版の寸法」へ合わせ直して保存する。
 * したがって1つ目の版の寸法が、そのプロジェクトの出力サイズを最後まで決めてしまう。
 * 1,200px の写真から始めれば、2K で生成しても毎回 1,200px へ縮められる（＝1K相当に見える）。
 *
 * 【この関数がすること】
 * 取り込んだ写真の長辺を、レンダリング側の土台と同じ 2K ネイティブ長辺へ揃える。
 * 縦横比は変えない（構図は変わらない）。大きい写真は縮小、小さい写真は拡大する。
 *
 * 【拡大についての注意】
 * 小さい写真を拡大しても、その写真自体の情報が増えるわけではない（補間）。
 * ただしAIは常に 2K で生成するため、揃えないと「2K で描いた結果を毎回小さく潰して保存する」ことになる。
 * 揃えたほうが、生成された絵の情報は多く残る。
 *
 * ※ 編集時のリサイズ処理そのもの（＝ぼやけ対策の手法1・2）はここでは変更していない。
 *    本ファイルは「1つ目の版の寸法」だけを揃える。
 */

/** 縦横比を保ったまま長辺を longEdge に合わせた寸法（純関数・テスト用）。 */
export function sizeForLongEdge(
  width: number,
  height: number,
  longEdge: number,
): { w: number; h: number } {
  // Math.max(1, NaN) は NaN になるため、先に有限判定でふるい落とす
  // （寸法に NaN が混ざるとキャンバスの生成ごと失敗する）。
  const px = (v: number) => (Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v)) : 1);
  const w = px(width);
  const h = px(height);
  const target = px(longEdge);
  const longest = Math.max(w, h);
  const scale = target / longest;
  return {
    w: px(w * scale),
    h: px(h * scale),
  };
}

/**
 * data URL を「長辺 = longEdge」へ拡大縮小する（縦横比は保つ）。
 * すでに一致していれば元をそのまま返す（無駄な再エンコードを増やさない）。
 * 失敗時は元の data URL を返す（取り込み自体は成功させる）。
 */
export function resizeDataUrlToLongEdge(dataUrl: string, longEdge: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          resolve(dataUrl);
          return;
        }
        const target = sizeForLongEdge(w, h, longEdge);
        if (target.w === w && target.h === h) {
          resolve(dataUrl);
          return;
        }
        const c = document.createElement('canvas');
        c.width = target.w;
        c.height = target.h;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        // 縮小・拡大ともに滑らかに（既定の低品質補間だとジャギーが出る）。
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, target.w, target.h);
        // この版は以後すべての編集の土台になるため、JPEG のときも品質を高めに取る。
        const useJpeg = /data:image\/jpe?g/i.test(dataUrl);
        resolve(useJpeg ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png'));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
