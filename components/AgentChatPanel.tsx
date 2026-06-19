import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, MessageCircle, Send, X } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { ensureDataUrl } from '../lib/db/aiRenderStorage.js';
import type { AgentChatMessage } from '../lib/gemini.js';

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

function chatKey(projectId: string | null | undefined): string {
  return CHAT_STORAGE_PREFIX + (projectId || 'guest');
}

function loadStoredChat(projectId: string | null | undefined): AgentChatMessage[] {
  try {
    const raw = localStorage.getItem(chatKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is AgentChatMessage =>
        !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
    );
  } catch {
    return [];
  }
}

export function AgentChatPanel({
  imageDataUrl,
  projectId,
  open,
  onOpenChange,
}: {
  imageDataUrl?: string | null;
  projectId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [messages, setMessages] = useState<AgentChatMessage[]>(() => loadStoredChat(projectId));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // プロジェクト切替直後、まだ古い messages のまま保存 effect が走るのを防ぐ。
  const skipSave = useRef(false);

  // プロジェクトが変わったら該当履歴を読み込み直す。
  useEffect(() => {
    skipSave.current = true;
    setMessages(loadStoredChat(projectId));
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
    const next: AgentChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setError(null);
    setSending(true);
    try {
      // 履歴がURL（クラウド保存）の場合に備え、サーバへ渡す前に base64 データURL化（画像グラウンディング維持・260619）。
      const grounding = imageDataUrl ? await ensureDataUrl(imageDataUrl) : null;
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({ messages: next.slice(-12), imageDataUrl: grounding }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '応答の取得に失敗しました');
      // トークン計測（row 58・無効時は no-op）。エージェントはテキスト（添付画像があれば 1）。
      void recordAiUsage({ feature: 'agent', usage: data.usage, model: data.model, imageCount: imageDataUrl ? 1 : 0 });
      setMessages((prev) => [...prev, { role: 'assistant', content: String(data.reply ?? '') }]);
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
          <p className="leading-relaxed text-neutral-500">
            空間デザインの相談ができます。例:「この部屋を北欧風にするには？」「ソファの色は何が合う？」「巾木の色のおすすめは？」
          </p>
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
        <div className="flex items-end gap-2">
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
            placeholder="相談を入力（Enterで送信）"
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
