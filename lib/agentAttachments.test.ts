import { describe, it, expect } from 'vitest';
import { isReadableAttachment, resolveAttachmentMime, isGeminiInlineSupported } from './agentAttachments.js';

describe('isReadableAttachment (Office バイナリを添付一覧から除外・260702)', () => {
  it('excludes Office binary formats (client asked to hide these)', () => {
    for (const name of ['報告書.doc', '見積.docx', 'data.xls', 'data.xlsx', 'slides.pptx']) {
      expect(isReadableAttachment(name, ''), name).toBe(false);
    }
  });

  it('excludes Office binary even when the browser supplies the real MIME', () => {
    expect(
      isReadableAttachment('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(false);
    expect(isReadableAttachment('a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      false,
    );
  });

  it('excludes other unsupported binaries (zip, unknown)', () => {
    expect(isReadableAttachment('bundle.zip', 'application/zip')).toBe(false);
    expect(isReadableAttachment('mystery.xyz', '')).toBe(false);
  });

  it('accepts PDF / text / code / image / audio / video', () => {
    for (const name of ['a.pdf', 'a.txt', 'a.csv', 'a.rtf', 'a.py', 'a.js', 'a.png', 'a.jpeg', 'a.mp4', 'a.mp3']) {
      expect(isReadableAttachment(name, ''), name).toBe(true);
    }
  });

  it('classifies code files by extension even when File.type is empty', () => {
    expect(isReadableAttachment('main.py', '')).toBe(true);
    expect(isReadableAttachment('index.html', '')).toBe(true);
  });
});

describe('resolveAttachmentMime / isGeminiInlineSupported', () => {
  it('maps code/text extensions to text/plain-family and images/pdf correctly', () => {
    expect(resolveAttachmentMime('a.py', '')).toBe('text/plain');
    expect(resolveAttachmentMime('a.pdf', '')).toBe('application/pdf');
    expect(resolveAttachmentMime('a.png', '')).toBe('image/png');
  });

  it('falls back to the provided MIME (then octet-stream) for unmapped extensions', () => {
    expect(resolveAttachmentMime('a.docx', 'application/vnd.x')).toBe('application/vnd.x');
    expect(resolveAttachmentMime('a.bin', '')).toBe('application/octet-stream');
  });

  it('supports image/audio/video/text and application/pdf only', () => {
    expect(isGeminiInlineSupported('image/png')).toBe(true);
    expect(isGeminiInlineSupported('text/plain')).toBe(true);
    expect(isGeminiInlineSupported('application/pdf')).toBe(true);
    expect(isGeminiInlineSupported('application/vnd.x')).toBe(false);
    expect(isGeminiInlineSupported('application/octet-stream')).toBe(false);
  });
});
