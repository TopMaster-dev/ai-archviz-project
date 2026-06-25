import { useState, useRef, useEffect, useCallback, type ReactNode, type RefObject } from 'react';
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
  X,
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

/**
 * 日本語の改行を「文節」単位で行うためのヘルパー（260619 クライアント要望「改行を綺麗に」）。
 * 各句を inline-block にすると、行末では句の途中（例「プラット/フォーム」）ではなく句の境界で折り返すため、
 * 語の不自然な分断や孤立文字（例「拡張す/る」）が起きにくい。parts は読点・助詞など意味の切れ目で区切って渡す。
 * 文字列は分割するだけで増減しない（原稿の文言は変えない）。狭い画面で1句が長すぎる場合のみ句内でも折り返す（破綻回避）。
 */
function Jp({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="inline-block">
          {p}
        </span>
      ))}
    </>
  );
}

const FEATURES = [
  { icon: PencilRuler, title: '2D作図 → 3D自動生成', desc: ['平面を描くだけで', '床・壁・天井・建具を', '3D空間へ自動で立ち上げ。'] },
  { icon: Sparkles, title: 'AIフォトリアル レンダリング', desc: ['3Dビューをキャプチャし、', '写実的な建築パースを', 'ワンクリックで生成。'] },
  { icon: Ruler, title: '実寸テクスチャ投影', desc: ['建材の実寸メタデータから、', '壁・床に正しい寸法で', 'リピート投影。'] },
  { icon: Calculator, title: '概算見積もり', desc: ['建材・家具・巾木・梁を自動集計し、', 'PDF / CSV で書き出し。'] },
  { icon: LayoutGrid, title: 'マテリアルボード', desc: ['A3レイアウトで素材一覧を出力。', '提案資料がそのまま整う。'] },
  { icon: Share2, title: 'クラウド保存・共有', desc: ['プロジェクトを安全に保存し、', '閲覧用URLでクライアントへ共有。'] },
] as const;

const STEPS = [
  { icon: PencilRuler, title: '描く', desc: ['2Dビューで部屋の輪郭・', '建具・家具を配置。'] },
  { icon: Box, title: '立ち上げる', desc: ['3Dへ自動生成し、', '素材・天井高・梁を設定。'] },
  { icon: Wand2, title: '仕上げる', desc: ['AIでパース化し、', '見積もりまで一気通貫。'] },
] as const;

// ギャラリー画像は assets/lp-gallery/ に格納し、フォルダ内の全画像を自動表示する（260625 クライアント要望）。
// Vite の import.meta.glob でビルド時に全件取り込む＝フォルダへ画像を追加してビルドすれば自動でスライダーに増える。
const GALLERY_IMAGE_MODULES = import.meta.glob('../../public/assets/lp-gallery/*.{jpg,jpeg,png,webp}', {
  eager: true,
  import: 'default',
}) as Record<string, string>;
const GALLERY: { src: string; alt: string }[] = Object.entries(GALLERY_IMAGE_MODULES)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, src]) => ({ src, alt: 'Ariseで生成した内装パースの実例' }));

/** LP の実例画像（クリックで拡大）。triggerRef は閉じたときにフォーカスを戻す呼び出し元ボタン。 */
interface LpLightboxImage {
  src: string;
  alt: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/** 画像をクリックで拡大表示するトリガ。キーボード操作可能な実 <button> で包む（260624 クライアント要望）。 */
function ImageTrigger({
  src,
  alt,
  onOpen,
  children,
  tabIndex,
}: {
  src: string;
  alt: string;
  onOpen: (image: LpLightboxImage) => void;
  children: ReactNode;
  /** スライダーの複製要素はキーボード移動の重複を避けるため -1 を渡す。 */
  tabIndex?: number;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={triggerRef}
      type="button"
      tabIndex={tabIndex}
      onClick={() => onOpen({ src, alt, triggerRef })}
      aria-label={`${alt}を拡大表示`}
      className="focus-ring block w-full cursor-zoom-in rounded-xl"
    >
      {children}
    </button>
  );
}

/**
 * ギャラリーの横スライダー（マーキー）。右→左へ自動スクロールし、フォルダ内の全画像をループ表示する。
 * 各画像はクリックで拡大（対応する大きい画像を Lightbox に表示）。hover で一時停止、prefers-reduced-motion 尊重（index.css）。
 * 継ぎ目のないループのため同じ並びを2セット描画し、CSS で track を -50% まで移動させる（内容が左へ流れる＝右から左）。
 */
function GalleryMarquee({ onOpen }: { onOpen: (image: LpLightboxImage) => void }) {
  if (GALLERY.length === 0) return null;
  const renderSet = (duplicate: boolean) =>
    GALLERY.map((g, i) => (
      <div
        key={`${duplicate ? 'dup' : 'src'}-${i}`}
        className="w-[clamp(15rem,42vw,26rem)] shrink-0"
        aria-hidden={duplicate || undefined}
      >
        {/* 複製セットはスクリーンリーダー/キーボードの重複を避ける（tabIndex=-1・alt 空） */}
        <ImageTrigger src={g.src} alt={g.alt} onOpen={onOpen} tabIndex={duplicate ? -1 : 0}>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-neutral-900">
            <img
              src={g.src}
              alt={duplicate ? '' : g.alt}
              loading="lazy"
              className="aspect-video w-full object-cover"
            />
          </div>
        </ImageTrigger>
      </div>
    ));
  return (
    <div className="lp-marquee relative mt-6 overflow-hidden">
      <div className="lp-marquee-track flex w-max gap-4 py-1">
        {renderSet(false)}
        {renderSet(true)}
      </div>
    </div>
  );
}

/** 実例画像のライトボックス（拡大モーダル）。背景クリック / × / Escape で閉じる。 */
function Lightbox({
  image,
  onClose,
  scrollRef,
}: {
  image: LpLightboxImage | null;
  onClose: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!image) return;
    // 背面（LP本体）のスクロールを止める。スクロールは body ではなく外側の overflow-y-auto コンテナで起きるため、
    // そのコンテナの overflowY のみ一時 hidden にする。復元は空文字（overflow-x-hidden クラスを壊さない）。
    const container = scrollRef.current;
    if (container) container.style.overflowY = 'hidden';
    closeRef.current?.focus(); // 開いたら × へフォーカス（キーボードで即閉じられる）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const trigger = image.triggerRef?.current ?? null;
    return () => {
      document.removeEventListener('keydown', onKey);
      if (container) container.style.overflowY = '';
      trigger?.focus(); // 閉じたら呼び出し元の画像ボタンへフォーカスを戻す
    };
  }, [image, onClose, scrollRef]);

  if (!image) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.alt}
      onClick={onClose}
      className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm sm:p-8"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="閉じる"
        className="focus-ring absolute right-4 top-4 z-[51] flex h-10 w-10 items-center justify-center rounded-lg bg-white/10 text-white transition hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      {/* 画像自体のクリックでは閉じない（背景クリックのみ閉じる） */}
      <img
        src={image.src}
        alt={image.alt}
        onClick={(e) => e.stopPropagation()}
        className="animate-in fade-in zoom-in-95 max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
      />
    </div>
  );
}

export function LandingPage({
  onLogin,
  onShowLegal,
}: {
  onLogin: () => void;
  onShowLegal?: (kind: 'terms' | 'privacy') => void;
}) {
  const [lightboxImage, setLightboxImage] = useState<LpLightboxImage | null>(null);
  const closeLightbox = useCallback(() => setLightboxImage(null), []);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={scrollContainerRef}
      className="relative h-screen w-screen overflow-y-auto overflow-x-hidden bg-neutral-950 text-neutral-100"
    >
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
            <div className="text-center">
              <p className="mb-5 inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold tracking-wider text-emerald-300">
                建築・内装プロのための AI 空間デザイン
              </p>
              <h1 className="text-4xl font-black leading-[1.12] tracking-tight sm:text-6xl lg:text-7xl">
                <Jp parts={['あなたの思考を、', '全方位に拡張する']} />
              </h1>
              <p className="mt-6 max-w-2xl mx-auto text-sm leading-relaxed text-neutral-400 sm:text-base">
                <Jp
                  parts={[
                    '数日かかっていた提案準備を',
                    '極限まで削ぎ落とす、',
                    'クライアントを待たせない',
                    '実務特化型プラットフォーム。',
                    '2D作図からAIパース生成や',
                    'イメージ編集、',
                    '実寸テクスチャ投影、',
                    '建材の概算見積もりを自動生成。',
                    '設計・提案スピードを格段に高め、',
                    'ブラウザ一つで高スペックPCがなくても',
                    '商談から提案までを',
                    '一貫してサポートします。',
                  ]}
                />
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
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
                <span className="text-[12px] text-neutral-500">
                  <Jp parts={['招待制：', '招待メールをお持ちの方はログインへ']} />
                </span>
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

            {/* ギャラリー（フォトリアル実例）: 右→左に自動スクロールする横スライダー。各画像クリックで拡大。 */}
            <GalleryMarquee onOpen={setLightboxImage} />
          </section>

          {/* リード（デザインから概算まで…）＋ 主な機能 */}
          <section id="features" className="scroll-mt-20 py-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              <span className="inline-block">デザインから概算まで、</span>
              <br className="hidden sm:block" />
              <span className="inline-block">思考・商談を途切れさせない</span>
            </h2>
            <p className="mb-14 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              <Jp
                parts={[
                  '2D作図からAIパース、',
                  '仕上げ材の自動見積もりまでを',
                  'シームレスに連携。',
                  '直感的な操作で',
                  '設計者のひらめきを即座に視覚化し、',
                  '日々の業務フローを',
                  '圧倒的なスピードで変革します。',
                ]}
              />
            </p>
            <h3 className="mb-2 text-2xl font-black sm:text-3xl">主な機能</h3>
            <p className="mb-8 text-sm text-neutral-400">
              <Jp parts={['設計から提案までを、', 'ひとつのツールで完結。']} />
            </p>
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
                    <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400">
                      <Jp parts={f.desc} />
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* リード（直感と実務を繋ぐ…）＋ 3ステップ＋画面キャプチャ */}
          <section className="pb-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              <span className="inline-block">直感と実務を繋ぐ、</span>
              <br className="hidden sm:block" />
              <span className="inline-block">建築・内装の新たなインフラ</span>
            </h2>
            <p className="mb-14 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              <Jp
                parts={[
                  '直感的な操作と、',
                  '寸法・原価を伴う',
                  '実務的な正確さを両立。',
                  '設計者、施主、建材メーカー、',
                  'そして未来の才能までを',
                  'シームレスに繋ぎ、',
                  '建築業界の新たなスタンダードを',
                  '創り出します。',
                ]}
              />
            </p>

            <h3 className="mb-2 text-2xl font-black sm:text-3xl">3ステップのワークフロー</h3>
            <p className="mb-8 text-sm text-neutral-400">
              <Jp parts={['迷わず、', '最短距離で提案まで。']} />
            </p>
            {/* 実績数値 */}
            <div className="mb-2 grid grid-cols-2 gap-4 rounded-2xl border border-white/10 bg-gradient-to-br from-neutral-900/70 to-neutral-900/30 p-8 sm:grid-cols-4">
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
            {/* 2D作図 → 3D生成 → AIパースの実例（クライアント支給・260623・拡大機能なし＝ギャラリー以外は拡大無効） */}
            <div className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
              <img
                src="/lp/lp-step-2d-3d-ai.jpg"
                alt="2D作図から3D自動生成、AIパースまでの3ステップの実例"
                loading="lazy"
                className="w-full"
              />
            </div>
          </section>

          {/* AIデザイン編集（リード＝「ここを変えたい」…＋デモ枠・260619 クライアントデザイン） */}
          <section className="pb-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              <span className="inline-block">「空間の調和」はそのままに操る、</span>
              <br className="hidden sm:block" />
              <span className="inline-block">直感的なディテール調整</span>
            </h2>
            <p className="mb-10 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              <Jp
                parts={[
                  '「壁紙をこうしたい」',
                  '「床の色を変えたい」。',
                  '施主の思いつきをその場で形にし、',
                  '目の前で完成イメージを共有。',
                  '待ち時間をゼロにし、',
                  'ワクワクした気持ちのまま',
                  '意思決定へと導きます。',
                  '全体のバランスを崩すことなく、',
                  '素材や照明の一部だけを',
                  'ピンポイントで再生成。',
                  'あなたの頭の中にある',
                  '理想の完成形へと近づけます。',
                ]}
              />
            </p>
            {/* AIイメージ編集の実例（写真→AI生成・クライアント支給・260623・拡大機能なし） */}
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-neutral-900">
              <img
                src="/lp/lp-ai-edit.jpg"
                alt="AIイメージ編集：コンクリート空間をその場でカフェ内装に変換した例"
                loading="lazy"
                className="w-full"
              />
            </div>
          </section>

          {/* AIエージェント（リード＝「思考の死角」…＋デモ枠・260619 クライアントデザイン） */}
          <section className="pb-20">
            <h2 className="text-3xl font-black leading-snug sm:text-4xl lg:text-5xl">
              <span className="inline-block">あなたの「思考の死角」を照らす、</span>
              <br className="hidden sm:block" />
              <span className="inline-block">もう一人のデザインパートナー</span>
            </h2>
            <p className="mb-10 mt-5 max-w-3xl text-sm leading-relaxed text-neutral-400 sm:text-base">
              <Jp
                parts={[
                  '膨大な建材データと過去の文脈を',
                  '学習したAIが、',
                  'あなたの設計プロセスに伴走。',
                  '孤独なアイデアラッシュはもう不要です。',
                  '外部のAIツールも不要、',
                  'まるで優秀な右腕のように',
                  '最適なデザイン案の構築をサポートいたします。',
                ]}
              />
            </p>
            {/* AIエージェントの紹介（クライアント支給・260623・拡大機能なし） */}
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-neutral-900">
              <img
                src="/lp/lp-ai-agent.webp"
                alt="AIエージェント：和室を執務室に再提案している様子"
                loading="lazy"
                className="w-full"
              />
            </div>
          </section>

          {/* クロージング CTA */}
          <section className="pb-20">
            <div className="overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-sky-500/5 p-8 text-center sm:p-14">
              <h2 className="text-3xl font-black sm:text-5xl">
                <span className="inline-block">さあ、</span>
                <span className="inline-block bg-gradient-to-r from-emerald-400 to-sky-400 bg-clip-text text-transparent">
                  はじめよう
                </span>
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-[13px] leading-relaxed text-neutral-300">
                <Jp
                  parts={[
                    '現在 Arise は招待制です。',
                    'ご利用をご希望の方は',
                    '運営からの招待メールをご確認ください。',
                    '招待をお持ちの方は、',
                    'ログインからご利用を開始できます。',
                  ]}
                />
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
      <Lightbox image={lightboxImage} onClose={closeLightbox} scrollRef={scrollContainerRef} />
    </div>
  );
}
