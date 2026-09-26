import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed, FeedError } from '../server/feed.ts';

const response = (xml: string, type = 'application/rss+xml') => new Response(xml, { headers: { 'Content-Type': type } });

test('RSS feed returns bounded, sanitized headlines and excerpts with normalized HTTPS links', async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Bern &amp; Umgebung</title><link>/news/1</link><description><![CDATA[<p>Text &amp; Kontext</p>]]></description><pubDate>Fri, 25 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
  let options: RequestInit | undefined;
  const items = await fetchFeed('https://news.example.test/feed.xml', async (_url, init) => { options = init; return response(xml); });
  assert.deepEqual(options && { method: options.method, redirect: options.redirect }, { method: 'GET', redirect: 'error' });
  assert.equal(items[0].title, 'Bern & Umgebung');
  assert.equal(items[0].url, 'https://news.example.test/news/1');
  assert.equal(items[0].excerpt, 'Text & Kontext');
  assert.equal(items[0].publishedAt, '2026-09-25T12:00:00.000Z');
});

test('Atom link and dates are supported; non-HTTPS article links are discarded', async () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Aktuelles</title><link href="https://news.example.test/media.mp3" rel="enclosure"/><link href="https://news.example.test/1" rel="alternate"/><summary>Ein Ausschnitt</summary><updated>2026-09-25T10:00:00Z</updated></entry><entry><title>unsicher</title><link href="http://news.example.test/2"/><summary>Text</summary></entry></feed>`;
  const items = await fetchFeed('https://news.example.test/atom.xml', async () => response(xml, 'application/atom+xml'));
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://news.example.test/1');
});

test('arbitrary URL rejects local, insecure and credential-bearing targets before fetch', async () => {
  let calls = 0;
  const f = async () => { calls++; return response('<rss/>'); };
  for (const url of ['http://news.example.test/feed', 'https://127.0.0.1/feed', 'https://localhost/feed', 'https://u:p@news.example.test/feed', 'https://internal.local/feed']) {
    await assert.rejects(fetchFeed(url, f), FeedError);
  }
  assert.equal(calls, 0);
});

test('rejects redirects, non-XML responses, entity declarations and oversized payloads', async () => {
  await assert.rejects(fetchFeed('https://news.example.test/feed', async () => { throw new Error('redirect'); }), /FEED_UNAVAILABLE/);
  await assert.rejects(fetchFeed('https://news.example.test/feed', async () => new Response('no', { headers: { 'Content-Type': 'text/html' } })), /FEED_INVALID/);
  await assert.rejects(fetchFeed('https://news.example.test/feed', async () => response('<!DOCTYPE rss [<!ENTITY x "boom">]><rss/>')), /FEED_INVALID/);
  const tooLarge = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(512_001)); c.close(); } }), { headers: { 'Content-Type': 'application/rss+xml' } });
  await assert.rejects(fetchFeed('https://news.example.test/feed', async () => tooLarge), /FEED_TOO_LARGE/);
});
