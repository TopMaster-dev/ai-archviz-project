/**
 * クロップ操作バー（注意文＋「やめる」「この範囲で検索」）の置き場所を決める（260731 クライアント要望③）。
 *
 * 以前はプレビューの下端に固定していた。枠を下へ動かすとバーと枠線が重なり、
 * そもそも下端は視線から遠いので「気付きにくい」という指摘だった。
 * 枠の真下へ追従させ、下に入らないときだけ枠の上へ回す。
 *
 * 計算だけをここに置く理由: 反転の境目は目視で確かめにくく、レイアウト崩れは
 * 「たまたま今の画面サイズでは起きない」形で残りやすい。純粋な関数にして数値で固定する。
 *
 * 座標系は「プレビュー枠（wrapper）の左上を原点とするピクセル」。
 * 拡大・パンは呼び出し側で枠の矩形へ織り込んでから渡すこと（バー自身は拡大しない）。
 */

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CropBarPlacement {
  left: number;
  top: number;
  width: number;
  /** below=枠の下 / above=枠の上 / inside=どちらにも入らずプレビュー内へ寄せた */
  placement: 'below' | 'above' | 'inside';
}

/** 枠とバーの間隔（px）。 */
const GAP = 8;
/** プレビュー端との最小余白（px）。ここを割ると画面外に見える。 */
const MARGIN = 8;
/**
 * バーの最小幅（px）。注意文が2行で収まる程度。
 * これより狭いと文字が折り返して縦に伸び、枠の下にも上にも入らなくなる。
 */
const MIN_WIDTH = 520;

/** バーの横幅。枠が広ければ枠に合わせ、狭ければ読める幅を確保する。プレビューからは絶対にはみ出さない。 */
export function cropBarWidth(frameWidth: number, wrapWidth: number): number {
  const available = Math.max(0, wrapWidth - MARGIN * 2);
  return Math.min(available, Math.max(frameWidth, MIN_WIDTH));
}

export function placeCropBar(opts: {
  frame: PixelBox;
  wrap: { width: number; height: number };
  /** 実測したバーの高さ。文字の折り返しで変わるので、定数にせず必ず実測値を渡すこと。 */
  barHeight: number;
}): CropBarPlacement {
  const { frame, wrap, barHeight } = opts;
  const width = cropBarWidth(frame.width, wrap.width);

  // 横位置は枠の中心に合わせ、プレビューの外へ出ないように寄せる。
  const centered = frame.left + frame.width / 2 - width / 2;
  const maxLeft = wrap.width - MARGIN - width;
  const left = maxLeft < MARGIN ? MARGIN : Math.min(Math.max(centered, MARGIN), maxLeft);

  /*
   * 「入るか」は上下【両方】を見ること（260731 敵対レビュー）。
   *
   * 片側だけ見ていると、拡大・パンで枠がプレビューの外へ出たとき（frame.top が負、あるいは
   * wrap.height を超える）に、その外側の座標をそのまま返してしまう。バーは overflow-hidden の
   * 中にいるので丸ごと切り取られ、「やめる」も「この範囲で検索」も押せなくなる。
   * 枠が画面外にあるときこそ inside へ落として、必ず見える位置に置く。
   */
  const visible = (top: number) => top >= MARGIN && top + barHeight <= wrap.height - MARGIN;

  const frameBottom = frame.top + frame.height;
  const belowTop = frameBottom + GAP;
  if (visible(belowTop)) return { left, top: belowTop, width, placement: 'below' };

  // 下に入らない＝枠が画面下部にある。上へ回して、画面外へ消えないようにする。
  const aboveTop = frame.top - GAP - barHeight;
  if (visible(aboveTop)) return { left, top: aboveTop, width, placement: 'above' };

  /*
   * 枠がプレビューをほぼ埋めている／拡大で枠が画面外へ出ている場合。
   * 枠と重なるのは避けられないが、「画面外へ消える」よりは重なってでも見える方がよい。
   * 下端へ寄せる（操作の視線が下にあるため）。
   */
  const top = Math.max(MARGIN, wrap.height - MARGIN - barHeight);
  return { left, top, width, placement: 'inside' };
}
