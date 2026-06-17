import {
  PencilRuler,
  Box,
  Sparkles,
  Calculator,
  ArrowRight,
  Share2,
  Ruler,
  LayoutGrid,
  Wand2,
} from 'lucide-react';

/**
 * 未ログイン時のランディングページ（管理表 row 37/42/62/67）。
 * サービス説明・特長・ワークフロー・CTA を備えた縦スクロールの紹介ページ。
 * 新規登録は招待制のため、公開フォームではなく招待制である旨を案内する。
 * onLogin でログインフォーム（AuthScreen 内）へ切り替える。
 *
 * スクロール: #root が overflow:hidden（エディタの固定ビューポート用）のため、
 * このページは h-screen + overflow-y-auto で内部スクロールさせる（index.css 参照）。
 */
const FEATURES = [
  { icon: PencilRuler, title: '2D作図 → 3D自動生成', desc: '平面を描くだけで床・壁・天井・建具を3D空間へ自動で立ち上げ。' },
  { icon: Sparkles, title: 'AIフォトリアル レンダリング', desc: '3Dビューをキャプチャし、写実的な建築パースをワンクリックで生成。' },
  { icon: Ruler, title: '実寸テクスチャ投影', desc: '建材の実寸メタデータから、壁・床に正しい寸法でリピート投影。' },
  { icon: Calculator, title: '概算見積もり', desc: '建材・家具・巾木・梁を自動集計し、PDF / CSV で書き出し。' },
  { icon: LayoutGrid, title: 'マテリアルボード', desc: 'A3レイアウトで素材一覧を出力。提案資料がそのまま整う。' },
  { icon: Share2, title: 'クラウド保存・共有', desc: 'プロジェクトを安全に保存し、閲覧用URLでクライアントへ共有。' },
] as const;

const STEPS = [
  { icon: PencilRuler, title: '描く', desc: '2Dビューで部屋の輪郭・建具・家具を配置。' },
  { icon: Box, title: '立ち上げる', desc: '3Dへ自動生成し、素材・天井高・梁を設定。' },
  { icon: Wand2, title: '仕上げる', desc: 'AIでパース化し、見積もりまで一気通貫。' },
] as const;

export function LandingPage({
  onLogin,
  onShowLegal,
}: {
  onLogin: () => void;
  onShowLegal?: (kind: 'terms' | 'privacy') => void;
}) {
  return (
    <div className="relative h-screen w-screen overflow-y-auto overflow-x-hidden bg-neutral-950 text-neutral-100">
      {/* 背景の装飾グラデーション（ゆっくり明滅） */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div
          className="absolute -top-32 -left-24 h-[28rem] w-[28rem] rounded-full bg-emerald-500/20 blur-3xl animate-pulse"
          style={{ animationDuration: '7s' }}
        />
        <div
          className="absolute top-1/3 -right-24 h-[26rem] w-[26rem] rounded-full bg-sky-500/15 blur-3xl animate-pulse"
          style={{ animationDuration: '9s', animationDelay: '1s' }}
        />
        <div
          className="absolute bottom-0 left-1/3 h-[24rem] w-[24rem] rounded-full bg-purple-500/10 blur-3xl animate-pulse"
          style={{ animationDuration: '11s', animationDelay: '2s' }}
        />
      </div>

      <div className="relative">
        {/* ヘッダー */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/5 bg-neutral-950/60 px-6 py-4 backdrop-blur-md sm:px-10">
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

        <main className="mx-auto max-w-5xl px-6 sm:px-10">
          {/* ヒーロー */}
          <section className="animate-in fade-in slide-in-from-bottom-2 py-16 sm:py-28">
            <p className="mb-4 inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold tracking-wider text-emerald-300">
              建築・内装プロのための AI 空間デザイン
            </p>
            <h1 className="max-w-3xl text-4xl font-black leading-[1.15] sm:text-6xl">
              描く・立ち上げる・
              <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-sky-400 bg-clip-text text-transparent">
                仕上げる
              </span>
              を、ひとつの画面で。
            </h1>
            <p className="mt-6 max-w-2xl text-sm leading-relaxed text-neutral-400 sm:text-lg">
              2Dスケッチから3D空間の自動生成、AIによるフォトリアルなパース、実寸テクスチャ投影、概算見積もりまでを一気通貫。
              設計・施工・提案のスピードを引き上げます。
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onLogin}
                className="group inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-7 py-3.5 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500 hover:shadow-emerald-700/40"
              >
                ログイン / はじめる
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
              <a
                href="#features"
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-6 py-3.5 text-sm font-semibold text-neutral-200 transition hover:border-white/30 hover:text-white"
              >
                機能を見る
              </a>
              <span className="text-[12px] text-neutral-500">招待制：招待メールをお持ちの方はログインへ</span>
            </div>
          </section>

          {/* 特長 */}
          <section id="features" className="scroll-mt-20 pb-16">
            <h2 className="mb-2 text-2xl font-black sm:text-3xl">主な機能</h2>
            <p className="mb-8 text-sm text-neutral-400">設計から提案までを、ひとつのツールで完結。</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f, i) => {
                const Icon = f.icon;
                return (
                  <div
                    key={f.title}
                    className="animate-in fade-in slide-in-from-bottom-2 group rounded-2xl border border-white/10 bg-neutral-900/50 p-5 opacity-0 transition duration-300 hover:-translate-y-1 hover:border-emerald-500/40 hover:bg-neutral-900"
                    style={{ animationDelay: `${i * 90}ms` }}
                  >
                    <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300 transition group-hover:bg-emerald-500/25">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-sm font-bold">{f.title}</h3>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400">{f.desc}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ワークフロー（3ステップ） */}
          <section className="pb-16">
            <h2 className="mb-2 text-2xl font-black sm:text-3xl">3ステップのワークフロー</h2>
            <p className="mb-8 text-sm text-neutral-400">迷わず、最短距離で提案まで。</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {STEPS.map((s, i) => {
                const Icon = s.icon;
                return (
                  <div key={s.title} className="relative rounded-2xl border border-white/10 bg-neutral-900/40 p-6">
                    <span className="absolute right-5 top-4 text-5xl font-black text-white/5">{i + 1}</span>
                    <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-white/5 text-emerald-300">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-base font-bold">{s.title}</h3>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400">{s.desc}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 価値の訴求 */}
          <section className="pb-16">
            <div className="grid grid-cols-2 gap-4 rounded-2xl border border-white/10 bg-gradient-to-br from-neutral-900/70 to-neutral-900/30 p-8 sm:grid-cols-4">
              {[
                { k: '2D→3D', v: '自動生成' },
                { k: 'AI', v: 'フォトリアル' },
                { k: '実寸', v: 'テクスチャ投影' },
                { k: 'PDF/CSV', v: '見積出力' },
              ].map((s) => (
                <div key={s.k} className="text-center">
                  <div className="bg-gradient-to-r from-emerald-400 to-sky-400 bg-clip-text text-xl font-black text-transparent sm:text-2xl">
                    {s.k}
                  </div>
                  <div className="mt-1 text-[11px] text-neutral-400">{s.v}</div>
                </div>
              ))}
            </div>
          </section>

          {/* CTA + 招待制の案内 */}
          <section className="pb-20">
            <div className="rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-sky-500/5 p-8 text-center sm:p-12">
              <h2 className="text-2xl font-black sm:text-3xl">今すぐ、空間づくりをはじめる</h2>
              <p className="mx-auto mt-3 max-w-xl text-[13px] leading-relaxed text-neutral-300">
                現在 Arise は招待制です。ご利用をご希望の方は運営からの招待メールをご確認ください。
                招待をお持ちの方は、ログインからご利用を開始できます。
              </p>
              <button
                type="button"
                onClick={onLogin}
                className="group mt-6 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-7 py-3.5 text-sm font-bold text-white transition hover:bg-emerald-500"
              >
                ログインへ進む
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          </section>
        </main>

        <footer className="border-t border-white/10 px-6 py-8 text-center text-[11px] text-neutral-600 sm:px-10">
          {onShowLegal && (
            <div className="mb-2 flex items-center justify-center gap-3 text-neutral-500">
              <button type="button" onClick={() => onShowLegal('terms')} className="transition hover:text-neutral-300">
                利用規約
              </button>
              <span className="text-neutral-700">/</span>
              <button type="button" onClick={() => onShowLegal('privacy')} className="transition hover:text-neutral-300">
                プライバシーポリシー
              </button>
            </div>
          )}
          © Arise — 建築・内装向け AI 空間デザイン
        </footer>
      </div>
    </div>
  );
}
