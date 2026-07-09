import { create } from 'zustand';

/**
 * メイン3Dルームキャンバスのレンダーループを一時停止するためのカウンタ（260709）。
 *
 * 目的: ネイティブのカラーピッカー/スポイト（eyedropper）が開いている間、3Dの連続レンダー（frameloop="always"）を止め、
 * キャンバスを静止させる。スポイトはスクリーン（＝3D WebGLキャンバス）のピクセルを読み取り続けるが、その最中に
 * キャンバスが毎フレーム再描画（しかも preserveDrawingBuffer=true）していると、読み取りと再描画が競合してブラウザが
 * 固まる（＝スポイト使用時のみハング・警告音・ピッカーが開いたまま）。静止させれば競合しない。
 *
 * ※ 一時停止中もアプリは応答する（メインスレッドは自由）。paused はカラー入力の focus/blur で増減し、ピッカーを
 *    閉じれば（blur）自動的に 0 に戻って再開する。カウンタなので複数のカラー入力があっても取りこぼさない。
 */
interface Room3DPauseState {
  pauseCount: number;
  acquire: () => void;
  release: () => void;
}

export const useRoom3DPause = create<Room3DPauseState>((set) => ({
  pauseCount: 0,
  acquire: () => set((s) => ({ pauseCount: s.pauseCount + 1 })),
  release: () => set((s) => ({ pauseCount: Math.max(0, s.pauseCount - 1) })),
}));
