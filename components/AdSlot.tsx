import { useEffect, useRef } from 'react';

/**
 * Google AdSense 広告枠（仮・260624 クライアント要望）。
 * AIレンダリング／生成のオーバーレイ表示中に出す（待ち時間に広告を見せる想定）。
 *
 * 公開者ID（data-ad-client）は環境変数 `VITE_ADSENSE_CLIENT`（例 'ca-pub-1234567890123456'）、
 * 各広告ユニットのスロットIDは `VITE_ADSENSE_SLOT_1/2/3` で設定する。
 * 未設定の間は「広告スペース（Google AdSense・仮）」のプレースホルダを表示し、
 * AdSense アカウント取得後に .env へ ID を入れるだけで実広告に切り替わる（コード変更不要）。
 *
 * ※注意: AdSense ポリシー上、ポップアップ/オーバーレイ上の広告には制限がある場合がある。
 *   本番公開前に Google AdSense の配置ポリシーを確認すること（現状は「仮」配置）。
 */
const ADSENSE_CLIENT = ((import.meta.env.VITE_ADSENSE_CLIENT as string | undefined) ?? '').trim();

export const ADSENSE_SLOT_IDS: Array<string | undefined> = [
  ((import.meta.env.VITE_ADSENSE_SLOT_1 as string | undefined) ?? '').trim() || undefined,
  ((import.meta.env.VITE_ADSENSE_SLOT_2 as string | undefined) ?? '').trim() || undefined,
  ((import.meta.env.VITE_ADSENSE_SLOT_3 as string | undefined) ?? '').trim() || undefined,
];

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

function ensureAdSenseScript(client: string) {
  if (typeof document === 'undefined') return;
  if (document.querySelector('script[data-adsbygoogle-loader]')) return;
  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
  s.setAttribute('data-adsbygoogle-loader', '1');
  document.head.appendChild(s);
}

export function AdSlot({
  slot,
  className,
  width = 300,
  height = 250,
}: {
  /** AdSense 広告ユニットのスロットID（data-ad-slot）。未設定でもプレースホルダは表示。 */
  slot?: string;
  className?: string;
  width?: number;
  height?: number;
}) {
  const pushed = useRef(false);
  const configured = !!ADSENSE_CLIENT && !!slot;

  useEffect(() => {
    if (!configured) return;
    ensureAdSenseScript(ADSENSE_CLIENT);
    if (pushed.current) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch {
      /* AdSense 未ロード/失敗時は無視（UI を妨げない） */
    }
  }, [configured]);

  // 仮プレースホルダ（AdSense 未設定 or スロット未指定）。
  if (!configured) {
    return (
      <div
        className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/40 text-center ${className ?? ''}`}
        style={{ width, height }}
        aria-label="広告スペース"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">Advertisement</span>
        <span className="mt-1 px-3 text-xs leading-relaxed text-white/55">
          広告スペース
          <br />
          （Google AdSense・仮）
        </span>
      </div>
    );
  }

  return (
    <ins
      className={`adsbygoogle ${className ?? ''}`}
      style={{ display: 'inline-block', width, height }}
      data-ad-client={ADSENSE_CLIENT}
      data-ad-slot={slot}
    />
  );
}

/**
 * AIレンダリング/生成オーバーレイの右側に出す広告カラム（3枠・260624）。
 * 画面が狭いときは隠す（lg 未満）。高さが足りない場合はスクロール。
 */
export function RenderAdColumn({ className }: { className?: string }) {
  return (
    <aside
      className={`pointer-events-auto hidden max-h-[90vh] flex-col items-center gap-3 overflow-y-auto scroll-dark lg:flex ${className ?? ''}`}
      aria-label="広告"
    >
      <span className="text-[9px] font-bold uppercase tracking-widest text-white/30">広告</span>
      {ADSENSE_SLOT_IDS.map((slot, i) => (
        <AdSlot key={i} slot={slot} />
      ))}
    </aside>
  );
}
