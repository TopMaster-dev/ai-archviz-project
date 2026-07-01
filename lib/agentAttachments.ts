// エージェント相談の添付ファイル判定（クライアント/サーバ共有・260702）。
// 「AIが本体を直接読み取れる添付か」の単一の判断基準をここに置き、
// クライアント（AgentChatPanel の添付UI）とサーバ（gemini.ts の generateAgentReply）で共有する。

// 添付ファイル拡張子 → Gemini が inlineData で扱える MIME。コード/テキストは text/plain に寄せる。
// ここに無い拡張子（.doc/.docx/.xls/.xlsx/.pptx 等の Office バイナリ）は「直接読めない」と判定する。
export const ATTACH_EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain', csv: 'text/csv', tsv: 'text/plain', rtf: 'text/rtf', html: 'text/html', css: 'text/css',
  c: 'text/plain', java: 'text/plain', py: 'text/plain', js: 'text/plain', php: 'text/plain', ph: 'text/plain',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
  wav: 'audio/wav', mp3: 'audio/mp3', aiff: 'audio/aiff', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', mpeg: 'video/mpeg', mov: 'video/mov', avi: 'video/avi', webm: 'video/webm', '3gpp': 'video/3gpp',
};

/** ファイル名の拡張子から Gemini 向き MIME を決める。未対応拡張子は data URL / File の MIME を使う。 */
export function resolveAttachmentMime(name: string | undefined, dataUrlMime: string): string {
  const ext = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && ATTACH_EXT_MIME[ext]) return ATTACH_EXT_MIME[ext];
  return dataUrlMime || 'application/octet-stream';
}

/** Gemini が inlineData で直接扱える MIME か（画像/音声/動画/テキスト/PDF）。Office バイナリ等は不可。 */
export function isGeminiInlineSupported(mime: string): boolean {
  return /^(image|audio|video|text)\//.test(mime) || mime === 'application/pdf';
}

/**
 * ファイル名/種別から、AIが本体を直接読み取れる添付かどうか。
 * false のもの（.doc/.docx/.xls/.xlsx/.pptx 等）は添付一覧に載せず除外する（クライアント要望・260702）。
 */
export function isReadableAttachment(name: string | undefined, mimeType: string): boolean {
  return isGeminiInlineSupported(resolveAttachmentMime(name, mimeType));
}
