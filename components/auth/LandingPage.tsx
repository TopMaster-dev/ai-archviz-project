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
  MessageCircle,
} from 'lucide-react';

/**
 * 未ログイン時のランディングページ（管理表 row 37/42/62/67）。
 * クライアント支給のLPデザイン（LPデザイン_キャッチコピー_1900.pdf）と原稿（_文字.txt）に基づく構成:
 * ヒーロー（キャッチコピー＋PR/操作デモ動画）→ ギャラリー → 主な機能 → 3ステップ（実例画像つき）→
 * 実績数値 → AIデザイン編集 → AIエージェント（各リードコピー＋デモ枠・260619 クライアントデザイン）→ クロージング（招待制）→ フッター。
 * 新規登録は招待制のため公開フォームは出さず、招待制である旨を案内し onLogin でログインへ。
 *
 * スクロール: #root が overflow:hidden（エディタの固定ビューポート用）のため、
 * このページは h-screen + overflow-y-auto で内部スクロールさせる（index.css 参照）。
 */

/** 支給のPR/操作デモ動画（YouTube）。 */
const YT_ID = 'vANsagUd29M';

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

const GALLERY = [
  { src: '/lp/living-dusk.jpg', alt: '夕景のLDKをAIでフォトリアルに生成したパース' },
  { src: '/lp/living-green.jpg', alt: 'グリーンの折り上げ天井リビングのAIパース' },
  { src: '/lp/bedroom.jpg', alt: '間接照明のベッドルームのAIパース' },
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

        <main className="mx-auto max-w-6xl px-6 sm:px-10">
          {/* ヒーロー */}
          <section className="animate-in fade-in slide-in-from-bottom-2 pt-16 sm:pt-24">
            <div>
              <p className="mb-5 inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold tracking-wider text-emerald-300">
                建築・内装プロのための AI 空間デザイン
              </p>
              <h1 className="text-4xl font-black leading-[1.12] tracking-tight sm:text-6xl lg:text-7xl">
                あなたの思考を、全方位に拡張する
              </h1>
              <p className="mt-6 max-w-2xl text-sm leading-relaxed text-neutral-400 sm:text-base">
                数日かかっていた提案準備を極限まで削ぎ落とす、クライアントを待たせない実務特化型プラットフォーム。
                2D作図から3D空間の自動生成、AIによるフォトリアルなイメージを生成、実寸テクスチャ投影、建材の概算見積もりを自動生成。
                設計・提案スピードを格段に高め、ブラウザ一つで高スペックPCがなくても商談から提案までを一貫してサポートします。
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
            </div>

            {/* PR / 操作デモ動画 */}
            <div className="mt-12">
              <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
                {/* 自動再生（ブラウザ仕様上 muted 必須）＋ループ。コントロールは表示し、ユーザーが音声オン/全画面に切替可能。 */}
                <iframe
                  className="absolute inset-0 h-full w-full"
                  src={`https://www.youtube-nocookie.com/embed/${YT_ID}?autoplay=1&mute=1&loop=1&playlist=${YT_ID}&controls=1&rel=0&modestbranding=1&playsinline=1`}
                  title="Arise PR・操作デモ動画"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              </div>
            </div>

            {/* ギャラリー（フォトリアル実例） */}
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {GALLERY.map((g) => (
                <div key={g.src} className="overflow-hidden rounded-xl border border-white/10 bg-neutral-900">
                  <img
                    src={g.src}
                    alt={g.alt}
                    loading="lazy"
                    className="aspect-video w-full object-cover transition duration-500 hover:scale-[1.03]"
                  />
                </div>
              ))}
            </div>
          </section>

          {/* リード（デザインから概算まで…）＋ 主な機能 */}
          <section id="features" className="scroll-mt-20 py-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              デザインから概算まで、
              <br className="hidden sm:block" />
              思考・商談を途切れさせない
            </h2>
            <p className="mb-14 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              2D作図から高精細パース、仕上げ材の自動見積もりまでをシームレスに連携。直感的な操作で設計者のひらめきを即座に視覚化し、日々の業務フローを圧倒的なスピードで変革します。
            </p>
            <h3 className="mb-2 text-2xl font-black sm:text-3xl">主な機能</h3>
            <p className="mb-8 text-sm text-neutral-400">設計から提案までを、ひとつのツールで完結。</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f, i) => {
                const Icon = f.icon;
                return (
                  <div
                    key={f.title}
                    className="animate-in fade-in slide-in-from-bottom-2 group rounded-2xl border border-white/10 bg-neutral-900/50 p-5 transition duration-300 hover:-translate-y-1 hover:border-emerald-500/40 hover:bg-neutral-900"
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

          {/* リード（直感と実務を繋ぐ…）＋ 3ステップ＋画面キャプチャ */}
          <section className="pb-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              直感と実務を繋ぐ、
              <br className="hidden sm:block" />
              建築・内装の新たなインフラ
            </h2>
            <p className="mb-14 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              直感的な操作と、寸法・原価を伴う実務的な正確さを両立。設計者、施主、建材メーカー、そして未来の才能までをシームレスに繋ぎ、建築業界の新たなスタンダードを創り出します。
            </p>

            <h3 className="mb-2 text-2xl font-black sm:text-3xl">3ステップのワークフロー</h3>
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

            {/* 2D / 3D / AI画像編集 の画面キャプチャ枠（後日クライアント支給のスクリーンショットに差し替え予定） */}
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[
                { label: '2Dビュー', icon: PencilRuler },
                { label: '3Dビュー', icon: Box },
                { label: 'AI画像編集', icon: Wand2 },
              ].map((s) => {
                const Icon = s.icon;
                return (
                  <div
                    key={s.label}
                    className="flex aspect-video items-center justify-center rounded-2xl border border-dashed border-white/15 bg-neutral-900/40 text-center"
                  >
                    <div className="text-neutral-500">
                      <Icon className="mx-auto mb-2 h-7 w-7" />
                      <p className="text-[12px] font-bold text-neutral-400">{s.label}</p>
                      <p className="mt-0.5 text-[10px] text-neutral-600">画面キャプチャを準備中</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 実績数値 */}
          <section className="pb-20">
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

          {/* AIデザイン編集（リード＝「ここを変えたい」…＋デモ枠・260619 クライアントデザイン） */}
          <section className="pb-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              「ここを変えたい」に、一瞬で応える。
              <br className="hidden sm:block" />
              熱量を逃さないプレゼンツール
            </h2>
            <p className="mb-10 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              「壁紙をこうしたい」「床の色を変えたい」。施主の思いつきをその場で形にし、目の前で完成イメージを共有。待ち時間をゼロにし、ワクワクした気持ちのまま意思決定へと導きます。
            </p>
            {/* AIデザイン・エリア編集のデモ枠（後日クライアント支給のキャプチャ／動画に差し替え予定） */}
            <div className="flex aspect-[16/8] items-center justify-center rounded-3xl border border-dashed border-purple-300/20 bg-gradient-to-br from-purple-500/[0.06] to-neutral-900/40 text-center">
              <div className="px-6 text-neutral-500">
                <Wand2 className="mx-auto mb-3 h-9 w-9 text-purple-300/70" />
                <p className="text-sm font-bold text-neutral-300">AIデザイン・エリア編集のデモ</p>
                <p className="mt-1 text-[12px] text-neutral-500">画像生成のスピード感をご紹介（キャプチャ／動画を準備中）</p>
              </div>
            </div>
          </section>

          {/* AIエージェント（リード＝「思考の死角」…＋デモ枠・260619 クライアントデザイン） */}
          <section className="pb-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              あなたの「思考の死角」を照らす、
              <br className="hidden sm:block" />
              もう一人のデザインパートナー
            </h2>
            <p className="mb-10 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              膨大な建材データと過去の文脈を学習したAIが、あなたの設計プロセスに伴走。孤独なアイデアラッシュはもう不要です。まるで優秀な右腕のように、最適なデザイン案を自動で提示します。
            </p>
            {/* AIエージェント機能の紹介デモ枠（後日クライアント支給のキャプチャ／動画に差し替え予定） */}
            <div className="flex aspect-[16/8] items-center justify-center rounded-3xl border border-dashed border-emerald-300/20 bg-gradient-to-br from-emerald-500/[0.06] to-neutral-900/40 text-center">
              <div className="px-6 text-neutral-500">
                <MessageCircle className="mx-auto mb-3 h-9 w-9 text-emerald-300/70" />
                <p className="text-sm font-bold text-neutral-300">AIエージェント機能の紹介</p>
                <p className="mt-1 text-[12px] text-neutral-500">相談の様子をご紹介（キャプチャ／動画を準備中）</p>
              </div>
            </div>
          </section>

          {/* クロージング CTA */}
          <section className="pb-20">
            <div className="overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-sky-500/5 p-8 text-center sm:p-14">
              <h2 className="text-3xl font-black sm:text-5xl">
                さあ、
                <span className="bg-gradient-to-r from-emerald-400 to-sky-400 bg-clip-text text-transparent">起き上がれ</span>
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-[13px] leading-relaxed text-neutral-300">
                現在 Arise は招待制です。ご利用をご希望の方は運営からの招待メールをご確認ください。
                招待をお持ちの方は、ログインからご利用を開始できます。
              </p>
              <button
                type="button"
                onClick={onLogin}
                className="group mt-7 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-8 py-3.5 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500"
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
