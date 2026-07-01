import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, Loader2, MessageCircle, Paperclip, Send, X, Plus } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { ensureDataUrl } from '../lib/db/aiRenderStorage.js';
import { isReadableAttachment } from '../lib/agentAttachments.js';
import type { AgentChatMessage } from '../lib/gemini.js';
import type { AgentCatalogEntry, AgentRecommendation } from '../types.js';

/**
 * AIエージェント相談パネル（管理表 row 208/214・プランA）。
 * 折り畳み式の対話パネル。建築・内装デザインの助言を /api/agent（Gemini Flash）から得る。
 * 現在の生成画像を任意で文脈として添付する。
 *
 * 260619 クライアント要望:
 *  - 開閉ボタンは「エリア編集」の横（AiEditWorkspace のタブ列）へ移動 → 本コンポーネントは controlled（open/onOpenChange）。
 *  - 返答文をコピーできる（各回答にコピー操作）。
 *  - 会話履歴をナビゲーション/リロードを跨いで残す（プロジェクト単位で localStorage に保存。ベストエフォート）。
 */

const CHAT_STORAGE_PREFIX = 'arise-agent-chat-';
const MAX_STORED = 50;

/**
 * 初期状態の記入欄に薄いグレーで表示する相談例（260702 クライアント要望）。
 * コーディネートの記入欄と同じく、例文はプレースホルダとして枠内にグレー表示する。
 */
const AGENT_PLACEHOLDER =
  '例1）このブランドに合うデザインを提案して\n' +
  '（HPに掲載されている企業理念や現在の展開されている店舗画像、今回の提案要件を記入してください）\n' +
  '例2）この空間に合う家具を提案して\n' +
  '例3）最近のトレンドカラーを教えて';

/** チャット表示用メッセージ。アシスタント発話には家具推薦（Tier2）が付くことがある。 */
type ChatMessage = AgentChatMessage & { recommendations?: AgentRecommendation[] };

/** エージェント相談に添付するファイル（画像・PDF・資料・音声・動画・コード等・複数対応 260702）。 */
type AttachedFile = { id: string; name: string; mimeType: string; dataUrl: string; size: number };

// 受理する拡張子（.ph は .php も許容・.jpg も補完）。
// Office バイナリ(.doc/.docx/.xls/.xlsx/.pptx)は Gemini が直接読めないためピッカーから除外（クライアント要望・260702）。
const ACCEPT_EXTS =
  '.pdf,.txt,.rtf,.csv,.tsv,.c,.java,.py,.js,.html,.css,.ph,.php,.jpeg,.jpg,.png,.webp,.bmp,.heic,.heif,.wav,.mp3,.aiff,.aac,.ogg,.flac,.mp4,.mpeg,.mov,.avi,.webm,.3gpp';

// 添付合計サイズ上限（生バイト）。Vercel の関数ボディ上限(~4.5MB)を超えると送信自体が失敗するため控えめに。
const MAX_TOTAL_RAW = 3 * 1024 * 1024;

const IMAGE_NAME_RE = /\.(jpe?g|png|webp|bmp|hei[cf])$/i;
function isImageFile(f: { mimeType?: string; name?: string }): boolean {
  return (f.mimeType || '').startsWith('image/') || IMAGE_NAME_RE.test(f.name || '');
}

function chatKey(projectId: string | null | undefined): string {
  return CHAT_STORAGE_PREFIX + (projectId || 'guest');
}

function loadStoredChat(projectId: string | null | undefined): ChatMessage[] {
  try {
    const raw = localStorage.getItem(chatKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMessage =>
          !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        recommendations: Array.isArray(m.recommendations) ? m.recommendations : undefined,
      }));
  } catch {
    return [];
  }
}

export function AgentChatPanel({
  imageDataUrl,
  projectId,
  open,
  onOpenChange,
  catalog,
  onAddEstimateItem,
  inline = false,
}: {
  imageDataUrl?: string | null;
  projectId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** エージェントへ渡す家具カタログ（推薦候補・Tier2 260620）。 */
  catalog?: AgentCatalogEntry[];
  /** 推薦を見積もりへ追加する（Tier2）。未指定なら「見積に追加」ボタンを出さない。 */
  onAddEstimateItem?: (rec: AgentRecommendation) => void;
  /** 右レール内にタブとしてインライン表示する（260624）。false=従来のフローティング。 */
  inline?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadStoredChat(projectId));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // 「見積に追加」済みの推薦キー（メッセージ番号-推薦番号）。二重追加を視覚的に抑止。
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  // 参考ファイルの添付（260702: 画像・PDF・資料・音声・動画・コード等を複数、文脈に渡す）。
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  // 読み込み中の件数（FileReader は非同期のため、選択直後に「読み込み中…」を出して即時フィードバックする・260702）。
  const [readingCount, setReadingCount] = useState(0);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // プロジェクト切替直後、まだ古い messages のまま保存 effect が走るのを防ぐ。
  const skipSave = useRef(false);

  // プロジェクトが変わったら該当履歴を読み込み直す。
  useEffect(() => {
    skipSave.current = true;
    setMessages(loadStoredChat(projectId));
    setAddedKeys(new Set());
  }, [projectId]);

  // 履歴を localStorage へ保存（メッセージ毎に即保存＝チャット直後のリロードでも残る）。
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    try {
      const key = chatKey(projectId);
      if (messages.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(messages.slice(-MAX_STORED)));
    } catch {
      /* 容量超過等は無視（履歴保存はベストエフォート） */
    }
  }, [messages, projectId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open, sending]);

  const send = async () => {
    const text = input.trim();
    if ((!text && attachedFiles.length === 0) || sending) return;
    // テキスト未入力でも添付だけで送れるよう既定プロンプトを補う。
    const content = text || '添付したファイルを確認してアドバイスをください。';
    const filesToSend = attachedFiles; // 複数の添付を文脈として渡す（画像/PDF/資料/音声/動画/コード）。
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setAttachedFiles([]);
    setError(null);
    setSending(true);
    try {
      // 履歴がURL（クラウド保存）の場合に備え、サーバへ渡す前に base64 データURL化（画像グラウンディング維持・260619）。
      const grounding = imageDataUrl ? await ensureDataUrl(imageDataUrl) : null;
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          messages: next.slice(-12).map((m) => ({ role: m.role, content: m.content })),
          imageDataUrl: grounding,
          catalog,
          files: filesToSend.map((f) => ({ name: f.name, dataUrl: f.dataUrl })),
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '応答の取得に失敗しました');
      // トークン計測（row 58・無効時は no-op）。エージェントはテキスト（グラウンディング画像＋添付画像を計上）。
      const imageCount = (grounding ? 1 : 0) + filesToSend.filter(isImageFile).length;
      void recordAiUsage({ feature: 'agent', usage: data.usage, model: data.model, imageCount });
      // Tier2: 推薦はサーバ側でカタログ実データへ解決済み（index ずれ・捏造防止）。型のみ軽く検証。
      const recs: AgentRecommendation[] = Array.isArray(data.recommendations)
        ? (data.recommendations as unknown[]).filter(
            (r): r is AgentRecommendation =>
              !!r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string',
          )
        : [];
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: String(data.reply ?? ''), recommendations: recs.length ? recs : undefined },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'エラー');
    } finally {
      setSending(false);
    }
  };

  const copyMessage = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      window.setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      /* clipboard 利用不可の環境は無視 */
    }
  };

  const clearHistory = () => {
    setMessages([]);
    setError(null);
  };

  const onPickAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    e.target.value = '';
    if (!list || list.length === 0) return;
    let running = attachedFiles.reduce((s, f) => s + f.size, 0);
    const accepted: File[] = [];
    const unreadable: string[] = [];
    let overflow = false;
    for (const file of Array.from(list)) {
      // AIが本体を直接読み取れない形式(.doc/.docx/.xls/.xlsx/.pptx 等)は添付一覧に載せず除外（260702）。
      if (!isReadableAttachment(file.name, file.type)) {
        unreadable.push(file.name);
        continue;
      }
      if (running + file.size > MAX_TOTAL_RAW) {
        overflow = true;
        continue;
      }
      running += file.size;
      accepted.push(file);
    }
    const notes: string[] = [];
    if (unreadable.length) {
      notes.push(
        `AIが直接読み取れない形式のため除外しました（${unreadable.join('、')}）。.doc/.docx/.xls/.xlsx/.pptx などは PDF かテキストに変換してから添付してください。`,
      );
    }
    if (overflow) {
      notes.push(`添付は合計 ${Math.round(MAX_TOTAL_RAW / 1024 / 1024)}MB までです。大きな動画・音声・資料は圧縮または分割してください。`);
    }
    if (notes.length) setError(notes.join(' '));
    if (accepted.length) setReadingCount((c) => c + accepted.length); // 即時に「読み込み中…」を表示
    accepted.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        setAttachedFiles((prev) => [
          ...prev,
          { id: `f${idRef.current++}`, name: file.name, mimeType: file.type || '', dataUrl: reader.result as string, size: file.size },
        ]);
      };
      // onload/エラーいずれでも必ず減算し、読み込み中表示が残らないようにする。
      reader.onloadend = () => setReadingCount((c) => Math.max(0, c - 1));
      reader.readAsDataURL(file);
    });
  };

  const removeFile = (id: string) => setAttachedFiles((prev) => prev.filter((f) => f.id !== id));

  // 初期状態フォームと会話中フッターで共有する部品（複数添付・260702）。※同時に描画されるのは片方のみ。
  const hiddenFileInput = (
    <input ref={attachInputRef} type="file" accept={ACCEPT_EXTS} multiple className="hidden" onChange={onPickAttach} />
  );
  // 送信前の添付インジケータ（クライアント要望・260702）: 添付したことがはっきり分かるよう、
  // 件数ラベル付きの目立つパネルで表示する。選択直後は「読み込み中…」を即時表示する。
  const attachmentsPanel =
    attachedFiles.length > 0 || readingCount > 0 ? (
      <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/[0.08] p-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-emerald-200">
          <Paperclip className="h-3.5 w-3.5" />
          添付ファイル{attachedFiles.length > 0 ? `（${attachedFiles.length}件）` : ''}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {attachedFiles.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 py-1 pl-1 pr-1.5"
            >
              {isImageFile(f) ? (
                <img src={f.dataUrl} alt={f.name} className="h-7 w-7 shrink-0 rounded object-cover" />
              ) : (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white/10 text-neutral-300">
                  <FileText className="h-4 w-4" />
                </span>
              )}
              <span className="max-w-[7rem] truncate text-[10px] text-neutral-200" title={f.name}>
                {f.name}
              </span>
              <button
                type="button"
                onClick={() => removeFile(f.id)}
                aria-label={`${f.name} を外す`}
                className="shrink-0 rounded p-0.5 text-neutral-400 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {readingCount > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[10px] text-neutral-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              読み込み中…
            </div>
          )}
        </div>
      </div>
    ) : null;

  // 記入欄は初期状態でもチャット開始後でも同じ大きさ・同じ形式で下部に置く（縮ませない・260702 クライアント要望）。
  // 大きな記入欄なので Enter=改行、送信は「送信」ボタンまたは Ctrl/⌘+Enter。
  const renderComposer = (variant: 'initial' | 'chat') => {
    const isInitial = variant === 'initial';
    return (
      <div className="flex flex-col gap-2">
        {isInitial && (
          <p id="agent-empty-label" className="text-[12px] font-bold text-neutral-200">
            ここにお困りごとを記入してください。
          </p>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
          aria-labelledby={isInitial ? 'agent-empty-label' : undefined}
          aria-label={isInitial ? undefined : 'メッセージを記入'}
          rows={isInitial ? 6 : 5}
          placeholder={isInitial ? AGENT_PLACEHOLDER : '続けて質問する…（Ctrl+Enter で送信）'}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[12px] leading-relaxed text-white outline-none focus:border-emerald-500"
        />
        {attachmentsPanel}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => attachInputRef.current?.click()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-[11px] font-bold text-neutral-200 transition hover:bg-white/10 hover:text-white"
          >
            <Paperclip className="h-4 w-4" />
            ファイルを添付
          </button>
        </div>
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || (!input.trim() && attachedFiles.length === 0)}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2.5 text-[12px] font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          送信
        </button>
        {error && <p className="text-[11px] text-red-300">{error}</p>}
        {hiddenFileInput}
      </div>
    );
  };

  if (!open) return null; // 開閉トリガは「エリア編集」横のタブ（AiEditWorkspace）へ移動

  return (
    <div
      className={
        inline
          ? 'flex h-full min-h-0 w-full flex-col rounded-2xl border border-white/15 bg-neutral-900/60'
          : 'fixed bottom-6 right-6 z-[10005] flex h-[28rem] w-[22rem] max-w-[92vw] flex-col rounded-2xl border border-white/15 bg-neutral-900/95 shadow-2xl backdrop-blur'
      }
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-bold">AIエージェント</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              className="rounded px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-white/10 hover:text-white"
              title="この会話履歴を消去"
            >
              履歴を消去
            </button>
          )}
          {/* インライン（タブ）表示では閉じる「×」は不要（タブで切替える・260624）。フローティング時のみ表示。 */}
          {!inline && (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="閉じる"
              className="focus-ring rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {messages.length === 0 ? (
        /* 初期状態: コーディネートの記入欄と同じ形式（大きな記入欄＋枠内グレーの例文＋入力欄の近くにラベル）・260702 */
        <div className="scroll-dark flex min-h-0 flex-1 flex-col overflow-y-auto p-3">{renderComposer('initial')}</div>
      ) : (
        <>
        <div ref={scrollRef} className="scroll-dark flex-1 space-y-2 overflow-y-auto p-3 text-[12px]">
          {messages.map((m, i) => (
            <div key={`${m.role}-${i}`} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[85%] cursor-text select-text whitespace-pre-wrap break-words rounded-xl px-3 py-2 ${
                  m.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-white/10 text-neutral-100'
                }`}
                style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
              >
                {m.content}
              </div>
              {m.role === 'assistant' && m.content ? (
                <button
                  type="button"
                  onClick={() => void copyMessage(m.content, i)}
                  className="tap mt-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-neutral-400 transition hover:bg-white/10 hover:text-white"
                  title="この回答をコピー"
                >
                  {copiedIdx === i ? (
                    <>
                      <Check className="h-3 w-3" /> コピーしました
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" /> コピー
                    </>
                  )}
                </button>
              ) : null}
              {m.role === 'assistant' && m.recommendations && m.recommendations.length > 0 && (
                <div className="mt-1.5 w-[88%] space-y-1.5">
                  {m.recommendations.map((rec, ri) => {
                    const key = `${i}-${ri}`;
                    const added = addedKeys.has(key);
                    const meta = [
                      rec.brand,
                      rec.modelNumber ? `品番 ${rec.modelNumber}` : '',
                      rec.price !== undefined ? `¥${rec.price.toLocaleString()}` : '',
                    ]
                      .filter(Boolean)
                      .join(' ・ ');
                    return (
                      <div key={key} className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-bold text-neutral-100">{rec.name}</div>
                            {meta && <div className="mt-0.5 text-[10px] text-neutral-400">{meta}</div>}
                            {rec.reason && (
                              <div className="mt-0.5 text-[10px] leading-relaxed text-neutral-500">{rec.reason}</div>
                            )}
                            {rec.productUrl && /^https?:\/\//i.test(rec.productUrl) && (
                              <a
                                href={rec.productUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-0.5 inline-block text-[10px] text-emerald-300 hover:underline"
                              >
                                商品ページ ↗
                              </a>
                            )}
                          </div>
                          {onAddEstimateItem && (
                            <button
                              type="button"
                              disabled={added}
                              onClick={() => {
                                onAddEstimateItem(rec);
                                setAddedKeys((s) => new Set(s).add(key));
                              }}
                              className="tap inline-flex shrink-0 items-center gap-0.5 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                              title="この商品を概算見積もりへ追加"
                            >
                              {added ? (
                                <>
                                  <Check className="h-3 w-3" /> 追加済み
                                </>
                              ) : (
                                <>
                                  <Plus className="h-3 w-3" /> 見積に追加
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-xl bg-white/10 px-3 py-2 text-neutral-300">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            </div>
          )}
        </div>

        {/* チャット開始後も記入欄は縮ませず、初期状態と同じ大きさ・形式で下部に置く（260702）。 */}
        <div className="border-t border-white/10 p-2.5">{renderComposer('chat')}</div>
        </>
      )}
    </div>
  );
}
