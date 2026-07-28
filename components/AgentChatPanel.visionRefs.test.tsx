// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AgentChatPanel } from './AgentChatPanel.js';

/**
 * 260728 クライアント要望「参考画像を選ぶと、その商品を追加できるように」。
 *
 * ここで守りたいのは 2 点:
 *  ①参考画像が「押せる」こと。押したら該当商品の特定リクエストが飛ぶこと。
 *   （掲載ページが分かっている画像は署名トークンも一緒に送る＝Vision を消費せず直接ページを読む経路。
 *    URL ではなくトークンなのは、任意URLの取得代行にしないため＝敵対レビュー H1）
 *  ②旧形式（画像URLの文字列配列）で localStorage に残っている履歴を読んでも壊れないこと。
 *   履歴は利用者の端末に残り続けるので、形を変えた側が必ず後方互換を持たなければならない。
 */

beforeAll(() => {
  if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = () => {};
  }
});

vi.mock('../lib/byok.js', () => ({ geminiAuthHeaders: () => ({}) }));
vi.mock('../lib/db/aiUsage.js', () => ({ recordAiUsage: () => undefined }));
vi.mock('../lib/db/aiRenderStorage.js', () => ({ ensureDataUrl: async (x: string) => x }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

/** 会話履歴を localStorage に仕込む（パネルはプロジェクト単位でここから復元する）。 */
function seedChat(projectId: string, messages: unknown[]) {
  localStorage.setItem(`arise-agent-chat-${projectId}`, JSON.stringify(messages));
}

function stubAgentFetch(body: Record<string, unknown>) {
  const mock = vi.fn(async () => ({
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** 送信された JSON ボディを取り出す。 */
function sentBody(mock: ReturnType<typeof stubAgentFetch>, call = 0): any {
  return JSON.parse((mock.mock.calls[call][1] as RequestInit).body as string);
}

describe('参考画像から商品を特定する（260728）', () => {
  it('掲載ページが分かっている画像を押すと、署名トークン付きで商品特定を投げる', async () => {
    seedChat('vr-1', [
      { role: 'user', content: '探して' },
      {
        role: 'assistant',
        content: '候補です',
        visionRefs: {
          images: [{ url: 'https://img.example.jp/a.jpg', token: 'img-token-a', pageToken: 'signed-token-abc' }],
          pages: [{ title: 'ソファ', url: 'https://shop.example.jp/item/1' }],
        },
      },
    ]);

    const fetchMock = stubAgentFetch({
      success: true,
      reply: '取得しました',
      recommendations: [{ name: 'ソファA', verified: true }],
    });

    render(<AgentChatPanel open onOpenChange={() => {}} projectId="vr-1" />);

    const button = screen.getByTitle('この画像の掲載ページから商品情報を取得する');
    fireEvent.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody(fetchMock);
    expect(body.mode).toBe('vision-product');
    expect(body.imageToken).toBe('img-token-a'); // 生URLは送らない
    expect(body.imageUrl).toBeUndefined();
    expect(body.pageToken).toBe('signed-token-abc'); // 署名トークン経由でのみ直接ページを読む
    // 特定できた商品が、見積へ回せる形（商品カード）で会話に出る
    expect(await screen.findByText('ソファA')).toBeTruthy();
  });

  it('掲載ページが不明な画像は署名トークン無しで送る（画像から特定し直す）', async () => {
    seedChat('vr-2', [
      { role: 'user', content: '探して' },
      {
        role: 'assistant',
        content: '候補です',
        visionRefs: { images: [{ url: 'https://img.example.jp/b.jpg', token: 'img-token-b' }], pages: [] },
      },
    ]);
    const fetchMock = stubAgentFetch({ success: true, reply: 'ok', recommendations: [] });

    render(<AgentChatPanel open onOpenChange={() => {}} projectId="vr-2" />);
    fireEvent.click(screen.getByTitle('この画像で商品を特定し直す'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody(fetchMock);
    expect(body.imageToken).toBe('img-token-b');
    expect(body.pageToken).toBeUndefined();
  });

  it('旧形式（画像URLの文字列配列）の履歴でも壊れず表示される。ただし署名が無いので押せない', async () => {
    // 形を変える前に保存された履歴。利用者の端末に残っているので、読めなくなってはいけない。
    // 一方で署名トークンが無い＝「サーバが提示したURLである」ことを確認できないので、
    // 取得のトリガーにはしない（ここを押せるようにすると H1 の穴が履歴経由で復活する）。
    seedChat('vr-3', [
      { role: 'assistant', content: '候補です', visionRefs: { images: ['https://img.example.jp/old.jpg'], pages: [] } },
    ]);
    const fetchMock = stubAgentFetch({ success: true, reply: 'ok', recommendations: [] });

    render(<AgentChatPanel open onOpenChange={() => {}} projectId="vr-3" />);
    const button = screen.getByTitle('参考画像（この画像からの再検索は利用できません）');
    expect((button as HTMLButtonElement).disabled).toBe(true); // 表示はされるが押せない
    expect(screen.getByAltText('参考画像')).toBeTruthy();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('参考画像が全部読み込めなければ、見出しごと出さない（空の箱を残さない）', async () => {
    seedChat('vr-5', [
      {
        role: 'assistant',
        content: '候補です',
        visionRefs: { images: [{ url: 'https://img.example.jp/dead.jpg', token: 't' }], pages: [] },
      },
    ]);
    render(<AgentChatPanel open onOpenChange={() => {}} projectId="vr-5" />);
    // 最初は出ている
    expect(screen.queryByText(/画像から見つかった参考情報/)).toBeTruthy();
    // hotlink 拒否などで読み込みに失敗すると、枠と見出しごと消える
    fireEvent.error(screen.getByAltText('参考画像'));
    await waitFor(() => expect(screen.queryByText(/画像から見つかった参考情報/)).toBeNull());
  });

  it('画像が全滅しても参考ページが残っていれば、枠は残す', async () => {
    seedChat('vr-6', [
      {
        role: 'assistant',
        content: '候補です',
        visionRefs: {
          images: [{ url: 'https://img.example.jp/dead.jpg', token: 't' }],
          pages: [{ title: 'ソファ', url: 'https://shop.example.jp/item/1' }],
        },
      },
    ]);
    render(<AgentChatPanel open onOpenChange={() => {}} projectId="vr-6" />);
    fireEvent.error(screen.getByAltText('参考画像'));
    await waitFor(() => expect(screen.queryByAltText('参考画像')).toBeNull());
    expect(screen.getByText(/画像から見つかった参考情報/)).toBeTruthy();
    expect(screen.getByTitle('https://shop.example.jp/item/1')).toBeTruthy();
  });

  it('処理中は参考画像を押せない（二重リクエストを出さない）', async () => {
    seedChat('vr-4', [
      {
        role: 'assistant',
        content: '候補です',
        visionRefs: { images: [{ url: 'https://img.example.jp/c.jpg', token: 'img-token-c' }], pages: [] },
      },
    ]);
    // 応答を保留させ、送信中の状態を維持する
    const mock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', mock);

    render(<AgentChatPanel open onOpenChange={() => {}} projectId="vr-4" />);
    const button = screen.getByTitle('この画像で商品を特定し直す');
    fireEvent.click(button);

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
