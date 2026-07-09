import { create } from 'zustand';

/**
 * アプリ内スポイト（in-app eyedropper）の調停ストア（260709）。
 *
 * ブラウザ標準のスポイト（スクリーン読取）は Chrome のバグで固まるため使えない。代わりに、
 * 「アプリ自身が描いている canvas / img（3D画面・アプリ内の画像）」からクリック位置の色を読む
 * 安全なスポイトを用意する。カラーピッカーが start() でサンプリングを開始し、EyedropperOverlay が
 * 次のクリックで色を読んで pick() する。読めた色は start() で渡したコールバックへ返す。
 */
interface EyedropperState {
  /** サンプリング中か */
  active: boolean;
  /** 色が取れたときに呼ぶコールバック（開始側が登録） */
  onPick: ((hex: string) => void) | null;
  /** サンプリング開始 */
  start: (onPick: (hex: string) => void) => void;
  /** 色を確定（オーバーレイが呼ぶ）→ コールバックへ渡して終了 */
  pick: (hex: string) => void;
  /** 中止（Esc・対象外クリック） */
  cancel: () => void;
}

export const useEyedropper = create<EyedropperState>((set, get) => ({
  active: false,
  onPick: null,
  start: (onPick) => set({ active: true, onPick }),
  pick: (hex) => {
    const cb = get().onPick;
    set({ active: false, onPick: null });
    if (cb) cb(hex);
  },
  cancel: () => set({ active: false, onPick: null }),
}));
