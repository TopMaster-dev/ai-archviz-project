// テストマーケ用アンケート（Google フォーム）促しの状態管理（260626 クライアント要望）。
// 「Arise を一定回数使うごとに、フォーム記入のお願いポップアップを出す」を localStorage で実現する。
// 依存のない純粋モジュール（クライアント専用）。localStorage 不可時は安全に no-op。

/** 記入をお願いする Google フォームの URL（respondent 向け viewform）。 */
export const SURVEY_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSdKGQI569-ajb4RLfc027235d9gx30s0rm5br96VQNCs7yPGA/viewform';

/** 何回の利用ごとに促すか（クライアント要望 7〜10 回。5 回は多いとのことなので 7 を既定）。 */
export const SURVEY_PROMPT_EVERY = 7;

const USE_COUNT_KEY = 'arise.survey.useCount';
const PROMPTED_AT_KEY = 'arise.survey.promptedAt';
const DISMISSED_KEY = 'arise.survey.dismissed';

function ls(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readNum(key: string): number {
  const s = ls();
  if (!s) return 0;
  const n = parseInt(s.getItem(key) ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function writeNum(key: string, n: number): void {
  const s = ls();
  if (!s) return;
  try {
    s.setItem(key, String(n));
  } catch {
    /* 容量超過等は無視 */
  }
}

/** Arise を1回使った（＝プロジェクトを開いた）と記録し、新しい累計回数を返す。 */
export function recordAriseUse(): number {
  const next = readNum(USE_COUNT_KEY) + 1;
  writeNum(USE_COUNT_KEY, next);
  return next;
}

/** アンケート促しを出すべきか（前回促しから SURVEY_PROMPT_EVERY 回以上使い、かつ「今後表示しない」でない）。 */
export function shouldShowSurveyPrompt(): boolean {
  const s = ls();
  if (!s) return false;
  if (s.getItem(DISMISSED_KEY) === '1') return false;
  return readNum(USE_COUNT_KEY) - readNum(PROMPTED_AT_KEY) >= SURVEY_PROMPT_EVERY;
}

/** 促しを表示した（または「後で」）。現在の累計回数を基準にし、次は +EVERY 回後に再表示する。 */
export function markSurveyPrompted(): void {
  writeNum(PROMPTED_AT_KEY, readNum(USE_COUNT_KEY));
}

/** 「今後表示しない」。以後は促しを出さない。 */
export function dismissSurveyForever(): void {
  const s = ls();
  if (!s) return;
  try {
    s.setItem(DISMISSED_KEY, '1');
  } catch {
    /* noop */
  }
}
