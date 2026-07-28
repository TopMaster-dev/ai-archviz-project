import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, Loader2, MessageCircle, Paperclip, Search, Send, X, Plus } from 'lucide-react';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { ensureDataUrl } from '../lib/db/aiRenderStorage.js';
import { isReadableAttachment } from '../lib/agentAttachments.js';
import { isOutOfStock } from '../lib/productExtract.js';
import { renderSanitizedHtml } from '../utils/sanitizeSearchSuggestion.js';
import { ImageRegionPicker } from './ImageRegionPicker.js';
import { ChatRichText } from './ChatRichText.js';
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
  '【※対話専用チャットです。ここから画像の生成は実行されません】\n' +
  '\n' +
  '例1）添付した企業理念から、オフィスのコンセプト案を3つ出して\n' +
  '例2）最近のトレンドを取り入れた、美容室のアクセントカラーを教えて\n' +
  '例3）この間取りで、より広く見せるための照明の配置アイデアは？';

/** チャット表示用メッセージ。アシスタント発話には家具推薦（Tier2）、ユーザー発話には送信した添付ファイル名が付く。 */
type ChatMessage = AgentChatMessage & { recommendations?: AgentRecommendation[]; attachmentNames?: string[] };

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
        attachmentNames: Array.isArray(m.attachmentNames)
          ? (m.attachmentNames as unknown[]).filter((n): n is string => typeof n === 'string')
          : undefined,
      }));
  } catch {
    return [];
  }
}

/** 画像から商品を特定する機能（Cloud Vision・②）を表示するか（env フラグ・260725）。 */
const VISION_PRODUCT_SEARCH_ENABLED =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ENABLE_VISION_PRODUCT_SEARCH ?? '') ===
  'true';

export function AgentChatPanel({
  imageDataUrl,
  projectId,
  open,
  onOpenChange,
  catalog,
  projectSummary,
  onAddEstimateItem,
  inline = false,
}: {
  imageDataUrl?: string | null;
  projectId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** エージェントへ渡す家具カタログ（推薦候補・Tier2 260620）。 */
  catalog?: AgentCatalogEntry[];
  /** ユーザーの現在のプロジェクト情報（部屋の寸法・家具・建材・予算の要約・260725 ①）。 */
  projectSummary?: string | null;
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
  // 「画像から商品を特定して探す」モード（②・Cloud Vision・260725）。ON のとき送信は Vision 経路へ。
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

  /**
   * /api/agent への送信を1本化する（260728 敵対レビュー C3）。
   *
   * ページ取得が挟まったことで応答が遅くなり、Vercel の関数上限(60秒)に当たると
   * JSON ではないゲートウェイ応答が返る。従来は無条件に res.json() していたため、
   * 利用者には「Unexpected token 'A' ... is not valid JSON」という無意味な文言が出ていた。
   * クライアント側でも打ち切り、非JSONは日本語のメッセージに変換する。
   */
  const postAgent = async (payload: Record<string, unknown>): Promise<any> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 55_000); // 関数上限より少し手前
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // 502/504 等はHTMLやプレーンテキストで返るため、そのまま res.json() すると
      // 「Unexpected token 'A' ...」という利用者に意味のない例外になる。
      // content-type が分かる場合は事前に弾き、分からない場合は解析失敗を捕まえて日本語にする。
      const ct = res.headers?.get?.('content-type') ?? '';
      const gatewayMessage =
        res.status >= 500
          ? '応答に時間がかかりすぎたため中断しました。条件を絞って再度お試しください。'
          : '通信に失敗しました。時間をおいて再度お試しください。';
      if (ct && !ct.includes('application/json')) throw new Error(gatewayMessage);
      try {
        return await res.json();
      } catch {
        throw new Error(gatewayMessage);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error('応答に時間がかかりすぎたため中断しました。条件を絞って再度お試しください。');
      }
      throw e;
    } finally {
      window.clearTimeout(timer);
    }
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && attachedFiles.length === 0) || sending) return;
    // テキスト未入力でも添付だけで送れるよう既定プロンプトを補う。
    const content = text || '添付したファイルを確認してアドバイスをください。';
    const filesToSend = attachedFiles; // 複数の添付を文脈として渡す（画像/PDF/資料/音声/動画/コード）。
    // 送信した添付のファイル名を会話履歴（吹き出し）に残す（クライアント要望・260702）。ファイル本体は保存しない。
    const sentNames = filesToSend.map((f) => f.name);
    const next: ChatMessage[] = [
      ...messages,
      { role: 'user', content, attachmentNames: sentNames.length ? sentNames : undefined },
    ];
    setMessages(next);
    setInput('');
    setAttachedFiles([]);
    setError(null);
    setSending(true);
    try {
      // 履歴がURL（クラウド保存）の場合に備え、サーバへ渡す前に base64 データURL化（画像グラウンディング維持・260619）。
      const grounding = imageDataUrl ? await ensureDataUrl(imageDataUrl) : null;
      // 商品を解決して assistant 吹き出しへ反映する共通処理（通常/Vision 経路で共有）。
      const appendAssistant = (data: { reply?: unknown; recommendations?: unknown }) => {
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
      };

      // 画像からの商品特定は「画像から商品を特定」ボタン専用の経路へ移した（260728 要望①）。
      // 送信時に入力文から自動で経路を切り替える判定は廃止（意図と噛み合わないため）。
      const data = await postAgent({
        messages: next.slice(-12).map((m) => ({ role: m.role, content: m.content })),
        imageDataUrl: grounding,
        catalog,
        projectContext: projectSummary || undefined,
        files: filesToSend.map((f) => ({ name: f.name, dataUrl: f.dataUrl })),
      });
      if (!data.success) throw new Error(data.error || '応答の取得に失敗しました');
      // トークン計測（row 58・無効時は no-op）。エージェントはテキスト（グラウンディング画像＋添付画像を計上）。
      const imageCount = (grounding ? 1 : 0) + filesToSend.filter(isImageFile).length;
      void recordAiUsage({ feature: 'agent', usage: data.usage, model: data.model, imageCount });
      // Tier2: 推薦はサーバ側でカタログ実データへ解決済み（index ずれ・捏造防止）。型のみ軽く検証。
      appendAssistant(data);
      // Google 検索グラウンディングの利用規約は、返却された「検索候補」の表示を求めている（260728 対応）。
      // 応答に含まれるときだけ最新のものを保持して表示する。
      setSearchSuggestionHtml(typeof data.searchSuggestionHtml === 'string' ? data.searchSuggestionHtml : null);
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

  /**
   * 添付ファイルを追加する（クリック選択・ドラッグ&ドロップ共通・260728 クライアント要望）。
   * 読み取り可能形式の判定・合計サイズ上限・エラー文言をここに集約し、
   * 選択とドロップで挙動が食い違わないようにする。
   */
  const addAttachments = (picked: File[]) => {
    if (picked.length === 0) return;
    let running = attachedFiles.reduce((s, f) => s + f.size, 0);
    const accepted: File[] = [];
    const unreadable: string[] = [];
    let overflow = false;
    for (const file of picked) {
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
      reader.onerror = () => setError(`「${file.name}」の読み込みに失敗しました。もう一度お試しください。`);
      // onload/エラーいずれでも必ず減算し、読み込み中表示が残らないようにする。
      reader.onloadend = () => setReadingCount((c) => Math.max(0, c - 1));
      reader.readAsDataURL(file);
    });
  };

  const onPickAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    // 重要（260702 バグ修正）: input.value をリセットする前に FileList を配列へコピーする。
    // 先に value='' すると、参照していた FileList が空になり（ブラウザ挙動）、添付が一切効かなくなる
    // ＝「アップロードしても何も起きない」原因。必ず先にコピーしてからリセットする。
    const picked = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    addAttachments(picked);
  };

  // ドラッグ&ドロップ添付（260728 クライアント要望：エリア編集だけ効いていたD&Dを揃える）。
  // パネル全体で受けると会話を読みながらでもドロップでき、操作の迷いが減る。
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0); // 子要素をまたぐと dragleave が連発するため深さで管理する
  const handleDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return; // テキスト選択のドラッグ等は無視
    e.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
    e.preventDefault(); // これが無いとブラウザがファイルを開いてしまう
  };
  const handleDragLeave = () => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDropActive(false);
    addAttachments(files);
  };

  /**
   * 「画像から商品を特定」の専用フロー（260728 クライアント要望①）。
   * 対象画像は「添付した画像」を優先し、無ければ現在表示中の生成画像。どちらも無ければ案内だけ出す
   * （従来は自動判定で黙って通常チャットに落ちており、なぜ効かないのか分からなかった）。
   */
  const [regionPickerSrc, setRegionPickerSrc] = useState<string | null>(null);
  const [visionNotice, setVisionNotice] = useState<string | null>(null);
  // Google 検索グラウンディングが返す検索候補の表示用HTML（規約上の表示義務・260728）。
  const [searchSuggestionHtml, setSearchSuggestionHtml] = useState<string | null>(null);
  const searchSuggestionRef = useRef<HTMLDivElement>(null);
  // 検索候補はサニタイズ後のノードとして流し込む（文字列へ再直列化しない＝mXSS を避ける）。
  useEffect(() => {
    const el = searchSuggestionRef.current;
    if (!el) return;
    renderSanitizedHtml(el, searchSuggestionHtml ?? '');
  }, [searchSuggestionHtml]);

  const openRegionPicker = async () => {
    setVisionNotice(null);
    const attachedImage = attachedFiles.find(isImageFile);
    if (attachedImage) {
      setRegionPickerSrc(attachedImage.dataUrl);
      return;
    }
    if (imageDataUrl) {
      try {
        setRegionPickerSrc(await ensureDataUrl(imageDataUrl));
        return;
      } catch {
        /* 取得失敗時は下の案内へ */
      }
    }
    setVisionNotice('検索したい画像がありません。画像を添付するか、AI画像を生成してからお試しください。');
  };

  /** 範囲指定を終えたら、その切り出し画像だけで商品特定を実行する。 */
  const runVisionSearch = async (croppedDataUrl: string) => {
    setRegionPickerSrc(null);
    setError(null);
    setVisionNotice(null);
    setSending(true);
    const userLine = input.trim() || '画像に写っている商品を特定して、実在する商品を探してください。';
    setInput('');
    // どの画像で検索したかを会話に残す（通常送信と同じ体裁・260728 敵対レビュー C4）。
    const searchedNames = attachedFiles.filter(isImageFile).map((f) => f.name);
    setMessages([
      ...messages,
      { role: 'user', content: userLine, attachmentNames: searchedNames.length ? searchedNames : undefined },
    ]);
    setAttachedFiles([]); // 検索に使った画像が次の通常送信へ持ち越されないようにする
    setSearchSuggestionHtml(null); // 前回のテキスト検索の検索候補が残らないようにする
    try {
      const data = await postAgent({ mode: 'vision-product', imageDataUrl: croppedDataUrl, prompt: userLine });
      if (data.disabled) throw new Error('画像からの商品特定機能は現在無効です（運営設定）。通常のチャットでご相談ください。');
      if (!data.success) throw new Error(data.error || '商品の特定に失敗しました');
      void recordAiUsage({ feature: 'agent', usage: data.usage, model: data.model, imageCount: 1 });
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: typeof data.reply === 'string' ? data.reply : '',
          recommendations: Array.isArray(data.recommendations) ? data.recommendations : undefined,
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '商品の特定に失敗しました');
    } finally {
      setSending(false);
    }
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
            デザインの相談や、アイデア出しの壁打ちにご利用ください。
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => attachInputRef.current?.click()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-[11px] font-bold text-neutral-200 transition hover:bg-white/10 hover:text-white"
          >
            <Paperclip className="h-4 w-4" />
            ファイルを添付
          </button>
          {/* D&D が使えることを操作前に伝える（260728・エリア編集と操作を揃えた旨の明示）。 */}
          {attachedFiles.length === 0 && readingCount === 0 && (
            <span className="text-[10px] text-neutral-500">またはドラッグ&amp;ドロップ</span>
          )}
          {/*
            「画像から商品を特定」は独立した専用ボタンにする（260728 クライアント要望①）。
            従来はトグル＋送信時の自動判定だったが、入力文の語で経路が変わるため意図と噛み合わなかった。
            押した時点で必ずこの経路に入り、範囲指定 → 検索まで一直線に進む。
          */}
          {VISION_PRODUCT_SEARCH_ENABLED && (
            <button
              type="button"
              onClick={openRegionPicker}
              disabled={sending}
              title="画像内の探したい対象を範囲指定して、実在する商品を特定します"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/60 bg-emerald-600/15 px-3 py-1.5 text-[11px] font-bold text-emerald-100 transition hover:bg-emerald-600/30 disabled:opacity-40"
            >
              <Search className="h-4 w-4" />
              画像から商品を特定
            </button>
          )}
        </div>
        {visionNotice && <p className="text-[10px] leading-relaxed text-amber-300">{visionNotice}</p>}
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
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative ${
        inline
          ? 'flex h-full min-h-0 w-full flex-col rounded-2xl border border-white/15 bg-neutral-900/60'
          : 'fixed bottom-6 right-6 z-[10005] flex h-[28rem] w-[22rem] max-w-[92vw] flex-col rounded-2xl border border-white/15 bg-neutral-900/95 shadow-2xl backdrop-blur'
      }`}
    >
      {/* 画像内の対象を範囲指定してから商品特定を実行する（260728 要望①）。 */}
      {regionPickerSrc && (
        <ImageRegionPicker
          imageUrl={regionPickerSrc}
          busy={sending}
          onCancel={() => setRegionPickerSrc(null)}
          onConfirm={(cropped) => void runVisionSearch(cropped)}
        />
      )}
      {/* ドロップ中のオーバーレイ（どこへ落とせばよいか一目で分かるように）。 */}
      {dropActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-emerald-400 bg-emerald-500/10">
          <span className="rounded-lg bg-black/70 px-3 py-1.5 text-xs font-bold text-emerald-200">
            ここにドロップして添付
          </span>
        </div>
      )}
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
                className={`max-w-[85%] cursor-text select-text break-words rounded-xl px-3 py-2 leading-relaxed ${
                  m.role === 'user'
                    ? 'whitespace-pre-wrap bg-emerald-600 text-white'
                    : 'bg-white/10 text-neutral-100'
                }`}
                style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
              >
                {/* AIの回答は Markdown 記法（**強調**・箇条書き）を含むため、記号のまま見せず軽く整形する
                    （260728 クライアント報告「回答が読みづらい」）。ユーザー発言は素のまま表示。 */}
                {m.role === 'assistant' ? <ChatRichText text={m.content} /> : m.content}
              </div>
              {m.role === 'user' && m.attachmentNames && m.attachmentNames.length > 0 && (
                <div className="mt-1 flex max-w-[85%] flex-wrap justify-end gap-1">
                  {m.attachmentNames.map((name, ai) => (
                    <span
                      key={ai}
                      title={name}
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-700/40 px-1.5 py-0.5 text-[10px] text-emerald-50"
                    >
                      <Paperclip className="h-3 w-3 shrink-0" />
                      <span className="max-w-[10rem] truncate">{name}</span>
                    </span>
                  ))}
                </div>
              )}
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
                    // 260728 要望③: 提示するURLは「実際にページを開いて到達を確認できた個別商品URL」だけ。
                    // サーバ側で検索が返した実URLのみを採用し、開けなかったものは productUrl を落としてある
                    // （＝ここに URL があれば実在が確認済み）。確認できないものは従来どおり検索リンクへ退避する。
                    const searchQuery = [rec.brand, rec.name, rec.modelNumber].filter(Boolean).join(' ').trim();
                    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery || (rec.name ?? ''))}`;
                    const hasDirectUrl = typeof rec.productUrl === 'string' && /^https?:\/\//i.test(rec.productUrl);
                    const outOfStock = isOutOfStock(rec.availability);
                    // 見積へ渡す値。個別URLがあればそれを、無ければ確実に開ける検索URLを入れる（404を保存しない）。
                    const estimateItem = { ...rec, productUrl: hasDirectUrl ? rec.productUrl : searchUrl };
                    return (
                      <div key={key} className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-2">
                        <div className="flex items-start justify-between gap-2">
                          {/* サムネイル（260728 要望③）。他社サイトの画像を直接参照するため、
                              読めなかったら要素ごと隠して代替表示に切り替える（壊れた画像アイコンを出さない）。 */}
                          {rec.imageUrl && (
                            <img
                              src={rec.imageUrl}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                                e.currentTarget.nextElementSibling?.classList.remove('hidden');
                              }}
                              className="h-14 w-14 shrink-0 rounded border border-white/10 bg-black/30 object-cover"
                            />
                          )}
                          {rec.imageUrl && (
                            <div className="hidden h-14 w-14 shrink-0 items-center justify-center rounded border border-white/10 bg-black/30 text-[9px] text-neutral-500">
                              画像なし
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12px] font-bold text-neutral-100">{rec.name}</div>
                            {meta && <div className="mt-0.5 text-[10px] text-neutral-400">{meta}</div>}
                            <div className="mt-0.5 flex flex-wrap items-center gap-1">
                              {/* 実測（ページの構造化データ由来）か、モデルの推測かを明示する。 */}
                              {rec.verified ? (
                                <span className="rounded bg-emerald-600/25 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200">
                                  商品ページ確認済み
                                </span>
                              ) : (
                                <span className="rounded bg-amber-600/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-200">
                                  未確認（要確認）
                                </span>
                              )}
                              {outOfStock && (
                                <span className="rounded bg-red-600/20 px-1.5 py-0.5 text-[9px] font-bold text-red-200">
                                  在庫切れ/廃番の可能性
                                </span>
                              )}
                            </div>
                            {rec.reason && (
                              <div className="mt-0.5 text-[10px] leading-relaxed text-neutral-500">{rec.reason}</div>
                            )}
                            <a
                              href={hasDirectUrl ? rec.productUrl : searchUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-0.5 inline-block text-[10px] text-emerald-300 hover:underline"
                              title={hasDirectUrl ? '商品ページを開きます（到達確認済み）' : 'メーカー名・商品名・品番で検索します'}
                            >
                              {hasDirectUrl ? '商品ページを開く ↗' : '商品を検索 ↗'}
                            </a>
                          </div>
                          {onAddEstimateItem && (
                            <button
                              type="button"
                              disabled={added}
                              onClick={() => {
                                onAddEstimateItem(estimateItem);
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

        {/* Google 検索グラウンディングの利用規約が求める「検索候補」の表示（260728）。
            チップの文言は webSearchQueries 由来＝元をたどればユーザーの入力文なので、
            「Googleの応答だから安全」とは言えない。このアプリには CSP が無いため、
            許可タグ/属性だけを残すサニタイズを通してから描画する（260728 敵対レビュー A3）。 */}
        {searchSuggestionHtml && (
          <div ref={searchSuggestionRef} className="shrink-0 overflow-x-auto border-t border-white/10 px-2.5 py-1.5" />
        )}
        {/* チャット開始後も記入欄は縮ませず、初期状態と同じ大きさ・形式で下部に置く（260702）。 */}
        <div className="border-t border-white/10 p-2.5">{renderComposer('chat')}</div>
        </>
      )}
    </div>
  );
}
