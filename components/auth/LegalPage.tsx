import { ArrowLeft } from 'lucide-react';

/**
 * 利用規約 / プライバシーポリシー 表示ページ（管理表 row 43）。
 * 未ログイン画面（ランディング・ログイン）からリンクで遷移する。
 *
 * ⚠️ 本文は雛形（ドラフト）です。公開前に必ず確定版の法務テキストへ差し替えてください。
 * 同意チェックUIは新規登録フォーム側で対応する（登録画面は他機能完了後に実装・row 38）。
 */
export type LegalKind = 'terms' | 'privacy';

const TERMS: { heading: string; body: string }[] = [
  { heading: '第1条（適用）', body: '本規約は、本サービスの提供条件および当社とユーザーとの間の権利義務関係を定めるものであり、ユーザーと当社との間の本サービスの利用に関わる一切の関係に適用されます。' },
  { heading: '第2条（利用登録）', body: '本サービスは招待制です。当社所定の方法により利用登録を申請し、当社が承認することで利用登録が完了します。当社は一定の場合に登録を承認しないことがあります。' },
  { heading: '第3条（アカウント管理）', body: 'ユーザーは自己の責任においてアカウント情報を管理するものとします。第三者による利用や漏えいについて当社は責任を負いません。' },
  { heading: '第4条（料金・プラン）', body: 'プラン内容・料金・生成枚数等の制限は別途定めるところによります。フリープランの出力には透かしや解像度制限が適用される場合があります。' },
  { heading: '第5条（禁止事項）', body: '法令・公序良俗に反する行為、第三者の権利侵害、不正アクセス、本サービスの運営を妨げる行為等を禁止します。' },
  { heading: '第6条（生成物の取扱い）', body: 'AIによる生成物の利用範囲・権利関係はプランおよび関連規定に従います。生成結果の正確性・適法性を保証するものではありません。' },
  { heading: '第7条（提供の停止等）', body: '保守、障害、その他やむを得ない事由により、事前の通知なく本サービスの全部または一部の提供を停止することがあります。' },
  { heading: '第8条（免責事項）', body: '当社は、本サービスに事実上または法律上の瑕疵がないことを明示的にも黙示的にも保証しません。当社の責任は、当社の故意または重過失による場合を除き制限されます。' },
  { heading: '第9条（規約の変更）', body: '当社は必要と判断した場合、本規約を変更できるものとします。変更後の規約は本サービス上に表示した時点から効力を生じます。' },
  { heading: '第10条（準拠法・裁判管轄）', body: '本規約の解釈には日本法を準拠法とし、本サービスに関して紛争が生じた場合には当社所在地を管轄する裁判所を専属的合意管轄とします。' },
];

const PRIVACY: { heading: string; body: string }[] = [
  { heading: '第1条（事業者情報）', body: '本ポリシーは、本サービスの提供にあたり当社が取得・利用する個人情報の取扱いを定めるものです。' },
  { heading: '第2条（取得する情報）', body: '氏名・ニックネーム・メールアドレス・電話番号・属性（プロ/学生/一般）・学校情報、ならびにログイン時の端末情報（ブラウザ種別・画面解像度等）およびIPアドレス、サービス利用ログ等を取得します。' },
  { heading: '第3条（利用目的）', body: '本サービスの提供・本人確認・不正利用防止・品質改善・お問い合わせ対応・重要なお知らせの送付のために利用します。' },
  { heading: '第4条（AI学習・評価ログ）', body: '生成結果への評価（good/bad）や操作ログを、サービス品質向上およびAIの精度改善（インコンテキスト学習等）に利用する場合があります。' },
  { heading: '第5条（第三者提供）', body: '法令に基づく場合等を除き、ご本人の同意なく個人情報を第三者に提供しません。AI生成等のため必要な範囲で外部サービスに委託する場合があります。' },
  { heading: '第6条（データの保管・削除）', body: 'プランに応じた保管期間の経過後、データを自動削除する場合があります（猶予期間内は復元可能）。' },
  { heading: '第7条（開示・訂正・削除等）', body: 'ご本人からの保有個人データの開示・訂正・利用停止・削除のご請求に、法令に従い対応します。' },
  { heading: '第8条（お問い合わせ）', body: '本ポリシーに関するお問い合わせは、当社所定の窓口までご連絡ください。' },
  { heading: '第9条（改定）', body: '本ポリシーの内容は、必要に応じて変更されることがあります。変更後は本サービス上に表示した時点から効力を生じます。' },
];

export function LegalPage({ kind, onBack }: { kind: LegalKind; onBack: () => void }) {
  const isTerms = kind === 'terms';
  const title = isTerms ? '利用規約' : 'プライバシーポリシー';
  const sections = isTerms ? TERMS : PRIVACY;

  return (
    <div className="h-screen w-screen overflow-y-auto bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-neutral-950/80 px-6 py-4 backdrop-blur sm:px-10">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm font-semibold text-neutral-200 transition hover:border-white/30 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          戻る
        </button>
        <h1 className="text-lg font-bold">{title}</h1>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10 sm:px-10">
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[12px] leading-relaxed text-amber-200">
          ※ この本文は<strong>雛形（ドラフト）</strong>です。公開前に、必ず貴社の確定版の法務テキストへ差し替えてください。
        </div>
        <p className="mb-8 text-[12px] text-neutral-500">最終更新日: 準備中</p>
        <div className="space-y-6">
          {sections.map((s) => (
            <section key={s.heading}>
              <h2 className="mb-1.5 text-sm font-bold text-neutral-100">{s.heading}</h2>
              <p className="text-[13px] leading-relaxed text-neutral-400">{s.body}</p>
            </section>
          ))}
        </div>
      </main>

      <footer className="border-t border-white/10 px-6 py-8 text-center text-[11px] text-neutral-600 sm:px-10">
        © Arise — 建築・内装向け AI 空間デザイン
      </footer>
    </div>
  );
}
