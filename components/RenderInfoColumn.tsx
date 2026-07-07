import { Lightbulb } from 'lucide-react';
import { AdSlot, ADSENSE_SLOT_IDS } from './AdSlot.js';

/**
 * AIレンダリング／生成の待ち時間に、オーバーレイ右側へ出すサイドカラム。
 * 260707 クライアント要望: 「上半分を広告、下半分をお役立ち情報」の2分割レイアウトにする
 * （以前は全面お役立ち情報。さらに前は全面広告だった）。上下それぞれ独立してスクロールする。
 * 広告は AdSlot（Google AdSense・env 未設定時はプレースホルダ）。狭い画面(lg 未満)では隠す。
 *
 * ※ お役立ち情報の文面は差し替え可能なサンプル。正式コピーが決まったら TIPS を置き換える。
 */
type Tip = { title: string; body: string };

const TIPS: Tip[] = [
  {
    title: 'AIレンダリングのコツ',
    body: '素材・照明・アングル（視点）を先に決めてから生成すると、意図に近いパースに仕上がります。',
  },
  {
    title: 'エリア編集で部分変更',
    body: '家具や壁など一部だけを選んで指示すると、他はそのままに狙った箇所だけを差し替えられます。',
  },
  {
    title: '見積もりと自動連動',
    body: '配置した家具・建材はメーカー／品番／単価が見積もりへ自動反映。素材変更もその場で金額に反映されます。',
  },
  {
    title: '素材・モデルの取り込み',
    body: 'お手持ちの建材画像や3Dモデルをアップロードして、そのまま空間に適用・配置できます。',
  },
  {
    title: '視点を保存して再利用',
    body: 'お気に入りのアングルを保存しておくと、レンダリングやプレゼンで何度でも同じ構図を呼び出せます。',
  },
];

export function RenderInfoColumn({ className }: { className?: string }) {
  return (
    <aside
      className={`pointer-events-auto hidden h-[90vh] w-[300px] flex-col lg:flex ${className ?? ''}`}
      aria-label="広告とお役立ち情報"
    >
      {/* 上半分: 広告 */}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto scroll-dark pb-3">
        <span className="text-[9px] font-bold uppercase tracking-widest text-white/30">広告</span>
        {ADSENSE_SLOT_IDS.map((slot, i) => (
          <AdSlot key={i} slot={slot} width={280} height={220} />
        ))}
      </div>

      {/* 区切り線 */}
      <div className="my-2 h-px w-full shrink-0 bg-white/10" aria-hidden />

      {/* 下半分: お役立ち情報 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-dark pt-1">
        <div className="flex items-center gap-1.5 self-center">
          <Lightbulb className="h-3.5 w-3.5 text-emerald-300/80" aria-hidden />
          <span className="text-[11px] font-black uppercase tracking-widest text-white/45">
            AIや建築業界のお役立ち情報
          </span>
        </div>
        {TIPS.map((tip, i) => (
          <div
            key={i}
            className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 shadow-sm"
          >
            <p className="text-[12px] font-bold text-emerald-300/90">{tip.title}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-white/60">{tip.body}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
