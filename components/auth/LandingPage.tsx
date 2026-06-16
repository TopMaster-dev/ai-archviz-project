import { PencilRuler, Box, Sparkles, Calculator, ArrowRight } from 'lucide-react';

/**
 * 未ログイン時のランディングページ（管理表 row 37/42/62/67）。
 * サービス説明と「ログイン / はじめる」への導線を表示する。
 * 新規登録は招待制のため、公開フォームではなく招待制である旨を案内する。
 * onLogin でログインフォーム（AuthScreen 内）へ切り替える。
 */
const FEATURES = [
  { icon: PencilRuler, title: '2D作図 → 3D自動生成', desc: '平面を描くだけで床・壁・天井・建具を3Dに立ち上げ。' },
  { icon: Sparkles, title: 'AIフォトリアル レンダリング', desc: '3Dビューをキャプチャし、写実的な建築パースをAIで生成。' },
  { icon: Calculator, title: '概算見積もり・マテリアルボード', desc: '建材・家具・巾木を自動集計。PDF / CSV で書き出し。' },
  { icon: Box, title: 'クラウド保存・共有', desc: 'プロジェクトを安全に保存し、閲覧用URLで共有。' },
] as const;

export function LandingPage({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-screen w-screen overflow-y-auto bg-neutral-950 text-neutral-100">
      {/* ヘッダー */}
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-black tracking-tight">Arise</span>
          <span className="hidden text-[11px] text-neutral-500 sm:inline">建築・内装向け AI 空間デザイン</span>
        </div>
        <button
          type="button"
          onClick={onLogin}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-white/30 hover:text-white"
        >
          ログイン
        </button>
      </header>

      {/* ヒーロー */}
      <main className="mx-auto max-w-5xl px-6 pb-16 sm:px-10">
        <section className="py-12 sm:py-20">
          <p className="mb-3 inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold tracking-wider text-emerald-300">
            建築・内装プロのための AI 空間デザイン
          </p>
          <h1 className="max-w-3xl text-3xl font-black leading-tight sm:text-5xl">
            描く・立ち上げる・仕上げるを、
            <br className="hidden sm:block" />
            ひとつの画面で。
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-neutral-400 sm:text-base">
            2Dスケッチから3D空間の自動生成、AIによるフォトリアルなパース、概算見積もりまでを一気通貫。
            設計・施工・提案のスピードを引き上げます。
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onLogin}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-emerald-500"
            >
              ログイン / はじめる
              <ArrowRight className="h-4 w-4" />
            </button>
            <span className="text-[12px] text-neutral-500">招待制：招待メールをお持ちの方はログインへ</span>
          </div>
        </section>

        {/* 特長 */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="rounded-2xl border border-white/10 bg-neutral-900/50 p-5">
                <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-bold">{f.title}</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">{f.desc}</p>
              </div>
            );
          })}
        </section>

        {/* 新規登録の案内（招待制） */}
        <section className="mt-10 rounded-2xl border border-white/10 bg-neutral-900/40 p-6 text-center">
          <h2 className="text-base font-bold">ご利用について</h2>
          <p className="mx-auto mt-2 max-w-xl text-[12px] leading-relaxed text-neutral-400">
            現在 Arise は招待制です。ご利用をご希望の方は運営からの招待メールをご確認ください。
            招待をお持ちの方は、ログインからご利用を開始できます。
          </p>
          <button
            type="button"
            onClick={onLogin}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-neutral-200 transition hover:border-white/30 hover:text-white"
          >
            ログインへ進む
            <ArrowRight className="h-4 w-4" />
          </button>
        </section>
      </main>

      <footer className="border-t border-white/10 px-6 py-6 text-center text-[11px] text-neutral-600 sm:px-10">
        © Arise — 建築・内装向け AI 空間デザイン
      </footer>
    </div>
  );
}
