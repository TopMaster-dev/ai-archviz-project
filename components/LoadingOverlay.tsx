import { Loader2 } from 'lucide-react';
import { useLoadingStore } from '../lib/store/loadingStore.js';

/**
 * 汎用ローディング・オーバーレイ（260630 クライアント要望）。
 * 複製や 2D→3D 切替など、一瞬固まって処理中か分かりにくい操作の間、円形スピナーのポップアップを出す。
 * useLoadingStore に reason が1件でもあれば表示。アプリのシェル（ホーム/エディタ両方）に常設する。
 */
export function LoadingOverlay() {
  const reasons = useLoadingStore((s) => s.reasons);
  const keys = Object.keys(reasons);
  if (keys.length === 0) return null;
  const message = reasons[keys[0]];
  return (
    <div
      className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900/90 px-8 py-6 shadow-2xl">
        <Loader2 className="h-9 w-9 animate-spin text-emerald-400" />
        {message && <p className="text-sm font-semibold text-neutral-200">{message}</p>}
      </div>
    </div>
  );
}
