import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircle, Send, X } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import type { AgentChatMessage } from '../lib/gemini.js';

/**
 * AIエージェント相談パネル（管理表 row 208/214・プランA）。
 * 折り畳み式の対話パネル。建築・内装デザインの助言を /api/agent（Gemini Flash）から得る。
 * 現在の生成画像を任意で文脈として添付する。作業領域を圧迫しないよう既定は折りたたみ。
 */
export function AgentChatPanel({ imageDataUrl }: { imageDataUrl?: string | null }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({ messages: next.slice(-12), imageDataUrl: imageDataUrl ?? null }),
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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="AIエージェントに相談"
        className="fixed bottom-6 right-6 z-[10005] inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-2xl transition hover:bg-emerald-500"
      >
        <MessageCircle className="h-4 w-4" />
        エージェントに相談
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-[10005] flex h-[28rem] w-[22rem] max-w-[92vw] flex-col rounded-2xl border border-white/15 bg-neutral-900/95 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-bold">AIエージェント</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="閉じる"
          className="rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3 text-[12px]">
        {messages.length === 0 ? (
          <p className="leading-relaxed text-neutral-500">
            空間デザインの相談ができます。例:「この部屋を北欧風にするには？」「ソファの色は何が合う？」「巾木の色のおすすめは？」
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={`${m.role}-${i}`} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 ${
                  m.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-white/10 text-neutral-100'
                }`}
              >
                {m.content}
              </div>
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
