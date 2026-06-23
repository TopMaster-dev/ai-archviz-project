import { create } from 'zustand';

// AI レンダリング/画像処理のフルスクリーン・オーバーレイ表示中フラグ（UI 専用・Undo 履歴の対象外）。
// オーバーレイを所有する App が更新し、別ツリーに固定配置された UndoRedoBar など（App の外側に
// マウントされ render 状態へ直接アクセスできない要素）が「表示すべきか」を判定するのに使う。
interface RenderOverlayState {
  /** 「クラウドAIで超高画質レンダリング中…」等のオーバーレイ表示中なら true。 */
  active: boolean;
  setActive: (value: boolean) => void;
  /**
   * エディタ上部ツールバーの「下端 Y（px, ビューポート基準）」。別ツリーの UndoRedoBar が
   * ハードコードの top ではなく実測値の直下に配置するために使う。0 のときは未計測（=従来の既定値）。
   */
  headerBottom: number;
  setHeaderBottom: (value: number) => void;
  /**
   * 2Dスケッチの上部ツールバーが最上段(top-6)にあるときの実測下端 Y（px, ビューポート基準）。
   * >0 のとき、別ツリーの UndoRedoBar とホームボタン(AccountMenu)をこの直下へ退避させ、最上段へ上げた
   * 2Dツールバーと重ならないようにする。0 = 2D非表示 もしくはツールバーが下段(top-[136px])にある（=従来位置）。
   */
  sketchToolbarBottom: number;
  setSketchToolbarBottom: (value: number) => void;
  /** 3Dビューのヘッダー内にインラインの undo/redo を表示中なら true（フローティングの UndoRedoBar を隠す・260623）。 */
  undoRedoInline: boolean;
  setUndoRedoInline: (value: boolean) => void;
}

export const useRenderOverlayStore = create<RenderOverlayState>((set) => ({
  active: false,
  // 値が変わらない場合は更新をスキップして不要な再描画を避ける。
  setActive: (value) => set((state) => (state.active === value ? state : { active: value })),
  headerBottom: 0,
  setHeaderBottom: (value) => set((state) => (state.headerBottom === value ? state : { headerBottom: value })),
  sketchToolbarBottom: 0,
  setSketchToolbarBottom: (value) =>
    set((state) => (state.sketchToolbarBottom === value ? state : { sketchToolbarBottom: value })),
  undoRedoInline: false,
  setUndoRedoInline: (value) =>
    set((state) => (state.undoRedoInline === value ? state : { undoRedoInline: value })),
}));
