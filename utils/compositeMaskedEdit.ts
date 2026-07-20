import type { NormalizedRect } from '../types.js';

/**
 * エリア編集の「領域外染み出し」対策（260624 クライアント報告）。
 * Gemini は画像全体を holistic に再生成するため、テキストの「領域外は維持」指示を守らず、
 * マスク外（例: 天井のドライフラワー）まで増殖・改変してしまう。これを構造的に止める。
 *
 * baseDataUrl（編集前・W×H）の上に、editDataUrl（Gemini 出力・**同じ W×H にアスペクト補正済み**）を
 * placements の多角形/矩形マスクの内側だけ羽根ぼかし付きで合成する。マスク外は 100% ベースのまま
 * （バイト一致）になるため、指示にない領域は一切変化しない＝連鎖編集での増幅ループも断ち切れる。
 *
 * 前提・注意:
 *  - 呼び出し側は必ず edit を base と同一 W×H（アスペクト補正後）にしてから渡すこと（位置整合のため）。
 *  - placements が空なら editDataUrl をそのまま返す（全体編集モードでは使わない）。
 *  - 失敗時は editDataUrl を返す（合成不具合でも編集結果は失わない）。
 *  - 既知の限界: Gemini がフレーミングをずらすと、マスク境界でマスク内（生成）とマスク外（ベース）の
 *    被写体位置がずれて軽い二重縁が出ることがある。羽根ぼかしで緩和するが完全には消せない（要 live QA）。
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

export async function compositeMaskedEdit(
  baseDataUrl: string,
  editDataUrl: string,
  placements: NormalizedRect[],
  width: number,
  height: number,
  featherPx?: number,
  dilatePx?: number,
  /** 面から除外する開口（窓・ドア等）。ここはマスクから穴をあけ、合成後 base のまま（＝窓/ドアを保持）にする（case B・260718）。 */
  excludeRects?: NormalizedRect[],
  /**
   * 面仕上げ（壁/床/天井の塗装・張替・タイル等）向け: フェザーをマスクの「外側」にも掛けて境界を両側でなじませる
   * （内側限定クリップを外す）。true にすると、囲みのすぐ外側に残っていた“硬い縁（境界線）”が両側フェザーで溶ける
   * （260720 クライアント報告・窓際で顕著だった段差の主因への対策）。
   * 家具の差し替え等では false（＝内側限定）のまま: 外側へアルファがにじむと、境界の外に元家具の輪郭が薄く残る
   * 「二重縁（ゴースト）」が出るため。既定 false＝従来挙動を厳密維持。
   */
  featherOutside?: boolean
): Promise<string> {
  if (!placements || placements.length === 0 || width <= 0 || height <= 0) return editDataUrl;
  // フェザーは控えめに（内側のみに適用するため小さめで十分・境界の名残を減らす・260702）。
  const feather =
    featherPx ?? Math.min(10, Math.max(2, Math.round(Math.max(width, height) * 0.004)));
  // マスクを外側へ広げる量（260709）: 差し替え家具が囲みより少し大きくても縁で切れないよう余裕を持たせる。
  // 0（既定）なら従来どおり囲み線ぴったり。全画面経路で「指示外の追加を消す」用途では正の値を渡す。
  const dilate = Math.max(0, Math.round(dilatePx ?? 0));
  try {
    const [baseImg, editImg] = await Promise.all([loadImage(baseDataUrl), loadImage(editDataUrl)]);

    // 1) 羽根ぼかし付きアルファマスク（透明地に白アルファで領域を塗る → blur で縁を柔らかく）。
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const mctx = mask.getContext('2d');
    if (!mctx) return editDataUrl;
    mctx.clearRect(0, 0, width, height);
    mctx.fillStyle = 'rgba(255,255,255,1)';
    if (dilate > 0) {
      // 多角形はストローク（線幅 dilate*2）で外側へ dilate ぶん太らせる。矩形は各辺を dilate だけ拡張する。
      mctx.strokeStyle = 'rgba(255,255,255,1)';
      mctx.lineJoin = 'round';
      mctx.lineCap = 'round';
      mctx.lineWidth = dilate * 2;
    }
    for (const p of placements) {
      if (p.points && p.points.length >= 3) {
        mctx.beginPath();
        mctx.moveTo(p.points[0].x * width, p.points[0].y * height);
        for (let i = 1; i < p.points.length; i += 1) {
          mctx.lineTo(p.points[i].x * width, p.points[i].y * height);
        }
        mctx.closePath();
        // nonzero（既定）で塗る: 手描き多角形が自己交差しても穴が空かず、領域を塗り潰す（260702）。
        mctx.fill('nonzero');
        if (dilate > 0) mctx.stroke(); // 外側へ dilate ぶん膨張
      } else if (dilate > 0) {
        mctx.fillRect(
          p.x * width - dilate,
          p.y * height - dilate,
          p.width * width + dilate * 2,
          p.height * height + dilate * 2
        );
      } else {
        mctx.fillRect(p.x * width, p.y * height, p.width * width, p.height * height);
      }
    }
    // 開口（窓・ドア）を面から除外＝マスクに穴をあける（合成後、開口部は base のまま＝窓/ドアを保持・case B・260718）。
    // 面全体を一様に仕上げさせ（塗り残しゼロ・③）、検出した開口だけを決定論的に元へ戻す。
    if (excludeRects && excludeRects.length > 0) {
      mctx.globalCompositeOperation = 'destination-out';
      mctx.fillStyle = 'rgba(255,255,255,1)';
      for (const r of excludeRects) {
        if (r.points && r.points.length >= 3) {
          mctx.beginPath();
          mctx.moveTo(r.points[0].x * width, r.points[0].y * height);
          for (let i = 1; i < r.points.length; i += 1) mctx.lineTo(r.points[i].x * width, r.points[i].y * height);
          mctx.closePath();
          mctx.fill('nonzero');
        } else {
          mctx.fillRect(r.x * width, r.y * height, r.width * width, r.height * height);
        }
      }
      mctx.globalCompositeOperation = 'source-over';
    }
    let maskCanvas: HTMLCanvasElement = mask;
    if (feather > 0) {
      const blur = document.createElement('canvas');
      blur.width = width;
      blur.height = height;
      const bctx = blur.getContext('2d');
      if (bctx) {
        // ctx.filter 未対応エンジンでは無視され、ハードな縁になるだけ（致命ではない）。
        bctx.filter = `blur(${feather}px)`;
        bctx.drawImage(mask, 0, 0);
        bctx.filter = 'none';
        if (!featherOutside) {
          // フェザーを「内側のみ」に限定（既定・260702・クライアント報告「境界に前の下絵の名残が残る」対応）:
          // ぼかしで多角形の外側へ広がったアルファを、元の多角形（ハードエッジ）でクリップして取り除く。
          // これで編集は必ず描いた線の内側に収まり（拘束力）、線の外側へベース画像の元オブジェクトがにじんで
          // 残る「境界の名残（二重縁）」も出さない。家具差し替え等はこちら。
          bctx.globalCompositeOperation = 'destination-in';
          bctx.drawImage(mask, 0, 0);
          bctx.globalCompositeOperation = 'source-over';
        }
        // featherOutside=true（面仕上げ）: 内側限定クリップを行わない＝アルファが境界の“外側”へも ~feather ぶん
        // なだらかに減衰する（両側フェザー）。生成画像は全画面なので外側にはみ出す画素も同じ面の描画であり、
        // ベースの同じ面へ滑らかに溶ける＝「囲みのすぐ外側に残る硬い縁（境界線）」が消える（260720）。
        maskCanvas = blur;
      }
    }

    // 2) edit をマスクで切り抜く（destination-in でマスクのアルファだけ残す）。
    const cut = document.createElement('canvas');
    cut.width = width;
    cut.height = height;
    const cctx = cut.getContext('2d');
    if (!cctx) return editDataUrl;
    cctx.drawImage(editImg, 0, 0, width, height);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(maskCanvas, 0, 0);
    cctx.globalCompositeOperation = 'source-over';

    // 3) ベースの上に、切り抜いた edit を重ねる（マスク外は 100% ベース）。
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const octx = out.getContext('2d');
    if (!octx) return editDataUrl;
    octx.drawImage(baseImg, 0, 0, width, height);
    octx.drawImage(cut, 0, 0);

    const isJpeg =
      baseDataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(baseDataUrl.slice(0, 40));
    return isJpeg ? out.toDataURL('image/jpeg', 0.92) : out.toDataURL('image/png');
  } catch {
    return editDataUrl;
  }
}
