import { MEASURED_GEMINI_2K_SIZES } from './printExportSpec.js';

/**
 * 「そのモデル・その画像サイズ・その比率で、実際に何ピクセルが返ってくるか」を覚えておく（260821）。
 *
 * 【なぜ必要か】
 * 版1の幾何が生成結果と一致していないと、次の2つが同時に起きる。
 *   1. モデルへの入力と要求出力の解像度が食い違い、モデルが構図を描き直しやすくなる
 *   2. 生成結果を版寸法へ cover で戻す際の中央クロップが、編集のたびに蓄積する
 * 図面PJは版1が生成画像そのものなので起きない。写真PJは版1が利用者の写真なので起きる。
 *
 * 【なぜ定数表だけでは足りないか】
 * MEASURED_GEMINI_2K_SIZES に載るのは、人が実測できた比率だけ（現状 16:9 のみ）。
 * しかしスマホ写真は 4:3 や 3:2 が大半で、そこは未実測のまま残る。
 * さらに画像モデルを差し替える（案1）と生成寸法自体が変わりうるため、
 * 手で測った表はいずれ古くなる。
 *
 * そこで「生成が1回でも成功したら、その実寸を覚える」方式にする。
 * 人手の測定を待たずに全比率が揃い、モデルを変えても自動で追従する。
 * 定数表は初回（まだ1回も生成していない状態）の初期値として使う。
 *
 * 保存は localStorage。読み書きは常に try/catch で、失敗しても生成自体は止めない
 * （プライベートモードや容量超過でも編集が壊れないこと優先）。
 */

const STORAGE_KEY = 'arise.generatedSizes.v1';

export interface GeneratedSize {
  w: number;
  h: number;
  /** この寸法を返したモデル（切り分け用。引き当てには使わない）。 */
  model?: string;
}

/**
 * 記憶のキー。画像サイズと比率で引く。
 *
 * モデル名はキーに入れない。クライアントは生成を投げる前にどのモデルが使われるかを
 * 知らない（応答の data.model で初めて分かる）ため、キーに含めると引けなくなる。
 * 代わりにモデル名は値側へ持たせ、記録時に上書きする。案1でモデルを差し替えた場合、
 * 差し替え後の最初の生成で記憶が更新される（その1回だけ古い寸法で走る）。
 */
export function generatedSizeKey(imageSize: string, aspectRatio: string): string {
  return `${imageSize || 'unknown'}|${aspectRatio || 'unknown'}`;
}

function readAll(): Record<string, GeneratedSize> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, GeneratedSize>;
  } catch {
    return {};
  }
}

/** 有限で正の整数のみ通す（壊れた値を覚えるとキャンバス生成ごと失敗する）。 */
function sane(size: unknown): GeneratedSize | null {
  const s = size as { w?: unknown; h?: unknown; model?: unknown } | null;
  const w = typeof s?.w === 'number' && Number.isFinite(s.w) && s.w > 0 ? Math.round(s.w) : 0;
  const h = typeof s?.h === 'number' && Number.isFinite(s.h) && s.h > 0 ? Math.round(s.h) : 0;
  if (!(w > 0 && h > 0)) return null;
  // model は切り分け用にそのまま持ち回す（型が約束しているので落とさない）。
  const model = typeof s?.model === 'string' && s.model ? s.model : undefined;
  return model ? { w, h, model } : { w, h };
}

/**
 * 生成の実寸を覚える。成功した生成の直後に呼ぶ。
 * 同じ値なら書き込まない（無駄な localStorage 書き込みを避ける）。
 */
export function rememberGeneratedSize(key: string, w: number, h: number, model?: string): void {
  const next = sane({ w, h });
  if (!next || !key) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const all = readAll();
    const prev = sane(all[key]);
    if (prev && prev.w === next.w && prev.h === next.h && all[key]?.model === model) return;
    all[key] = { ...next, ...(model ? { model } : {}) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 保存できなくても生成は続行する */
  }
}

/**
 * その条件で返ってくるはずの寸法。
 * 覚えていればそれを、無ければ実測の定数表（比率のみで引く）を、それも無ければ null。
 */
export function recallGeneratedSize(key: string, aspectRatio: string): GeneratedSize | null {
  const remembered = sane(readAll()[key]);
  if (remembered) return remembered;
  return sane(MEASURED_GEMINI_2K_SIZES[aspectRatio]) ?? null;
}

/** テスト・不具合切り分け用。覚えた内容を全部消す。 */
export function clearGeneratedSizeMemory(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
