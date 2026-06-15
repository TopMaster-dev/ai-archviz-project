import { useEffect, useState } from 'react';
import { PencilRuler, Box, Sparkles, Save, FolderPlus, X } from 'lucide-react';

/**
 * 初回オンボーディングの短い操作ガイド（管理表 row 73）。
 * 「作成 → 描く → 3D → AI → 保存」の流れを最初の訪問時に一度だけ表示する。
 * 表示済みフラグは localStorage に保持し、2回目以降は出さない（×で閉じる / 「はじめる」で閉じる）。
 */
const SEEN_KEY = 'arise.onboarding.seen.v1';

const STEPS = [
  { icon: FolderPlus, title: '作成', desc: '「＋ 新規作成」でプロジェクトを作る' },
  { icon: PencilRuler, title: '描く', desc: '2Dビューで壁・建具・家具を配置' },
  { icon: Box, title: '3D', desc: '3Dビューで素材・天井高・梁などを設定' },
  { icon: Sparkles, title: 'AI', desc: 'AI画像編集でフォトリアルなパースを生成' },
  { icon: Save, title: '保存', desc: '編集は自動保存。「ホームに戻る」で確実に保存' },
] as const;

export function OnboardingGuide() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      // localStorage 不可（プライベートモード等）でもガイド自体は出す。
      setOpen(true);
    }
  }, []);

  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // 保存できなくても閉じる（次回また出るだけで害はない）。
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={dismiss}>
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="操作ガイド"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold">Arise の使い方</h3>
            <p className="mt-0.5 text-[11px] text-neutral-400">5ステップで空間デザインからAIパースまで</p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="閉じる"
            className="rounded-md p-1 text-neutral-400 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ol className="flex flex-col gap-3">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.title} className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <span className="text-sm font-semibold">
                    <span className="mr-1 text-emerald-400">{i + 1}.</span>
                    {s.title}
                  </span>
                  <p className="text-[11px] text-neutral-400">{s.desc}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <button
          type="button"
          onClick={dismiss}
          className="mt-5 w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500"
        >
          はじめる
        </button>
      </div>
    </div>
  );
}
