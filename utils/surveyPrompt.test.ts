import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordAriseUse,
  shouldShowSurveyPrompt,
  markSurveyPrompted,
  dismissSurveyForever,
  SURVEY_PROMPT_EVERY,
} from './surveyPrompt.js';

describe('surveyPrompt', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* noop */
    }
  });

  it('利用回数をカウントする', () => {
    expect(recordAriseUse()).toBe(1);
    expect(recordAriseUse()).toBe(2);
  });

  it('SURVEY_PROMPT_EVERY 回ごとに促す', () => {
    for (let i = 0; i < SURVEY_PROMPT_EVERY - 1; i += 1) recordAriseUse();
    expect(shouldShowSurveyPrompt()).toBe(false); // 未達
    recordAriseUse(); // ちょうど EVERY 回
    expect(shouldShowSurveyPrompt()).toBe(true);
  });

  it('「後で」(markSurveyPrompted) で次の EVERY 回までは出さない', () => {
    for (let i = 0; i < SURVEY_PROMPT_EVERY; i += 1) recordAriseUse();
    expect(shouldShowSurveyPrompt()).toBe(true);
    markSurveyPrompted();
    expect(shouldShowSurveyPrompt()).toBe(false);
    for (let i = 0; i < SURVEY_PROMPT_EVERY; i += 1) recordAriseUse();
    expect(shouldShowSurveyPrompt()).toBe(true); // 次の閾値で再表示
  });

  it('「今後表示しない」で以後出さない', () => {
    for (let i = 0; i < SURVEY_PROMPT_EVERY; i += 1) recordAriseUse();
    dismissSurveyForever();
    expect(shouldShowSurveyPrompt()).toBe(false);
    for (let i = 0; i < SURVEY_PROMPT_EVERY; i += 1) recordAriseUse();
    expect(shouldShowSurveyPrompt()).toBe(false);
  });
});
