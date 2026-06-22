import { useEffect, useState } from 'react';
import { PencilRuler, Box, Sparkles, Save, FolderPlus, X, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * 操作ガイド（管理表 row 73）。
 * 260623 クライアント要望: 一度きりの表示ではなく、ホーム右上の「?」からいつでも見返せるスライド形式に変更。
 * 表示制御は親（HomeScreen）が行う（open/onClose）。初回だけ自動表示する判定も親が SEEN_KEY で行う。
 * 各スライドはフルパネル画像（後日クライアント支給）に差し替え可能。画像未設定の間はステップ説明のプレースホルダを表示する。
 */
export const ONBOARDING_SEEN_KEY = 'arise.onboarding.seen.v1';

type Slide = {
  icon: typeof FolderPlus;
  step: string;
  title: string;
  desc: string;
  /** 後日差し替え用のフルパネル画像URL（例 /onboarding/01.jpg）。未設定時はプレースホルダ表示。 */
  image?: string;
};

const SLIDES: Slide[] = [
  { icon: FolderPlus, step: '1', title: 'プロジェクトを作成', desc: '「＋ 新規作成」で「空間デザイン」または「写真をAI編集」を選んで作成します。' },
  { icon: PencilRuler, step: '2', title: '2Dで描く', desc: '2Dビューで部屋の輪郭・建具（ドア/窓）・家具を配置します。' },
  { icon: Box, step: '3', title: '3Dへ立ち上げる', desc: '3Dビューへ自動生成。素材・天井高・梁などを設定します。' },
  { icon: Sparkles, step: '4', title: 'AIで仕上げる', desc: 'AIレンダリング／画像編集でフォトリアルなパースを生成。見積もりまで一気通貫。' },
  { icon: Save, step: '5', title: '保存・共有', desc: '編集は自動保存。「ホームに戻る」で確実に保存し、閲覧用URLで共有できます。' },
];

export function OnboardingGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  // 開き直すたびに先頭スライドから（見返しやすさ）。
  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);
  if (!open) return null;

  const slide = SLIDES[idx];
  const Icon = slide.icon;
  const go = (d: number) => setIdx((i) => (i + d + SLIDES.length) % SLIDES.length);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="操作ガイド"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-neutral-200 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        {/* フルパネル（画像 or プレースホルダ）。画像が揃ったら slide.image を設定すると全面表示に切替わる。 */}
        <div className="relative flex aspect-[16/9] items-center justify-center bg-gradient-to-br from-emerald-500/[0.08] to-neutral-900">
          {slide.image ? (
            <img src={slide.image} alt={slide.title} className="h-full w-full object-cover" />
          ) : (
            <div className="px-10 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-300">
                <Icon className="h-8 w-8" />
              </div>
              <p className="text-xs font-bold tracking-wider text-emerald-400">
                STEP {slide.step} / {SLIDES.length}
              </p>
              <h3 className="mt-1 text-xl font-bold">{slide.title}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-300">{slide.desc}</p>
              <p className="mt-4 text-[10px] text-neutral-600">※ ガイド画像は準備中です</p>
            </div>
          )}

          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="前へ"
            className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white shadow-lg transition hover:bg-black/70"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="次へ"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white shadow-lg transition hover:bg-black/70"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </div>

        {/* ドットインジケータ */}
        <div className="flex items-center justify-center gap-2 py-3">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIdx(i)}
              aria-label={`${i + 1}枚目を表示`}
              className={`h-2 rounded-full transition-all ${
                i === idx ? 'w-5 bg-emerald-400' : 'w-2 bg-white/25 hover:bg-white/40'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
