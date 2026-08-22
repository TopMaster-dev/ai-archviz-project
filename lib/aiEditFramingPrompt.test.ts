import { describe, it, expect } from 'vitest';
import { buildAiEditReferenceGuide, buildNaturalizePrompt } from './aiEditPrompt.js';

/**
 * 【260821 クライアント指摘】エリア編集で生成のたびに構図が若干拡大される件。
 *
 * エリア編集は ENABLE_AREA_EDIT_FULLFRAME_ALL=true により画面全体を描き直して
 * そのまま採用するため、前の版の画素は1つも残らない。
 * 決定論の切り取りは実測で 0.000%（土台と生成の比がほぼ同一）と確定しており、
 * **構図を拘束しているのはプロンプトの文言だけ**という状態になっている。
 *
 * ところが「構図」「フレーミング」「アスペクト比」という最も効く語彙は
 * buildNaturalizePrompt 側にしか無く、そちらは skipFinishFor1B = useFullFrame = true
 * によって一度も呼ばれていなかった（＝最強の拘束文が送られていなかった）。
 *
 * このテストは「実際に送られるプロンプトに画角の拘束が入っていること」を固定する。
 * ここが緩むと、モデルを拘束するものが何も無くなる。
 */

const sentPrompt = () =>
  buildAiEditReferenceGuide({
    hasStyle: false,
    objects: [],
  });

describe('実際に送られるプロンプトに画角の拘束が入っている', () => {
  it('構図・フレーミング・アスペクト比を明示している', () => {
    const p = sentPrompt();
    for (const word of ['構図', 'フレーミング', 'アスペクト比']) {
      expect(p, `「${word}」が送信プロンプトに無い`).toContain(word);
    }
  });

  it('ズーム・トリミングを禁じている（拡大の直接の否定）', () => {
    const p = sentPrompt();
    expect(p).toContain('ズームイン');
    expect(p).toContain('トリミング');
  });

  it('【絶対に変えない】の一覧に入っている（優先度の高い位置）', () => {
    const p = sentPrompt();
    const head = p.indexOf('【絶対に変えない】');
    expect(head, '【絶対に変えない】が見つからない').toBeGreaterThanOrEqual(0);
    const framing = p.indexOf('フレーミング');
    expect(framing).toBeGreaterThan(head);
    // 見出し直後の数行に入っていること（末尾へ埋もれていない）。
    expect(framing - head).toBeLessThan(400);
  });
});

describe('参考: 到達不能だった側の文言', () => {
  it('buildNaturalizePrompt にも同じ語彙がある（こちらは現行フラグでは呼ばれない）', () => {
    /*
      skipFinishFor1B = useFullFrame = true のため、仕上げパスは実行されない。
      同じ語彙を送信側へ移したのが今回の修正。ここは記録として残す。
    */
    const p = buildNaturalizePrompt();
    expect(p).toContain('フレーミング');
  });
});
