import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// R9: 「ホーム画面に戻る」時に離脱時オートセーブ（flushSave）を実行してから安全に遷移する挙動を検証。
// セッション本体は重いので useProjectSessionContext をモックし、flushSave の解決/失敗だけを制御する。
const h = vi.hoisted(() => ({ flushSave: vi.fn() }));

vi.mock('../../lib/project/projectSessionContext.js', () => ({
  useProjectSessionContext: () => ({ flushSave: h.flushSave }),
}));
vi.mock('../HomeScreen.js', () => ({
  HomeScreen: ({ onEnter }: { onEnter: () => void }) => (
    <button type="button" onClick={onEnter}>
      ENTER_EDITOR
    </button>
  ),
}));
vi.mock('../ProjectSaveIndicator.js', () => ({ ProjectSaveIndicator: () => null }));
vi.mock('../UndoRedoBar.js', () => ({ UndoRedoBar: () => null }));

import { AuthedShell } from './AuthedShell.js';

const HOME_BTN_TITLE = 'ホームに戻る（プロジェクト一覧）';

function enterEditor() {
  fireEvent.click(screen.getByText('ENTER_EDITOR'));
}

describe('AuthedShell goHome (R9 離脱時オートセーブ)', () => {
  beforeEach(() => {
    h.flushSave.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('保存成功時: flushSave を実行してからホームへ遷移する', async () => {
    h.flushSave.mockResolvedValue(undefined);
    render(
      <AuthedShell>
        <div>EDITOR_CONTENT</div>
      </AuthedShell>,
    );
    enterEditor();
    expect(screen.getByText('EDITOR_CONTENT')).toBeTruthy();

    fireEvent.click(screen.getByTitle(HOME_BTN_TITLE));
    await waitFor(() => expect(h.flushSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('ENTER_EDITOR')).toBeTruthy());
    expect(screen.queryByText('EDITOR_CONTENT')).toBeNull();
  });

  it('保存失敗時: 遷移せずエディタに留まり、再試行/保存せずに戻る を提示する', async () => {
    h.flushSave.mockRejectedValue(new Error('network'));
    render(
      <AuthedShell>
        <div>EDITOR_CONTENT</div>
      </AuthedShell>,
    );
    enterEditor();

    fireEvent.click(screen.getByTitle(HOME_BTN_TITLE));
    await waitFor(() => expect(screen.getByText('保存に失敗しました')).toBeTruthy());
    // 保存できていないので遷移しない（編集内容は残る）
    expect(screen.getByText('EDITOR_CONTENT')).toBeTruthy();
    expect(screen.queryByText('ENTER_EDITOR')).toBeNull();

    // 明示的に「保存せずに戻る」を選ぶとホームへ
    fireEvent.click(screen.getByText('保存せずに戻る'));
    await waitFor(() => expect(screen.getByText('ENTER_EDITOR')).toBeTruthy());
  });

  it('保存中の二度押しは無視される（ガード＋ボタン無効化）', async () => {
    let resolveFlush: () => void = () => {};
    h.flushSave.mockImplementation(() => new Promise<void>((r) => (resolveFlush = r)));
    render(
      <AuthedShell>
        <div>EDITOR_CONTENT</div>
      </AuthedShell>,
    );
    enterEditor();

    const btn = screen.getByTitle(HOME_BTN_TITLE);
    fireEvent.click(btn);
    fireEvent.click(btn); // 実行中（disabled）→ 発火しない
    expect(h.flushSave).toHaveBeenCalledTimes(1);

    resolveFlush();
    await waitFor(() => expect(screen.getByText('ENTER_EDITOR')).toBeTruthy());
  });
});
