export interface FeedItem {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  publishedAt: string;
}

export class FeedError extends Error {
  readonly code: 'INVALID_FEED_URL' | 'FEED_UNAVAILABLE' | 'FEED_TOO_LARGE' | 'FEED_INVALID';
  constructor(code: FeedError['code']) {
    super(code);
    this.code = code;
  }
}

const MAX_BYTES = 512_000;
const MAX_ITEMS = 20;

function validateFeedUrl(input: unknown): URL {
  if (typeof input !== 'string' || input.length > 2048) throw new FeedError('INVALID_FEED_URL');
  let url: URL;
  try { url = new URL(input); } catch { throw new FeedError('INVALID_FEED_URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || /^\d+(?:\.\d+){3}$/.test(host) || host.startsWith('[') ||
      host === 'metadata.google.internal' || host.endsWith('.workers.dev')) {
    throw new FeedError('INVALID_FEED_URL');
  }
  url.hash = '';
  return url;
}

async function readBounded(response: Response): Promise<string> {
  const statedLength = Number(response.headers.get('Content-Length') ?? 0);
  if (statedLength > MAX_BYTES) throw new FeedError('FEED_TOO_LARGE');
  if (!response.body) throw new FeedError('FEED_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); throw new FeedError('FEED_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function decodeXml(value: string): string {
  const codePoint = (value: string, radix: number) => {
    const code = parseInt(value, radix);
    return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
  };
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => codePoint(n, 10))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => codePoint(n, 16))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function itemsFromXml(xml: string, feedUrl: URL, now: Date): FeedItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new FeedError('FEED_INVALID');
  const isAtom = /<feed\b/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi : /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].slice(0, MAX_ITEMS);
  const used = new Set<string>();
  return blocks.flatMap((match, index) => {
    const block = match[1];
    const title = tag(block, 'title').slice(0, 300);
    let link = '';
    if (isAtom) {
      const links = [...block.matchAll(/<link\b([^>]*)\/?\s*>/gi)];
      const preferred = links.find(x => /\brel=["']alternate["']/i.test(x[1]))
        ?? links.find(x => !/\brel=["']/i.test(x[1])) ?? links[0];
      link = preferred?.[1].match(/\bhref=["']([^"']+)["']/i)?.[1] ?? '';
    } else link = tag(block, 'link') || tag(block, 'guid');
    let resolved: URL;
    try { resolved = new URL(link, feedUrl); } catch { return []; }
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password) return [];
    const excerpt = tag(block, isAtom ? 'summary' : 'description').slice(0, 12_000);
    const dateText = tag(block, isAtom ? 'published' : 'pubDate') || tag(block, 'updated') || tag(block, 'dc:date');
    const parsed = Date.parse(dateText);
    if (!title || !excerpt || used.has(resolved.href)) return [];
    used.add(resolved.href);
    return [{ id: `feed-${index + 1}`, title, url: resolved.href, excerpt,
      publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : now.toISOString() }];
  });
}

export async function fetchFeed(input: unknown, fetcher: typeof fetch = fetch, now = new Date()): Promise<FeedItem[]> {
  const url = validateFeedUrl(input);
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
  } catch { throw new FeedError('FEED_UNAVAILABLE'); }
  if (!response.ok) throw new FeedError('FEED_UNAVAILABLE');
  const type = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!(type.includes('xml') || type.includes('rss') || type.includes('atom'))) throw new FeedError('FEED_INVALID');
  return itemsFromXml(await readBounded(response), url, now);
}
