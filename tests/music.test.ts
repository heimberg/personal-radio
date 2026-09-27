import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiMusicWriter, SpotifyCatalog, matchesPick, normalizeMusic } from '../server/music.ts';
import { splitSpeech } from '../server/station.ts';

const sources = [{ id: 'w1', url: 'https://example.org/p', title: 'example.org', excerpt: 'Dummy erschien 1994.', publishedAt: '2026-09-27', retrievedAt: '2026-09-27' }];

test('track matching ignores case, accents, remaster suffixes and brackets but not the artist', () => {
  assert.equal(normalizeMusic('Glory Box - 2011 Remaster'), 'glory box');
  assert.equal(normalizeMusic('Roads (Live in Roseland)'), 'roads');
  assert.equal(normalizeMusic('Déjà Vu'), 'deja vu');
  assert.ok(matchesPick({ name: 'Glory Box - Remastered', artists: ['Portishead'] }, { title: 'Glory Box', artist: 'Portishead' }));
  assert.ok(matchesPick({ name: 'Sour Times (Nobody Loves Me)', artists: ['Portishead'] }, { title: 'Sour Times', artist: 'Portishead' }));
  assert.ok(!matchesPick({ name: 'Glory Box', artists: ['Some Tribute Band'] }, { title: 'Glory Box', artist: 'Portishead' }));
  assert.ok(!matchesPick({ name: 'Roads Less Travelled', artists: ['Other'] }, { title: 'Roads', artist: 'Portishead' }));
});

test('Spotify search uses an app token, resolves only matching tracks and refreshes an expired token', async () => {
  const calls: string[] = [];
  let tokens = 0, rejectOnce = true;
  const catalog = new SpotifyCatalog({ clientId: 'id', clientSecret: 'secret', market: 'CH' }, async (input, init) => {
    const url = String(input); calls.push(url);
    if (url === 'https://accounts.spotify.com/api/token') {
      tokens++;
      assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${btoa('id:secret')}`);
      assert.equal(init?.body, 'grant_type=client_credentials');
      return Response.json({ access_token: `t${tokens}`, expires_in: 3600 });
    }
    if (rejectOnce) { rejectOnce = false; return new Response('', { status: 401 }); }
    const query = new URL(url).searchParams;
    assert.equal(query.get('market'), 'CH'); assert.equal(query.get('type'), 'track');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer t2');
    return Response.json({ tracks: { items: [
      { uri: 'spotify:track:cover', name: 'Glory Box', duration_ms: 1, artists: [{ name: 'Tribute Band' }] },
      { uri: 'spotify:track:orig', name: 'Glory Box - Remastered', duration_ms: 305000, artists: [{ name: 'Portishead' }] },
    ] } });
  });
  assert.deepEqual(await catalog.find({ title: 'Glory Box', artist: 'Portishead' }), { uri: 'spotify:track:orig', durationMs: 305000 });
  assert.equal(tokens, 2);
  assert.match(new URL(calls.at(-1)!).searchParams.get('q')!, /^track:Glory Box artist:Portishead$/);
  const limited = new SpotifyCatalog({ clientId: 'id', clientSecret: 'secret' }, async input => String(input).includes('token')
    ? Response.json({ access_token: 't', expires_in: 3600 }) : new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
  await assert.rejects(limited.find({ title: 'x', artist: 'y' }), (error: any) => error.status === 429 && error.retryAfterMs === 30_000);
});

test('the Gemini music writer validates picks and scripts and drops unknown sources and indexes', async () => {
  const replies: unknown[] = [
    { tracks: [{ title: 'Glory Box', artist: 'Portishead', year: 1994, reason: 'Schlüsselsong' }, { title: '', artist: 'x' }, { title: 'Roads', reason: 'Stille' }] },
    { title: 'Portishead', intro: { text: 'Willkommen.', sourceIds: ['w1', 'erfunden'] },
      tracks: [{ index: 0, text: 'Glory Box erschien 1994.', sourceIds: ['w1'] }, { index: 7, text: 'Gibt es nicht.' }], outro: { text: 'Danke.', sourceIds: [] } },
  ];
  let body: any;
  const writer = new GeminiMusicWriter({ key: 'g' }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(replies.shift()) }] } }] });
  });
  const picks = await writer.pickTracks({ artist: 'Portishead', count: 2, sources, instructions: 'Frühwerk' });
  assert.deepEqual(picks, [{ title: 'Glory Box', artist: 'Portishead', reason: 'Schlüsselsong', year: 1994 }, { title: 'Roads', artist: 'Portishead', reason: 'Stille' }]);
  assert.match(body.systemInstruction.parts[0].text, /Wähle 6 Songs von «Portishead»/);
  const hour = await writer.writeHour({ artist: 'Portishead', picks, sources, talkSeconds: 60,
    direction: { persona: { name: 'Mira', tone: 'ruhig', style: 'Radio', instructions: '' } } });
  assert.match(body.systemInstruction.parts[0].text, /etwa 130 Wörtern/);
  assert.match(body.systemInstruction.parts[0].text, /Du sprichst als Mira/);
  assert.deepEqual(hour.intro, { text: 'Willkommen.', sourceIds: ['w1'] });
  assert.deepEqual(hour.tracks, [{ index: 0, text: 'Glory Box erschien 1994.', sourceIds: ['w1'] }]);
});

test('long moderations are split into parts Mistral can speak', () => {
  const sentence = 'Das ist ein Satz mit genau zehn Wörtern für den Test. ';
  const chunks = splitSpeech(sentence.repeat(60).trim(), 250);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => chunk.split(' ').length <= 250));
  assert.equal(chunks.join(' '), sentence.repeat(60).trim());
});
