import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, MessageCircle, Send, X, Plus, ImagePlus } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { ensureDataUrl } from '../lib/db/aiRenderStorage.js';
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

/** 空状態に出す相談例（クリックで入力欄へ流し込む・260624 クライアント要望のUIに合わせる）。 */
const AGENT_EXAMPLES: { label: string; fill: string; hint?: string }[] = [
  {
    label: 'このブランドに合うデザインを提案して',
    fill: 'このブランドに合うデザインを提案して。',
    hint: '（HPに掲載されている企業理念や現在の展開されている店舗画像、今回の提案要件を記入してください）',
  },
  { label: 'この空間に合う家具を提案して', fill: 'この空間に合う家具を提案して。' },
  { label: '最近のトレンドカラーを教えて', fill: '最近のトレンドカラーを教えて。' },
];

/** チャット表示用メッセージ。アシスタント発話には家具推薦（Tier2）が付くことがある。 */
type ChatMessage = AgentChatMessage & { recommendations?: AgentRecommendation[] };

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
}: {
  imageDataUrl?: string | null;
  projectId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** エージェントへ渡す家具カタログ（推薦候補・Tier2 260620）。 */
  catalog?: AgentCatalogEntry[];
  /** 推薦を見積もりへ追加する（Tier2）。未指定なら「見積に追加」ボタンを出さない。 */
  onAddEstimateItem?: (rec: AgentRecommendation) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadStoredChat(projectId));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // 「見積に追加」済みの推薦キー（メッセージ番号-推薦番号）。二重追加を視覚的に抑止。
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  // 参考画像の添付（260624: 入力欄左の画像アイコンから添付。ブランドの店舗写真などを文脈に渡す）。
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
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
    if (!text || sending) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    const imgToSend = attachedImage; // 添付があれば優先して文脈に渡す（無ければ現在の生成画像）。
    setAttachedImage(null);
    setError(null);
    setSending(true);
    try {
      // 履歴がURL（クラウド保存）の場合に備え、サーバへ渡す前に base64 データURL化（画像グラウンディング維持・260619）。
      const groundingSource = imgToSend ?? imageDataUrl;
      const grounding = groundingSource ? await ensureDataUrl(groundingSource) : null;
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          messages: next.slice(-12).map((m) => ({ role: m.role, content: m.content })),
          imageDataUrl: grounding,
          catalog,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '応答の取得に失敗しました');
      // トークン計測（row 58・無効時は no-op）。エージェントはテキスト（添付画像があれば 1）。
      void recordAiUsage({ feature: 'agent', usage: data.usage, model: data.model, imageCount: imageDataUrl ? 1 : 0 });
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
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAttachedImage(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  };

  if (!open) return null; // 開閉トリガは「エリア編集」横のタブ（AiEditWorkspace）へ移動

  return (
    <div className="fixed bottom-6 right-6 z-[10005] flex h-[28rem] w-[22rem] max-w-[92vw] flex-col rounded-2xl border border-white/15 bg-neutral-900/95 shadow-2xl backdrop-blur">
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
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="閉じる"
            className="focus-ring rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="scroll-dark flex-1 space-y-2 overflow-y-auto p-3 text-[12px]">
        {messages.length === 0 ? (
          <div className="space-y-2.5">
            <p className="font-bold text-neutral-200">ここにお困りごとを記入してください。</p>
            <div className="space-y-1.5">
              {AGENT_EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setInput(ex.fill)}
                  className="block w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-left transition hover:border-emerald-500/40 hover:bg-emerald-500/[0.06]"
                  title="クリックで入力欄へ"
                >
                  <span className="text-[12px] text-neutral-200">
                    例{i + 1}）{ex.label}
                  </span>
                  {ex.hint && (
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-neutral-500">{ex.hint}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={`${m.role}-${i}`} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 ${
                  m.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-white/10 text-neutral-100'
                }`}
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
          ))
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-white/10 px-3 py-2 text-neutral-300">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          </div>
        )}
        {error && <p className="text-[11px] text-red-300">{error}</p>}
      </div>

      <div className="border-t border-white/10 p-2.5">
        {attachedImage && (
          <div className="mb-2 flex items-center gap-2">
            <img src={attachedImage} alt="添付画像" className="h-10 w-10 rounded object-cover" />
            <span className="text-[10px] text-neutral-400">参考画像を添付中</span>
            <button
              type="button"
              onClick={() => setAttachedImage(null)}
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-neutral-400 transition hover:bg-white/10 hover:text-white"
            >
              外す
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => attachInputRef.current?.click()}
            title="参考画像を添付（店舗写真など）"
            aria-label="参考画像を添付"
            className="shrink-0 rounded-lg border border-white/10 bg-black/40 p-2 text-neutral-300 transition hover:bg-white/10 hover:text-white"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <input
            ref={attachInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickAttach}
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="例：最近のトレンドカラーを教えて"
            className="max-h-24 flex-1 resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[12px] text-white outline-none focus:border-emerald-500"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            aria-label="送信"
            className="rounded-lg bg-emerald-600 p-2 text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
