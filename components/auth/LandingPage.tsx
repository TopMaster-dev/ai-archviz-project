import { useState } from 'react';
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
  Play,
  MousePointerClick,
  Layers,
  History,
  MessageCircle,
  Lightbulb,
} from 'lucide-react';

/**
 * 未ログイン時のランディングページ（管理表 row 37/42/62/67）。
 * クライアント支給のLPデザイン（LPデザイン_キャッチコピー_1900.pdf）と原稿（_文字.txt）に基づく構成:
 * ヒーロー（キャッチコピー＋PR/操作デモ動画）→ ギャラリー → 主な機能 → 3ステップ（実例画像つき）→
 * 実績数値 → AIデザイン編集 → AIエージェント（260619 クライアント追加要望）→ 4つの訴求バンド → クロージング（招待制）→ フッター。
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
  { icon: PencilRuler, title: '描く', desc: '2Dビューで部屋の輪郭・建具・家具を配置。', img: '/lp/living-dusk-thumb.jpg', alt: '2Dで作図したプランから生成したLDKの3Dパース' },
  { icon: Box, title: '立ち上げる', desc: '3Dへ自動生成し、素材・天井高・梁を設定。', img: '/lp/living-green-thumb.jpg', alt: '折り上げ天井のリビングを3Dで立ち上げた様子' },
  { icon: Wand2, title: '仕上げる', desc: 'AIでパース化し、見積もりまで一気通貫。', img: '/lp/bedroom-thumb.jpg', alt: 'AIでフォトリアルに仕上げたベッドルームのパース' },
] as const;

const GALLERY = [
  { src: '/lp/living-dusk.jpg', alt: '夕景のLDKをAIでフォトリアルに生成したパース' },
  { src: '/lp/living-green.jpg', alt: 'グリーンの折り上げ天井リビングのAIパース' },
  { src: '/lp/bedroom.jpg', alt: '間接照明のベッドルームのAIパース' },
] as const;

const SHOWCASE = [
  {
    eyebrow: 'WORKFLOW',
    title: 'デザインから概算まで、思考・商談を途切れさせない',
    desc: '2D作図から高精細パース、仕上げ材の自動見積もりまでをシームレスに連携。直感的な操作で設計者のひらめきを即座に視覚化し、日々の業務フローを圧倒的なスピードで変革します。',
    img: '/lp/living-dusk.jpg',
    alt: '2Dから生成した3D空間をAIでフォトリアルに仕上げたLDKのパース',
  },
  {
    eyebrow: 'INFRASTRUCTURE',
    title: '直感と実務を繋ぐ、建築・内装の新たなインフラ',
    desc: '直感的な操作と、寸法・原価を伴う実務的な正確さを両立。設計者、施主、建材メーカー、そして未来の才能までをシームレスに繋ぎ、建築業界の新たなスタンダードを創り出します。',
    img: '/lp/living-green.jpg',
    alt: 'グリーンの折り上げ天井リビングの精緻なAIパース',
  },
  {
    eyebrow: 'PRESENTATION',
    title: '「ここを変えたい」に、一瞬で応える。熱量を逃さないプレゼンツール',
    desc: '「壁紙をこうしたい」「床の色を変えたい」。施主の思いつきをその場で形にし、目の前で完成イメージを共有。待ち時間をゼロにし、ワクワクした気持ちのまま意思決定へと導きます。',
    img: '/lp/bedroom.jpg',
    alt: '間接照明とアクセントウォールのベッドルームのAIパース',
  },
  {
    eyebrow: 'AI PARTNER',
    title: 'あなたの「思考の死角」を照らす、もう一人のデザインパートナー',
    desc: '膨大な建材データと過去の文脈を学習したAIが、あなたの設計プロセスに伴走。孤独なアイデアラッシュはもう不要です。まるで優秀な右腕のように、最適なデザイン案を自動で提示します。',
    img: '/lp/living-dusk.jpg',
    alt: 'AIが提案したコーディネートのフォトリアルなLDKパース',
  },
] as const;

/** 新機能①: AIデザイン編集（AI画像編集）の紹介カード（主な機能と同じスタイル。実画面は後日差し替え予定）。 */
const AI_EDIT_FEATURES = [
  { icon: MousePointerClick, title: 'エリア編集', desc: '画像の一部を範囲指定し、参照画像で家具・小物・素材を差し替え・追加。' },
  { icon: Wand2, title: 'AIデザイン提案（おまかせ）', desc: '空間全体をAIが再コーディネート。家具・装飾・照明演出を一新。' },
  { icon: Layers, title: '元画像を維持', desc: '指示した箇所以外は崩さず、寸法・開口・建具を保持して編集。' },
  { icon: History, title: '履歴・比較', desc: '編集のたびにバージョンを保存。過去案へいつでも戻して比較。' },
] as const;

/** 新機能②: AIエージェント機能（相談）の紹介カード。 */
const AI_AGENT_FEATURES = [
  { icon: MessageCircle, title: '文脈を理解した助言', desc: '生成中・編集中の画像を文脈に、配色・素材・レイアウトを相談。' },
  { icon: Lightbulb, title: '進め方まで相談', desc: 'デザインから概算見積もりの進め方まで、実務に踏み込んで提案。' },
  { icon: History, title: '会話履歴を保持', desc: 'プロジェクト単位で相談履歴を保存。画面を移動しても消えません。' },
] as const;

export function LandingPage({
  onLogin,
  onShowLegal,
}: {
  onLogin: () => void;
  onShowLegal?: (kind: 'terms' | 'privacy') => void;
}) {
  const [playing, setPlaying] = useState(false);

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
                {playing ? (
                  <iframe
                    className="absolute inset-0 h-full w-full"
                    src={`https://www.youtube-nocookie.com/embed/${YT_ID}?autoplay=1&rel=0&modestbranding=1`}
                    title="Arise PR・操作デモ動画"
                    loading="lazy"
                    allow="autoplay; encrypted-media; picture-in-picture"
                    allowFullScreen
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setPlaying(true)}
                    className="group absolute inset-0 h-full w-full"
                    aria-label="PR・操作デモ動画を再生"
                  >
                    <img
                      src={`https://i.ytimg.com/vi/${YT_ID}/maxresdefault.jpg`}
                      alt="Arise の操作デモ動画"
                      className="h-full w-full object-cover opacity-85 transition duration-300 group-hover:opacity-100"
                      loading="lazy"
                      onError={(e) => {
                        const t = e.currentTarget;
                        if (!t.dataset.fallback) {
                          t.dataset.fallback = '1';
                          t.src = `https://i.ytimg.com/vi/${YT_ID}/hqdefault.jpg`;
                        }
                      }}
                    />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600/90 text-white shadow-xl ring-4 ring-white/10 transition group-hover:scale-105 group-hover:bg-emerald-500">
                        <Play className="h-7 w-7 translate-x-0.5" fill="currentColor" />
                      </span>
                    </span>
                    <span className="absolute bottom-3 left-4 rounded-md bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur">
                      PR・操作デモ動画
                    </span>
                  </button>
                )}
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

          {/* 特長 */}
          <section id="features" className="scroll-mt-20 py-20">
            <h2 className="mb-2 text-2xl font-black sm:text-3xl">主な機能</h2>
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

          {/* ワークフロー（3ステップ＋実例画像） */}
          <section className="pb-20">
            <h2 className="mb-2 text-2xl font-black sm:text-3xl">3ステップのワークフロー</h2>
            <p className="mb-8 text-sm text-neutral-400">迷わず、最短距離で提案まで。</p>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
              {STEPS.map((s, i) => {
                const Icon = s.icon;
                return (
                  <div key={s.title} className="overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/40">
                    <div className="relative">
                      <img src={s.img} alt={s.alt} loading="lazy" className="aspect-video w-full object-cover" />
                      <span className="absolute right-3 top-2 text-4xl font-black text-white/20">{i + 1}</span>
                    </div>
                    <div className="p-5">
                      <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-emerald-300">
                        <Icon className="h-5 w-5" />
                      </div>
                      <h3 className="text-base font-bold">{s.title}</h3>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400">{s.desc}</p>
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

          {/* 新機能①: AIデザイン編集（主な機能と同じカードスタイルで紹介・260619 クライアント要望） */}
          <section className="pb-16">
            <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-purple-500/[0.08] to-emerald-500/5 p-7 sm:p-10">
              <p className="mb-3 inline-block rounded-full border border-purple-400/30 bg-purple-500/10 px-3 py-1 text-[11px] font-bold tracking-wider text-purple-200">
                NEW · AIデザイン編集
              </p>
              <h2 className="text-2xl font-black sm:text-3xl">生成したパースを、その場で自在に編集</h2>
              <p className="mb-7 mt-2 max-w-2xl text-sm text-neutral-400">
                範囲を指定したピンポイントの差し替えから、空間まるごとのおまかせコーディネートまで。完成イメージを目の前で更新します。
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {AI_EDIT_FEATURES.map((f) => {
                  const Icon = f.icon;
                  return (
                    <div
                      key={f.title}
                      className="rounded-2xl border border-white/10 bg-neutral-900/50 p-5 transition hover:border-purple-400/40 hover:bg-neutral-900"
                    >
                      <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-purple-500/15 text-purple-300">
                        <Icon className="h-5 w-5" />
                      </div>
                      <h3 className="text-sm font-bold">{f.title}</h3>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400">{f.desc}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 新機能②: AIエージェント機能（紹介・260619 クライアント要望） */}
          <section className="pb-20">
            <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-500/[0.08] to-sky-500/5 p-7 sm:p-10">
              <p className="mb-3 inline-block rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold tracking-wider text-emerald-200">
                NEW · AIエージェント
              </p>
              <h2 className="text-2xl font-black sm:text-3xl">もう一人のデザインパートナーに相談</h2>
              <p className="mb-7 mt-2 max-w-2xl text-sm text-neutral-400">
                膨大な建材データと文脈を学習したAIが、あなたの設計プロセスに伴走。孤独なアイデアラッシュは、もう不要です。
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {AI_AGENT_FEATURES.map((f) => {
                  const Icon = f.icon;
                  return (
                    <div
                      key={f.title}
                      className="rounded-2xl border border-white/10 bg-neutral-900/50 p-5 transition hover:border-emerald-400/40 hover:bg-neutral-900"
                    >
                      <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300">
                        <Icon className="h-5 w-5" />
                      </div>
                      <h3 className="text-sm font-bold">{f.title}</h3>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400">{f.desc}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 訴求バンド（キャッチコピー＋フォトリアル実例・交互配置） */}
          <section className="space-y-16 pb-20 sm:space-y-24">
            {SHOWCASE.map((s, i) => (
              <div key={s.title} className="grid items-center gap-6 sm:gap-10 lg:grid-cols-2">
                <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                  <img
                    src={s.img}
                    alt={s.alt}
                    loading="lazy"
                    className="w-full rounded-2xl border border-white/10 object-cover shadow-2xl"
                  />
                </div>
                <div className={i % 2 === 1 ? 'lg:order-1' : ''}>
                  <p className="mb-3 text-[11px] font-black uppercase tracking-[0.2em] text-emerald-400/80">{s.eyebrow}</p>
                  <h3 className="text-xl font-black leading-snug sm:text-3xl">{s.title}</h3>
                  <p className="mt-4 max-w-xl text-sm leading-relaxed text-neutral-400 sm:text-base">{s.desc}</p>
                </div>
              </div>
            ))}
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
