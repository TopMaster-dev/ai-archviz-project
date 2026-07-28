import { describe, it, expect } from 'vitest';
import { salvageReplyText } from './gemini.js';

/**
 * 260728 クライアント報告: チャットに `{"reply":"画像に写っている椅子は…` という
 * 生のJSONがそのまま表示された。
 *
 * 原因: 回答は JSON 形式で返させているが、長文で打ち切られる（MAX_TOKENS）等で
 * JSON.parse に失敗すると、フォールバックが「応答テキスト全体」を本文にしていた。
 * JSON として壊れていても本文だけは救い出し、JSONの殻は絶対に見せない。
 */
describe('salvageReplyText', () => {
  it('正常なJSONから本文だけを取り出す', () => {
    expect(salvageReplyText('{"reply":"こんにちは","recommendations":[]}')).toBe('こんにちは');
  });

  it('途中で切れたJSONでも、そこまでの本文を返す（実際の不具合ケース）', () => {
    // MAX_TOKENS で閉じ引用符も閉じ括弧も無い状態
    const truncated = '{"reply":"画像に写っている椅子は、丸みを帯びた背もたれと';
    expect(salvageReplyText(truncated)).toBe('画像に写っている椅子は、丸みを帯びた背もたれと');
  });

  it('エスケープを正しく戻す（改行・引用符・バックスラッシュ）', () => {
    expect(salvageReplyText('{"reply":"1行目\\n2行目"}')).toBe('1行目\n2行目');
    expect(salvageReplyText('{"reply":"彼は\\"椅子\\"と言った"}')).toBe('彼は"椅子"と言った');
    expect(salvageReplyText('{"reply":"C:\\\\path"}')).toBe('C:\\path');
  });

  it('コードフェンス付きでも取り出せる', () => {
    expect(salvageReplyText('```json\n{"reply":"フェンス内"}\n```')).toBe('フェンス内');
  });

  it('JSONでない普通の文はそのまま返す', () => {
    expect(salvageReplyText('ただのテキスト応答です')).toBe('ただのテキスト応答です');
  });

  it('本文が空・取り出せない場合は空文字（呼び出し側が定型文にする）', () => {
    expect(salvageReplyText('')).toBe('');
    expect(salvageReplyText('   ')).toBe('');
    expect(salvageReplyText('{"reply":""}')).toBe('');
  });

  it('救い出した本文にJSONの殻が混ざらない', () => {
    const out = salvageReplyText('{"reply":"本文です","recommendations":[{"name":"椅子"}]}');
    expect(out).toBe('本文です');
    expect(out).not.toContain('recommendations');
    expect(out).not.toContain('{');
  });

  it('reply キーが後ろにあっても取り出せる', () => {
    expect(salvageReplyText('{"recommendations":[],"reply":"後ろにある本文"}')).toBe('後ろにある本文');
  });
});
