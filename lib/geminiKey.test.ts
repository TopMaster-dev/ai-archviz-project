import { describe, it, expect } from 'vitest';
import { extractGeminiApiKey } from './geminiKey.js';

// NOTE: all keys below are SYNTHETIC fixtures for format-matching only — not real credentials.

describe('extractGeminiApiKey (260612: accept both AIza... and AQ. formats)', () => {
  it('extracts a legacy AIzaSy key', () => {
    expect(extractGeminiApiKey('AIzaSyEXAMPLE0000000000000000000000000')).toBe(
      'AIzaSyEXAMPLE0000000000000000000000000',
    );
  });

  it('extracts the new AQ. format key', () => {
    const k = 'AQ.EXAMPLE_aq_key_0123456789ABCDEFabcdef-_';
    expect(extractGeminiApiKey(k)).toBe(k);
  });

  it('trims surrounding whitespace/newlines', () => {
    expect(extractGeminiApiKey('  AQ.EXAMPLE_aq_trim \n')).toBe('AQ.EXAMPLE_aq_trim');
    expect(extractGeminiApiKey('\tAIzaSyXYZ123_abc-DEF\n')).toBe('AIzaSyXYZ123_abc-DEF');
  });

  it('pulls the key out of a labelled paste', () => {
    expect(extractGeminiApiKey('API key: AIzaSyXYZ123abc')).toBe('AIzaSyXYZ123abc');
    expect(extractGeminiApiKey('key = AQ.EXAMPLE_aq_label here')).toBe('AQ.EXAMPLE_aq_label');
  });

  it('prefers AIza when both appear', () => {
    expect(extractGeminiApiKey('AQ.EXAMPLE AIzaSyREAL123')).toBe('AIzaSyREAL123');
  });

  it('returns empty string for missing / unrecognised input', () => {
    expect(extractGeminiApiKey('')).toBe('');
    expect(extractGeminiApiKey(null)).toBe('');
    expect(extractGeminiApiKey(undefined)).toBe('');
    expect(extractGeminiApiKey('not-a-key')).toBe('');
  });
});
