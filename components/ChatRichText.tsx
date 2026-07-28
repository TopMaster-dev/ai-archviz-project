import React from 'react';

/**
 * チャット本文の軽量整形（260728 クライアント報告「回答が読みづらい」）。
 *
 * モデルの回答は Markdown 記法（**強調**、`- ` の箇条書き、`### ` の見出し）を含むため、
 * 素のテキストとして出すと「- **Bhavya Upholstered Arm Chair**」のように記号がそのまま見えてしまう。
 * ここで最小限だけ解釈して読みやすくする。
 *
 * 方針:
 *  - HTML は一切生成しない（React 要素だけを組み立てる）。第三者サイト由来の文字列が
 *    本文に混ざり得るため、innerHTML 経路を作らないことが安全側。
 *  - 対応するのは 強調 / 箇条書き / 見出し / 空行 のみ。リンクやテーブル等には対応しない
 *    （凝るほど誤爆が増え、チャットの短文には過剰なため）。
 */

/** `**強調**` と `*強調*` を太字に。それ以外はそのまま文字として出す。 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // ** で囲まれた部分を優先し、無ければ * で囲まれた部分。
  const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const inner = m[1] ?? m[2] ?? '';
    nodes.push(
      <strong key={`${keyPrefix}-b${i++}`} className="font-bold text-white">
        {inner}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

export function ChatRichText({ text }: { text: string }) {
  const src = (text ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) return null;

  const lines = src.split('\n');
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-4">
        {items.map((b, i) => (
          <li key={i}>{renderInline(b, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    // 箇条書き（- / * / ・ / 全角ハイフン、インデントも許容）
    const bullet = line.match(/^\s*(?:[-*・]|−)\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }
    flushBullets();
    if (!line.trim()) {
      // 連続する空行は1つの余白にまとめる
      if (blocks.length > 0) blocks.push(<div key={`sp-${idx}`} className="h-2" />);
      return;
    }
    // 見出し（### 等）は太字の行として出す
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(
        <div key={`h-${idx}`} className="mt-1 font-bold text-white">
          {renderInline(heading[1], `h-${idx}`)}
        </div>,
      );
      return;
    }
    blocks.push(<div key={`p-${idx}`}>{renderInline(line, `p-${idx}`)}</div>);
  });
  flushBullets();

  return <div className="space-y-0.5">{blocks}</div>;
}
