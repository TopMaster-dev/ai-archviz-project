import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useEyedropper } from '../lib/store/eyedropperStore.js';
import { findSamplableAtPoint, readPixelHex } from '../utils/eyedropperSample.js';

/**
 * アプリ内スポイトのオーバーレイ（260709）。アプリに一度だけ常設する。
 *
 * サンプリング中（useEyedropper.active）は:
 *  - カーソルを十字にし、上部に操作ヒントを表示（ヒント自体は pointer-events:none で下を邪魔しない）。
 *  - 1回のクリック操作（pointerdown → pointerup → click）を丸ごと横取りする。pointerdown だけを
 *    止めても、ブラウザは末尾に click を canvas へ発火し、R3F の選択（onMeshClick / onPointerMissed）は
 *    click ベースなので「色は取れるが 3Dの選択やマテリアル対象が変わる」副作用が出る。これを防ぐため、
 *    pointerdown / pointerup / click すべてを capture で飲み込み、末尾の click まで飲み込んでから解除する。
 *  - 色を読むのはアプリ自身が描いた canvas/img なので、ブラウザ標準スポイトの固まりは起きない。
 *  - canvas/img 以外をクリック → 中止。Esc → 中止。読めなかった（余白/読取不可）→ そのまま（再クリック可）。
 */
export function EyedropperOverlay() {
  const active = useEyedropper((s) => s.active);

  // アンマウント時（例: 「ホームに戻る」でエディタごと外れる）にサンプリング中なら確実に解除する。
  useEffect(() => () => { useEyedropper.getState().cancel(); }, []);

  useEffect(() => {
    if (!active) return;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';

    // pointerdown で「この操作の結末」を決め、末尾の click を飲み込んでから確定/解除する。
    type Pending =
      | { kind: 'pick'; hex: string } // 色が取れた → click 時に反映して終了
      | { kind: 'cancel' } // canvas/img 以外 → click 時に中止
      | { kind: 'retry' } // canvas/imgだが読めない → 何もしない（再クリック可）
      | null;
    let pending: Pending = null;

    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      (e as unknown as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
    };
    // hover 系（move/over/out）は伝播だけ止める（preventDefault は不要でカーソルを乱さない）。
    // これで 3D の当たり判定（ドア/窓のハイライト・「クリックで選択」ツールチップ・カーソル変更）が
    // スポイト中は一切反応しなくなり、「ドア/窓が優先されて色を取れない」を防ぐ。
    const block = (e: Event) => {
      e.stopPropagation();
      (e as unknown as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
    };

    const onPointerDown = (e: PointerEvent) => {
      swallow(e);
      // DOM装飾（pointer-events:none のツールチップ等）が重なっていても、その下の canvas/img を拾う。
      const target = findSamplableAtPoint(e.clientX, e.clientY);
      if (!target) {
        pending = { kind: 'cancel' };
        return;
      }
      const hex = readPixelHex(target, e.clientX, e.clientY);
      pending = hex ? { kind: 'pick', hex } : { kind: 'retry' };
    };

    const onPointerUp = (e: PointerEvent) => {
      swallow(e); // 末尾の click 前に、pointerup 由来の操作も渡さない
    };

    const onClick = (e: MouseEvent) => {
      swallow(e); // ← これが本命。canvas への click 漏れ（選択/対象変更）を止める。
      const p = pending;
      pending = null;
      if (!p) return;
      if (p.kind === 'pick') {
        useEyedropper.getState().pick(p.hex); // 色を反映して終了
      } else if (p.kind === 'cancel') {
        useEyedropper.getState().cancel(); // 中止
      }
      // retry: active のまま（もう一度クリックできる）
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        useEyedropper.getState().cancel();
      }
    };

    // capture=true で他ハンドラ（OrbitControls / R3F）より先に処理して飲み込む
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    // hover を 3D へ渡さない（ドア/窓のハイライト・ツールチップ・カーソル変更を止める）
    window.addEventListener('pointermove', block, true);
    window.addEventListener('pointerover', block, true);
    window.addEventListener('pointerout', block, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointermove', block, true);
      window.removeEventListener('pointerover', block, true);
      window.removeEventListener('pointerout', block, true);
      document.body.style.cursor = prevCursor;
    };
  }, [active]);

  if (!active || typeof document === 'undefined') return null;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'none' }}>
      <div
        style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)' }}
        className="flex items-center gap-2 rounded-full border border-emerald-400/40 bg-neutral-900/90 px-4 py-2 text-xs text-white shadow-2xl backdrop-blur"
      >
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        スポイト：色を取りたい場所（3D画面や画像）をクリック ・ Esc で中止
      </div>
    </div>,
    document.body
  );
}
