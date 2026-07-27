/**
 * 建材写真の「タイリング適性」判定と、決定論的な擬似シームレス化（クライアント要望 #5・260728）。
 *
 * ユーザーがスマホ等で撮った建材写真をそのまま 3D ビューに貼ると、テクスチャが繰り返されて
 * (a) 継ぎ目（タイルの端が繋がらない縦横の線）と (b) 反復感（同じ模様の行列）が出る。
 * クライアントからは「自動シームレス化は既定 OFF が妥当ではないか。目地・強い柄・照明ムラのある
 * 写真は オフセット＋ぼかし では直らないのでは」という指摘があった（260728）。実際そのとおりで、
 * 半オフセット＋境界ブレンドは “端の不連続を画像の内側へ移して均す” だけの操作なので、
 *   ・写真の照明落ち（周辺減光・片側が明るい）→ 継ぎ目が中央へ移動するだけで消えない
 *   ・目地/強い方向性の柄     → ブレンド帯で柄が二重化してかえって目立つ
 * という限界がある。そこで「自動で全部かける」のではなく、**画像を実測して3択の推奨を返す**
 * 決定論ヒューリスティックをここに置く。非専門家のユーザーがタイリングを理解しなくても、
 * UI 側は verdict をそのまま出せばよい（tileable=そのまま / offset-ok=擬似シームレス推奨 /
 * photo=繰り返し不可・単貼りかトリミングを促す）。
 *
 * ★ utils/seamlessBlend.ts とは別物。あちらは「エリア編集（AI 生成領域）の貼り合わせ段差を
 *   調和膜（Poisson 近似）で消す」ための画像編集用モジュールで、本ファイルはテクスチャの
 *   繰り返し適性の判定＋オフセット合成。目的も入出力も無関係なので import もしない
 *   （名前が似ているだけ。混同して統合しないこと）。
 *
 * canvas / DOM に依存しないよう ImageData 互換の素の構造体（RgbaImage）で扱う＝node 上で
 * ユニットテストできる。全て純関数で、入力は一切変更しない。
 */

/** ImageData 互換の最小構造（RGBA・行優先）。DOM 非依存にするため独自定義。 */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

/** 隣接差の中央値がこれ未満なら「平坦」とみなす床値（8bit の量子化ノイズ相当・0除算防止）。 */
const MIN_DENOM = 0.5;
/** 完全一致判定用の極小値。 */
const FLAT_EPS = 1e-6;
/** 照明ムラ（写真のライティング落ち）と判定する相対勾配のしきい値。 */
export const ILLUMINATION_GRADIENT_THRESHOLD = 0.06;
/** 端が繋がっていないと判定する不整合比のしきい値（1.0≒既にタイル可能）。 */
export const EDGE_MISMATCH_THRESHOLD = 1.5;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Rec.709 輝度（0..255）。座標は範囲外をクランプし、data が短い（壊れた入力）場合は 0 を返す＝throw しない。
 * sRGB のままの加重和（線形化しない）だが、ここでの用途は「相対的な段差の大小比較」なので
 * 知覚に近い非線形のままの方が UI の見た目と一致する。
 */
export function luminanceAt(img: RgbaImage, x: number, y: number): number {
  const w = Math.floor(img.width);
  const h = Math.floor(img.height);
  if (!(w > 0) || !(h > 0)) return 0;
  const px = clamp(Math.floor(x), 0, w - 1);
  const py = clamp(Math.floor(y), 0, h - 1);
  const i = (py * w + px) * 4;
  if (i < 0 || i + 2 >= img.data.length) return 0;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}

/** 輝度プレーン（w*h）を1度だけ作る。以降の統計は全てこの配列上で行う（毎画素 luminanceAt は遅い）。 */
function lumaPlane(img: RgbaImage): { l: Float32Array; w: number; h: number } {
  const w = Math.max(0, Math.floor(img.width));
  const h = Math.max(0, Math.floor(img.height));
  const l = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      l[y * w + x] = luminanceAt(img, x, y);
    }
  }
  return { l, w, h };
}

/** 昇順ソートの中央値（偶数個は中央2つの平均）。空配列は 0。 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 「端の差」÷「内部の隣接差の中央値」。中央値を基準にするのは、柄のある素材ほど隣接差そのものが
 * 大きく、絶対値では判定できないため（＝“この画像にとって普通の段差”で正規化する）。
 * 平坦画像（中央値≒0）は 0 除算になるので、端も差が無ければ 1（＝既にタイル可能）を返し、
 * 端だけ差がある場合は量子化下限 MIN_DENOM で割って大きな比を返す（ベタ地に段差＝明確に繋がらない）。
 */
function mismatchRatio(edgeDiff: number, interiorDiffs: number[]): number {
  const med = median(interiorDiffs);
  if (!(med > MIN_DENOM)) {
    if (edgeDiff <= FLAT_EPS) return 1;
    return edgeDiff / MIN_DENOM;
  }
  return edgeDiff / med;
}

/**
 * 端の繋がらなさ。左端列と右端列（上端行と下端行）の平均絶対輝度差を、内部の隣接列（隣接行）の
 * 平均絶対差の中央値で正規化した比の、横／縦の大きい方を返す。
 * ≒1.0 なら「端どうしの差が内部の隣り合う画素どうしの差と同程度」＝そのまま繰り返しても違和感が無い。
 * >=1.5 で端が繋がっていない（継ぎ目が線として見える）。平坦画像は 1 を返す（0除算ガード）。
 */
export function edgeMismatchScore(img: RgbaImage): number {
  const { l, w, h } = lumaPlane(img);
  if (w <= 0 || h <= 0) return 1;

  // 横方向: 左端列 vs 右端列 / 隣接列ペア群
  let colEdge = 0;
  if (w >= 2) {
    let sum = 0;
    for (let y = 0; y < h; y += 1) sum += Math.abs(l[y * w] - l[y * w + (w - 1)]);
    colEdge = sum / h;
  }
  const colDiffs: number[] = [];
  for (let x = 0; x + 1 < w; x += 1) {
    let sum = 0;
    for (let y = 0; y < h; y += 1) sum += Math.abs(l[y * w + x] - l[y * w + x + 1]);
    colDiffs.push(sum / h);
  }

  // 縦方向: 上端行 vs 下端行 / 隣接行ペア群
  let rowEdge = 0;
  if (h >= 2) {
    let sum = 0;
    for (let x = 0; x < w; x += 1) sum += Math.abs(l[x] - l[(h - 1) * w + x]);
    rowEdge = sum / w;
  }
  const rowDiffs: number[] = [];
  for (let y = 0; y + 1 < h; y += 1) {
    let sum = 0;
    for (let x = 0; x < w; x += 1) sum += Math.abs(l[y * w + x] - l[(y + 1) * w + x]);
    rowDiffs.push(sum / w);
  }

  return Math.max(mismatchRatio(colEdge, colDiffs), mismatchRatio(rowEdge, rowDiffs));
}

/** 指定した列（または行）範囲の平均輝度。 */
function meanBand(l: Float32Array, w: number, h: number, axis: 0 | 1, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  if (axis === 0) {
    for (let y = 0; y < h; y += 1) {
      for (let x = from; x < to; x += 1) {
        sum += l[y * w + x];
        n += 1;
      }
    }
  } else {
    for (let y = from; y < to; y += 1) {
      for (let x = 0; x < w; x += 1) {
        sum += l[y * w + x];
        n += 1;
      }
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * 照明ムラ（片側が明るい／周辺減光）の強さ。各軸で「手前1/3の平均輝度 − 奥1/3の平均輝度」の絶対値を
 * 全体平均輝度で割った相対量の、大きい方を返す。
 * >=0.06 なら写真由来のライティング落ちがある＝**オフセット＋ブレンドでは直らない**（端の段差が
 * 画像中央へ移動するだけ。むしろ中央に明暗の帯ができて悪化する）ため、繰り返し前提で使わせない。
 * 真っ黒（全体平均≒0）は相対量が定義できないので 0。
 */
export function illuminationGradientScore(img: RgbaImage): number {
  const { l, w, h } = lumaPlane(img);
  if (w <= 0 || h <= 0) return 0;
  let total = 0;
  for (let i = 0; i < l.length; i += 1) total += l[i];
  const mean = total / l.length;
  if (!(mean > FLAT_EPS)) return 0;

  const tw = Math.max(1, Math.floor(w / 3));
  const th = Math.max(1, Math.floor(h / 3));
  const gx = Math.abs(meanBand(l, w, h, 0, 0, tw) - meanBand(l, w, h, 0, w - tw, w)) / mean;
  const gy = Math.abs(meanBand(l, w, h, 1, 0, th) - meanBand(l, w, h, 1, h - th, h)) / mean;
  return Math.max(gx, gy);
}

export interface TileabilityScore {
  edgeMismatch: number;
  illuminationGradient: number;
  /**
   * tileable  = そのまま繰り返してよい（シームレス化不要＝既定 OFF のままでよい）
   * offset-ok = 端が繋がらないがオフセット＋ブレンドで実用上消せる
   * photo     = 照明ムラのある“写真”。繰り返しは破綻するので単貼り／トリミングを促す
   */
  verdict: 'tileable' | 'offset-ok' | 'photo';
}

/**
 * 3択の推奨を返す。判定順が重要で、照明ムラを最優先で弾く（照明ムラがある画像は端が偶然合っていても
 * 繰り返すと明暗の縞になるため、edgeMismatch が小さくても 'tileable' と言ってはいけない）。
 * 退化入力（空画像）は edgeMismatch=1 / gradient=0 となり 'tileable' に落ちる＝何も勧めない安全側。
 */
export function scoreTileability(img: RgbaImage): TileabilityScore {
  const edgeMismatch = edgeMismatchScore(img);
  const illuminationGradient = illuminationGradientScore(img);
  const verdict: TileabilityScore['verdict'] =
    illuminationGradient >= ILLUMINATION_GRADIENT_THRESHOLD
      ? 'photo'
      : edgeMismatch < EDGE_MISMATCH_THRESHOLD
        ? 'tileable'
        : 'offset-ok';
  return { edgeMismatch, illuminationGradient, verdict };
}

/** data の範囲外読みを 0 に丸めるセーフゲッタ（壊れた入力でも throw しない）。 */
function ch(data: Uint8ClampedArray | number[], w: number, x: number, y: number, c: number): number {
  const i = (y * w + x) * 4 + c;
  return i >= 0 && i < data.length ? data[i] : 0;
}

/**
 * 継ぎ目位置（列 size/2-1 と size/2 の間）からの距離に応じた羽根重み。
 * シームに隣接する2画素で 1、feather 画素離れて 0。size<2 やフェザー0のときは 0（＝ブレンドしない）。
 */
function seamWeight(coord: number, size: number, feather: number): number {
  if (feather <= 0 || size < 2) return 0;
  const d = Math.abs(coord + 0.5 - size / 2);
  const t = (d - 0.5) / Math.max(feather - 0.5, FLAT_EPS);
  return 1 - clamp(t, 0, 1);
}

/**
 * 古典的な半オフセット＋羽根ブレンドによる擬似シームレス化。純関数（入力は不変・新しい画像を返す）。
 *
 * 手順: まず W/2・H/2 だけロールする。すると元画像の端どうしの不連続は画像中央の十字線へ移り、
 * 新しい端（x=0/W-1・y=0/H-1）には元画像の内部の隣り合う画素が来る＝端は自然に繋がる。
 * 残った中央の十字を、位相をずらした3枚のコピーと双一次に混ぜて消す:
 *   R  = I(x+W/2, y+H/2) … ロール結果（既定）
 *   Ax = I(x,     y+H/2) … 縦シームを跨いで x 方向に連続（同じ行を保つのでズレが最小）
 *   Ay = I(x+W/2, y)     … 横シーム用
 *   C  = I(x,     y)     … 十字の交点用
 * 重み u,v はシーム近傍だけ 1 になる羽根なので、端の近傍は必ず R そのもの＝**タイル性を壊さない**
 * （単純に「R と I を十字全体でクロスフェード」すると端の一部が I になりタイル性が壊れる。ここが要点）。
 *
 * ただしこれは端を繋ぐだけで、反復感や照明ムラは消せない（260728 の指摘どおり）。適用可否は
 * scoreTileability の verdict で判断すること。
 *
 * @param featherRatio 短辺に対するフェザー幅の比（既定 0.08）。0 なら純粋なオフセットのみ。
 */
export function makeSeamlessOffsetBlend(img: RgbaImage, featherRatio = 0.08): RgbaImage {
  const w = Math.max(0, Math.floor(img.width));
  const h = Math.max(0, Math.floor(img.height));
  const out = new Uint8ClampedArray(w * h * 4);
  if (w <= 0 || h <= 0) return { width: w, height: h, data: out };

  const src = img.data;
  const ox = Math.floor(w / 2);
  const oy = Math.floor(h / 2);
  const ratio = Number.isFinite(featherRatio) ? clamp(featherRatio, 0, 0.5) : 0.08;
  // フェザー帯が端まで届くとタイル性が壊れるので、短辺の半分未満に必ず収める。
  const maxFeather = Math.max(1, Math.floor(Math.min(w, h) / 2) - 1);
  const feather = ratio > 0 ? Math.min(maxFeather, Math.max(1, Math.round(ratio * Math.min(w, h)))) : 0;

  for (let y = 0; y < h; y += 1) {
    const ys = (y + oy) % h;
    const v = seamWeight(y, h, feather);
    for (let x = 0; x < w; x += 1) {
      const xs = (x + ox) % w;
      const u = seamWeight(x, w, feather);
      const wR = (1 - u) * (1 - v);
      const wAx = u * (1 - v);
      const wAy = (1 - u) * v;
      const wC = u * v;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        out[o + c] = Math.round(
          wR * ch(src, w, xs, ys, c) +
            wAx * ch(src, w, x, ys, c) +
            wAy * ch(src, w, xs, y, c) +
            wC * ch(src, w, x, y, c)
        );
      }
    }
  }
  return { width: w, height: h, data: out };
}
