/**
 * 第三者の商品ページをサーバ側から取得するための「唯一の入口」（260728 クライアント要望）。
 *
 * なぜ専用ヘルパーが要るのか:
 *   AI エージェントが出してきた URL をそのまま fetch すると、
 *   ①SSRF＝社内ネットワークやクラウドのメタデータ（169.254.169.254 等）を我々のサーバ権限で読ませられる、
 *   ②DoS＝応答が遅い/巨大なサイトに Vercel 関数を占有され、メモリごと落とされる、
 *   という 2 種類の事故が起きる。だから「取得」は必ずこのモジュール経由に統一し、
 *   URL 検証・タイムアウト・サイズ上限・リダイレクト追跡を 1 か所に閉じ込める。
 *
 * このモジュールは HTML 文字列を返すだけで、解析は一切しない（解析は呼び出し側の責務）。
 */

/** 失敗理由。呼び出し側はこれを見てユーザー向け文言を出し分ける。 */
export type SafeFetchFailReason =
  | 'blocked-url' // 入力 URL そのものが対象外（内部アドレス/非 http など）
  | 'blocked-host' // リダイレクト先が内部アドレスへ飛んだ（SSRF 未遂）
  | 'blocked-dns' // ホスト名は公開ドメインなのに、DNS 解決結果が内部アドレスだった（SSRF 未遂）
  | 'timeout'
  | 'too-large'
  | 'bad-status' // 2xx 以外（404/500/リダイレクト過多）
  | 'not-html' // PDF や画像など、HTML として解析してはいけない本文
  | 'not-image' // 画像として取得したのに画像でなかった（HTML のエラーページ等）
  | 'network';

export type SafeFetchResult =
  | { ok: true; html: string; finalUrl: string; status: number }
  | { ok: false; reason: SafeFetchFailReason; status?: number };

/** 画像取得の結果（260728 参考画像クリック→商品特定）。本文は base64 で返す（そのまま data URL にできる）。 */
export type SafeFetchImageResult =
  | { ok: true; base64: string; mimeType: string; finalUrl: string; status: number }
  | { ok: false; reason: SafeFetchFailReason; status?: number };

/** 既定値。Vercel の関数実行時間・メモリに対して十分に安全側へ倒す。 */
const DEFAULT_TIMEOUT_MS = 4000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 15_000;

const DEFAULT_MAX_BYTES = 512_000;
/** 画像は HTML より大きいのが普通なので既定値を別に持つ（EC の商品写真はおおむね 1MB 未満）。 */
const DEFAULT_MAX_IMAGE_BYTES = 4_000_000;

/** Cloud Vision と Gemini の両方が確実に解釈できる画像形式だけ（SVG/AVIF/GIF は不可）。 */
const DECODABLE_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MIN_MAX_BYTES = 1024;
const MAX_MAX_BYTES = 5_000_000;

/** 自前で追うリダイレクトの上限（初回 + 3 ホップ = 最大 4 リクエスト）。 */
const MAX_REDIRECTS = 3;

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const DEFAULT_URL_LIMIT = 6;
/** 1 回のエージェント応答が数百リクエストに膨らまないための絶対上限（opts.limit でも超えられない）。 */
const HARD_URL_LIMIT = 12;

/** 相手サイトのログに「誰が来たか」が残るよう、正体を明かす UA を送る（無言のスクレイパにしない）。 */
const USER_AGENT = 'AriseArchVizBot/1.0 (+https://arise-archviz.app/bot; product page reader)';

/** リダイレクトとして扱うステータス。303 も常に GET で追うので問題ない。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** ホスト名そのものが内部を指すもの。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal', // GCP メタデータ
  'metadata.goog', // 同上（別名）
]);

/** この接尾辞を持つホストは内部名前解決に落ちるため一律ブロック。 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;

/** 'a.b.c.d' を 4 オクテットへ。範囲外・非数字は null（＝IPv4 リテラルではない）。 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function isBlockedIpv4(ip: number[]): boolean {
  const [a, b] = ip;
  if (a === 0) return true; // 0.0.0.0/8（「このホスト」）
  if (a === 127) return true; // 127.0.0.0/8 ループバック
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 リンクローカル（169.254.169.254 メタデータ含む）
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 等の IETF 予約
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 ベンチマーク用
  if (a >= 224) return true; // 224.0.0.0/4 マルチキャスト・240.0.0.0/4 予約（Web ページはあり得ない）
  return false;
}

/**
 * IPv6 リテラルを 8 グループ（各 16bit）へ展開。'::' 圧縮と末尾の IPv4 記法に対応。
 * IPv6 ではない場合は null。
 */
function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const pct = s.indexOf('%'); // ゾーン ID（fe80::1%eth0）は無視して判定
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':')) return null;

  const dbl = s.indexOf('::');
  if (dbl >= 0 && dbl !== s.lastIndexOf('::')) return null; // '::' は 1 回まで
  const headStr = dbl >= 0 ? s.slice(0, dbl) : s;
  const tailStr = dbl >= 0 ? s.slice(dbl + 2) : '';

  const push = (tokens: string[], out: number[]): boolean => {
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t.includes('.')) {
        // 埋め込み IPv4（::ffff:127.0.0.1）は最後のトークンのみ
        if (i !== tokens.length - 1) return false;
        const v4 = parseIpv4(t);
        if (!v4) return false;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(t)) return false;
      out.push(parseInt(t, 16));
    }
    return true;
  };

  const head: number[] = [];
  const tail: number[] = [];
  if (!push(headStr ? headStr.split(':') : [], head)) return null;
  if (!push(tailStr ? tailStr.split(':') : [], tail)) return null;

  if (dbl < 0) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isBlockedIpv6(groups: number[]): boolean {
  if (groups.every((g) => g === 0)) return true; // :: （未指定アドレス）

  const zeroPrefix = groups.slice(0, 5).every((g) => g === 0);
  if (zeroPrefix && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true; // ::1

  // IPv4-mapped（::ffff:a.b.c.d）/ IPv4-compatible（::a.b.c.d）は埋め込み IPv4 の規則で判定する。
  // Node の URL は ::ffff:127.0.0.1 を ::ffff:7f00:1 に正規化するため、必ず数値で見ること。
  if (zeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    if (isBlockedIpv4(v4)) return true;
    // ::a.b.c.d（IPv4-compatible）は現代では使われず、内部到達の抜け道になり得るので塞ぐ
    if (groups[5] === 0) return true;
  }

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ユニークローカル
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 リンクローカル
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 マルチキャスト
  return false;
}

/**
 * dns.lookup が返した「解決済みアドレス文字列」が内部向けかを判定する。
 *
 * なぜ必要か（HIGH severity の穴を塞ぐ）:
 *   isFetchableUrl は URL の**文字列**しか見ない。攻撃者が自分の公開ドメインの A レコードに
 *   169.254.169.254 や 10.x.x.x を設定すると（DNS リバインディングすら不要、静的な A レコード 1 本で足りる）、
 *   文字列検査は全部通り、我々の Vercel 関数からクラウドメタデータを読まれる。
 *   そこで文字列検査の「下」に、実際に解決したアドレスで判定する層を追加する。
 *
 * 範囲表は isBlockedIpv4 / isBlockedIpv6 を再利用する（表を二重管理すると必ず片方が腐る）。
 * 判定不能（IP としてパースできない文字列）は true＝ブロック側に倒す。SSRF ゲートでは
 * 「わからないものは通さない」が唯一の正解。
 */
export function isBlockedIpAddress(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  let s = ip.trim().toLowerCase();
  if (!s) return true;
  // 念のため [::1] 形式・末尾ドットも受け付ける（呼び出し元の整形ミスで穴が開かないように）
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  while (s.endsWith('.')) s = s.slice(0, -1);
  if (!s) return true;

  if (s.includes(':')) {
    const v6 = parseIpv6(s);
    return v6 ? isBlockedIpv6(v6) : true;
  }
  const v4 = parseIpv4(s);
  return v4 ? isBlockedIpv4(v4) : true;
}

type DnsLookup = (host: string, opts: { all: true; verbatim: true }) => Promise<unknown>;

/** 遅延ロードの結果は 1 回だけ解決してキャッシュする（並列取得のたびにローダを叩かない）。 */
let dnsLookupPromise: Promise<DnsLookup | null> | null = null;

/**
 * node:dns/promises を遅延ロードして lookup を取り出す。取れなければ null。
 *
 * 静的 import にしないのは、このモジュールがバンドラ/ブラウザ寄りの文脈からも到達し得るため。
 * node:dns が存在しない環境ではビルドごと壊すのではなく null を返し、「取得しない」判断は
 * 呼び出し側（＝アドレスを確認できないので fetch しない）に委ねる。
 */
function loadDnsLookup(): Promise<DnsLookup | null> {
  if (!dnsLookupPromise) {
    dnsLookupPromise = import('node:dns/promises')
      .then((mod) => {
        // CJS 相互運用で名前空間が default 配下に入る場合があるため両方見る
        const m = mod as unknown as { lookup?: DnsLookup; default?: { lookup?: DnsLookup } };
        const fn = typeof m.lookup === 'function' ? m.lookup : m.default?.lookup;
        return typeof fn === 'function' ? fn : null;
      })
      .catch(() => null);
  }
  return dnsLookupPromise;
}

/**
 * ホスト名を実際に解決し、返ってきたアドレスを**全件**返す。**絶対に throw しない**（失敗は空配列）。
 *
 * all:true が必須。1 件目だけ見る実装だと「公開 IP と私設 IP を両方 A レコードに書き、
 * 運が良ければ公開側で検査を通す」攻撃に負ける。verbatim:true は Node の並べ替えを止めて
 * 「実際に接続され得る候補」をそのまま得るため。
 */
export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (typeof hostname !== 'string' || !hostname.trim()) return [];
  try {
    const lookup = await loadDnsLookup();
    if (!lookup) return [];

    const records = await lookup(hostname.trim(), { all: true, verbatim: true });
    if (!Array.isArray(records)) return [];
    return records
      .map((r) => (r && typeof r === 'object' ? (r as { address?: unknown }).address : r))
      .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      .map((a) => a.trim());
  } catch {
    // ENOTFOUND / SERVFAIL / node:dns 自体が無い、いずれも「確認できなかった」として扱う
    return [];
  }
}

/** URL からホスト名だけを取り出す（IPv6 の [] と FQDN の末尾ドットは剥がす）。解析不能は空文字。 */
function hostnameOf(raw: string): string {
  try {
    let host = new URL(raw).hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    while (host.endsWith('.')) host = host.slice(0, -1);
    return host;
  } catch {
    return '';
  }
}

/**
 * 「文字列検査を通った URL」を、実際に解決したアドレスで再検査する。
 * 通過なら null、ダメなら失敗理由を返す（呼び出し側はこれを見て fetch せずに戻る）。
 */
async function checkHostDns(target: string): Promise<SafeFetchFailReason | null> {
  const host = hostnameOf(target);
  if (!host) return 'blocked-url'; // isFetchableUrl 通過後なので通常来ない（保険）

  const addresses = await resolveHostAddresses(host);
  if (addresses.length === 0) {
    // 解決できない＝「内部アドレスでないこと」を確認できない。確認できないものは取りに行かない。
    return 'network';
  }

  // 1 件目だけでなく全件見る。公開 IP と私設 IP の併記で検査をすり抜ける手口を潰すため。
  const blocked = addresses.filter((a) => isBlockedIpAddress(a));
  if (blocked.length > 0) {
    // ここが鳴る＝進行中の SSRF 攻撃。握り潰さず必ずログに残す。
    console.error(
      `[safeFetchPage] blocked-dns: ${host} -> ${blocked.join(', ')} (公開ドメインが内部アドレスに解決。SSRF 未遂の可能性)`,
    );
    return 'blocked-dns';
  }
  return null;
}

/**
 * 「公開されたふつうの http(s) ページ」だけを true にする純関数。
 * ここが SSRF 防御の中核なので、疑わしいものは全部 false に倒す（誤って社内へ出るより、拾えない方がまし）。
 */
export function isFetchableUrl(raw: string): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false; // javascript:alert(1) のような相対/不正文字列もここで落ちる
  }

  // http(s) 以外（javascript:/data:/file:/ftp:/about: …）は一切許可しない
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // 認証情報つき URL（user:pass@）は、認証を持つ内部エンドポイントを叩かせる典型手口
  if (url.username || url.password) return false;

  // IPv6 は hostname が [..] で囲まれるので外す。末尾ドット（localhost.）は FQDN 表記なので落とす。
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return false;

  if (host.includes(':')) {
    const v6 = parseIpv6(host);
    if (!v6) return false; // 壊れた IPv6 リテラルは判定不能＝拒否
    return !isBlockedIpv6(v6);
  }

  // Node の URL は 0177.0.0.1 / 2130706433 のような別表記も 127.0.0.1 に正規化してくれる
  const v4 = parseIpv4(host);
  if (v4) return !isBlockedIpv4(v4);

  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;

  // ドットの無い単一ラベル（intranet, instance-data …）は社内 DNS/検索ドメインで内部に解決される
  if (!host.includes('.')) return false;

  return true;
}

interface ReadOutcome {
  html?: string;
  tooLarge?: boolean;
}

/**
 * 本文をストリームで読みつつ上限で打ち切る。
 * 全部バッファしてから長さを見る実装だと、200MB のページ 1 本で関数が OOM で落ちるため必ずストリームで数える。
 *
 * 文字コードは UTF-8 固定。国内 EC も現在はほぼ UTF-8 で、レガシーな Shift_JIS ページは文字化けするが、
 * デコーダ依存を増やしてまで救わない（既知の制限として受け入れる）。
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<ReadOutcome> {
  const body = res.body;

  if (!body || typeof body.getReader !== 'function') {
    // ストリームが無い環境/実装向けのフォールバック。既に全量メモリに載っているので、保持量だけ上限に切り詰める。
    const text = await res.text();
    return { html: text.length > maxBytes ? text.slice(0, maxBytes) : text };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let html = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // 文字列チャンクを返す実装（テスト用の疑似ストリーム等）にも耐えるようにしておく
      const isText = typeof value === 'string';
      total += isText ? (value as unknown as string).length : value.byteLength;
      if (total > maxBytes) {
        // 上限超過が判明した時点で受信を中止する（残りをダウンロードしない＝これが DoS 対策の要）
        try {
          await reader.cancel();
        } catch {
          /* 相手都合の失敗は無視 */
        }
        return { tooLarge: true };
      }
      html += isText ? (value as unknown as string) : decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 解放済みなら無視 */
    }
  }
  return { html };
}

function isAbortLike(e: unknown): boolean {
  const err = e as { name?: unknown; code?: unknown } | null;
  if (!err) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR';
}

/** リダイレクト応答の本文は使わないので破棄する（コネクションを掴んだままにしない）。 */
function discardBody(res: Response): void {
  try {
    const body = res.body as { cancel?: () => Promise<unknown> } | null | undefined;
    if (body && typeof body.cancel === 'function') {
      void Promise.resolve(body.cancel()).catch(() => {});
    }
  } catch {
    /* noop */
  }
}

/**
 * 公開ページを 1 本だけ安全に取得する。**絶対に throw しない**（失敗は必ず SafeFetchResult で返す）。
 *
 * redirect:'follow' を使わないのが肝。公開 URL が 302 で 169.254.169.254 に飛ばす攻撃は
 * fetch 任せだと検証をすり抜けるので、manual にして 1 ホップごとに isFetchableUrl を掛け直す。
 * さらに、各ホップで **DNS 解決結果**も検査する（文字列だけの検査は公開ドメイン→私設 IP を防げない）。
 *
 * ■ 残存リスク: DNS ピン留めをしていない（TOCTOU / DNS リバインディング）
 *   我々は「解決 → 検査 → fetch」の順で動くが、fetch は自分でもう一度名前解決する。
 *   TTL=0 の悪意ある権威 DNS が、検査時は公開 IP・fetch 時は 169.254.169.254 を返せば、
 *   理論上はこの窓をすり抜けられる（実運用では成功率は低いが 0 ではない）。
 *   これを完全に閉じるには、検査済みアドレスに接続を固定する必要がある：
 *     const { Agent } = await import('undici');
 *     const dispatcher = new Agent({
 *       connect: { lookup: (_h, _o, cb) => cb(null, [{ address: pinnedIp, family }]) },
 *     });
 *     await fetch(url, { ...init, dispatcher } as RequestInit);
 *   本リポジトリは undici を依存に持たない（package.json に無い。Node 18+ の内蔵 undici は
 *   'undici' として import できない）ため、依存追加を避けて**ピン留めは行っていない**。
 *   undici を追加できるようになったら、上記を各ホップに入れてこの窓を閉じること。
 */
export async function safeFetchPage(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<SafeFetchResult> {
  const maxBytes = clamp(opts?.maxBytes ?? DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);

  return guardedFetch<Extract<SafeFetchResult, { ok: true }>>(url, {
    timeoutMs: opts?.timeoutMs,
    accept: 'text/html,application/xhtml+xml',
    // PDF や画像を HTML として解析させない
    acceptContentType: (ct) => ct.includes('text/html') || ct.includes('application/xhtml'),
    wrongTypeReason: 'not-html',
    read: async (res, controller, finalUrl, status) => {
      const outcome = await readBodyCapped(res, maxBytes);
      if (outcome.tooLarge) {
        controller.abort(); // 念のため接続ごと畳む
        return { ok: false, reason: 'too-large', status };
      }
      return { ok: true, html: outcome.html ?? '', finalUrl, status };
    },
  });
}

/**
 * 公開画像を 1 本だけ安全に取得し、base64 で返す（260728 クライアント要望「参考画像を選んで商品を追加」）。
 *
 * なぜサーバ側で取りに行くのか:
 *   参考画像は第三者ドメインの画像なので、ブラウザからは CORS で本文を読めない
 *   （canvas も汚染されて toDataURL が例外になる）。Vision と Gemini の両方へ同じ画像を渡すには
 *   バイト列が要るため、サーバで取得するしかない。
 *   ただし「URL を渡されてサーバが取りに行く」＝ SSRF そのものなので、
 *   ページ取得とまったく同じゲート（文字列検査 + DNS 検査 + ホップ毎再検査 + 時間/サイズ上限）を通す。
 */
export async function safeFetchImage(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<SafeFetchImageResult> {
  const maxBytes = clamp(opts?.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);

  return guardedFetch<Extract<SafeFetchImageResult, { ok: true }>>(url, {
    // 画像は HTML より本文が大きいので、ページ既定の 4 秒だと大きめの商品写真で取りこぼす。
    timeoutMs: opts?.timeoutMs ?? 8000,
    accept: DECODABLE_IMAGE_TYPES.join(','),
    // 「image/ で始まる」では緩すぎる（260728 敵対レビュー M1）。
    // SVG/AVIF/GIF は Vision も Gemini も読めず、しかも Vision は HTTP 200 のまま
    // responses[0].error で失敗を返すので上位の !ok 判定に引っかからない。結果、
    // 課金だけ発生して最後に 500「しばらくして再度お試しください」という無意味な案内になる。
    // 両APIが確実に解釈できる形式だけを通し、それ以外はここで not-image にして
    // 「この画像は取得できませんでした」の穏当な案内へ流す。
    acceptContentType: (ct) => DECODABLE_IMAGE_TYPES.includes(ct.split(';')[0].trim()),
    wrongTypeReason: 'not-image',
    read: async (res, controller, finalUrl, status) => {
      const bytes = await readBytesCapped(res, maxBytes);
      // 上限超過は「切り詰め」ではなく失敗にする。途中で切れた画像は Vision も Gemini も読めない。
      if (!bytes) {
        controller.abort();
        return { ok: false, reason: 'too-large', status };
      }
      if (bytes.length === 0) return { ok: false, reason: 'not-image', status };
      const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
      return { ok: true, base64: toBase64(bytes), mimeType, finalUrl, status };
    },
  });
}

/**
 * 画像本文をストリームで読みつつ上限で打ち切る。上限超過は null（＝失敗）。
 * arrayBuffer() で一気に読むと、巨大画像 1 本で関数が OOM で落ちるため必ず数えながら読む。
 */
async function readBytesCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // ストリームが無い実装（fetch ポリフィル・テストダブル）向けのフォールバック。
    // arrayBuffer() は先に全量を確保してしまうので、宣言サイズで事前に弾く（260728 敵対レビュー L2）。
    // content-length が無い/嘘の場合に備え、確保後にもう一度確認する。
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength > maxBytes ? null : new Uint8Array(buf);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* 相手都合の失敗は無視 */
        }
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 解放済みなら無視 */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** バイト列 → base64。Node/ブラウザ双方で動くよう Buffer が無ければ手組みにフォールバックする。 */
function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let binary = '';
  // 一度に spread するとスタックが溢れるので分割する
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * ページ取得と画像取得で共通の「安全に 1 本取りに行く」部分。
 * SSRF ゲート（文字列検査・DNS 検査・リダイレクトのホップ毎再検査）とタイムアウトはここ 1 か所だけに置く。
 * 表を二重に持つと、必ず片方だけ直されて穴が開く。
 */
type GuardedFail = { ok: false; reason: SafeFetchFailReason; status?: number };

async function guardedFetch<TOk extends { ok: true }>(
  url: string,
  spec: {
    timeoutMs?: number;
    accept: string;
    acceptContentType: (contentType: string) => boolean;
    wrongTypeReason: SafeFetchFailReason;
    read: (res: Response, controller: AbortController, finalUrl: string, status: number) => Promise<TOk | GuardedFail>;
  },
): Promise<TOk | GuardedFail> {
  if (!isFetchableUrl(url)) return { ok: false, reason: 'blocked-url' };

  const timeoutMs = clamp(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const controller = new AbortController();
  // 遅い小売サイト 1 本で Vercel 関数を占有させない
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = url.trim();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // 文字列検査（isFetchableUrl）の下に敷く DNS 層。初回 URL も各リダイレクト先も、
      // 必ず「解決してアドレスを見てから」でないと fetch させない。
      // 注意: dns.lookup は AbortController で中断できないので、名前解決が固まると
      //       timeoutMs をわずかに超え得る（OS のリゾルバ側タイムアウト依存）。
      const dnsFail = await checkHostDns(current);
      if (dnsFail) return { ok: false, reason: dnsFail };

      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        // Cookie/Authorization は一切載せない（第三者サイトへ我々の資格情報を漏らさない）
        credentials: 'omit',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: spec.accept,
          'Accept-Language': 'ja,en;q=0.8',
        },
      });

      const status = res.status;

      if (REDIRECT_STATUSES.has(status)) {
        const location = res.headers.get('location');
        discardBody(res);
        if (!location) return { ok: false, reason: 'bad-status', status };
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { ok: false, reason: 'blocked-host', status };
        }
        // ここが SSRF の本丸。ホップ先を毎回検証し、内部アドレスなら「取得する前に」止める。
        if (!isFetchableUrl(next)) return { ok: false, reason: 'blocked-host', status };
        current = next;
        continue;
      }

      if (status < 200 || status >= 300) return { ok: false, reason: 'bad-status', status };

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!spec.acceptContentType(contentType)) {
        discardBody(res);
        return { ok: false, reason: spec.wrongTypeReason, status };
      }

      const finalUrl = typeof res.url === 'string' && res.url ? res.url : current;
      return await spec.read(res, controller, finalUrl, status);
    }

    // ここに来た＝4 リクエスト目もリダイレクトだった。ループ/無限リダイレクト対策として打ち切る。
    return { ok: false, reason: 'bad-status' };
  } catch (e) {
    if (isAbortLike(e) || controller.signal.aborted) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 複数ページを、同時実行数と本数の両方に上限を掛けて取得する。
 * エージェントの 1 応答が数十本の URL を吐いても、外部に投げるリクエストは limit 本までに抑える。
 * 入力順を保った配列を返し、**reject しない**（失敗は URL ごとに result で報告）。
 */
export async function safeFetchPages(
  urls: string[],
  opts?: { timeoutMs?: number; maxBytes?: number; concurrency?: number; limit?: number },
): Promise<Array<{ url: string; result: SafeFetchResult }>> {
  const limit = clamp(opts?.limit ?? DEFAULT_URL_LIMIT, 0, HARD_URL_LIMIT);
  const concurrency = clamp(opts?.concurrency ?? DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const targets = (Array.isArray(urls) ? urls : []).slice(0, limit);
  if (targets.length === 0) return [];

  const results = new Array<{ url: string; result: SafeFetchResult }>(targets.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      const target = targets[index];
      let result: SafeFetchResult;
      try {
        result = await safeFetchPage(target, {
          timeoutMs: opts?.timeoutMs,
          maxBytes: opts?.maxBytes,
        });
      } catch {
        // safeFetchPage は throw しない契約だが、契約が破れても全体を巻き込まない
        result = { ok: false, reason: 'network' };
      }
      results[index] = { url: target, result };
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return results;
}
