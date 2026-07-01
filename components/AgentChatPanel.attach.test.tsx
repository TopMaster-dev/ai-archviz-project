// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentChatPanel } from './AgentChatPanel.js';

// 実行時副作用のあるモジュールはモック（DB/Storage/認証ヘッダ）。添付フローの純粋な検証に集中する。
vi.mock('../lib/byok.js', () => ({ geminiAuthHeaders: () => ({}) }));
vi.mock('../lib/db/aiUsage.js', () => ({ recordAiUsage: () => undefined }));
vi.mock('../lib/db/aiRenderStorage.js', () => ({ ensureDataUrl: async (x: string) => x }));

afterEach(() => cleanup());

function selectFiles(input: HTMLInputElement, files: File[]) {
  // jsdom では input.files が読み取り専用のため defineProperty で差し込む。
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  fireEvent.change(input);
}

describe('AgentChatPanel の添付アップロード（実際に効くこと・260702 リグレッション）', () => {
  it('ファイルを選択すると添付チップと件数ラベルが表示される', async () => {
    render(<AgentChatPanel open onOpenChange={() => {}} projectId="test-attach-1" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    selectFiles(input, [new File(['hello world'], 'notes.txt', { type: 'text/plain' })]);

    // FileReader は非同期。チップ（ファイル名）と件数ラベルが出れば添付は成立している。
    expect(await screen.findByText('notes.txt')).toBeTruthy();
    expect(screen.getByText(/添付ファイル（1件）/)).toBeTruthy();
  });

  it('拡張子で判定できるコード/テキスト（File.type が空）でも添付できる', async () => {
    render(<AgentChatPanel open onOpenChange={() => {}} projectId="test-attach-2" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    // File.type を空にして、拡張子ベース判定（.py→text/plain）で通ることを確認。
    selectFiles(input, [new File(['print(1)'], 'main.py', { type: '' })]);

    expect(await screen.findByText('main.py')).toBeTruthy();
  });

  it('直接読めない形式（.docx）は添付されず、案内が表示される', async () => {
    render(<AgentChatPanel open onOpenChange={() => {}} projectId="test-attach-3" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    selectFiles(input, [new File(['x'], 'report.docx', { type: '' })]);

    expect(await screen.findByText(/AIが直接読み取れない形式のため除外/)).toBeTruthy();
    expect(screen.queryByText('report.docx')).toBeNull();
  });
});
