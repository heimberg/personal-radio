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
  const picks = await writer.pickTracks({ focus: 'artist', subject: 'Portishead', count: 2, sources, instructions: 'Frühwerk' });
  assert.deepEqual(picks, [{ title: 'Glory Box', artist: 'Portishead', reason: 'Schlüsselsong', year: 1994 }, { title: 'Roads', artist: 'Portishead', reason: 'Stille' }]);
  assert.match(body.systemInstruction.parts[0].text, /Wähle 6 Songs von «Portishead»/);
  const hour = await writer.writeHour({ focus: 'artist', subject: 'Portishead', picks, sources, talkSeconds: 60,
    direction: { persona: { name: 'Mira', tone: 'ruhig', style: 'Radio', instructions: '' } } });
  assert.match(body.systemInstruction.parts[0].text, /etwa 130 Wörtern/);
  assert.match(body.systemInstruction.parts[0].text, /Du sprichst als Mira/);
  assert.deepEqual(hour.intro, { text: 'Willkommen.', sourceIds: ['w1'] });
  assert.deepEqual(hour.tracks, [{ index: 0, text: 'Glory Box erschien 1994.', sourceIds: ['w1'] }]);
});

test('genre and theme hours ask for songs by different artists and drop picks without an artist', async () => {
  const systems: string[] = [];
  const replies: unknown[] = [
    { subject: 'Krautrock', reason: 'r' },
    { tracks: [{ title: 'Hallogallo', artist: 'Neu!' }, { title: 'Ohne Künstler' }] },
    { tracks: [{ title: 'Space Oddity', artist: 'David Bowie' }] },
  ];
  const writer = new GeminiMusicWriter({ key: 'g' }, async (_url, init) => {
    systems.push(JSON.parse(String(init?.body)).systemInstruction.parts[0].text);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(replies.shift()) }] } }] });
  });
  assert.deepEqual(await writer.pickSubject({ focus: 'genre', interests: ['Elektronik'], avoid: [], instructions: '' }), { subject: 'Krautrock', reason: 'r' });
  assert.match(systems[0], /Genre-Stunde/);
  assert.deepEqual((await writer.pickTracks({ focus: 'genre', subject: 'Krautrock', count: 3, sources, instructions: '' })).map(pick => pick.title), ['Hallogallo']);
  assert.match(systems[1], /^Du stellst die Songliste einer Genre-Stunde zusammen\. Wähle 7 Songs, die das Genre «Krautrock»/);
  await writer.pickTracks({ focus: 'theme', subject: 'Der Mond', count: 3, sources, instructions: '' });
  assert.match(systems[2], /inhaltlich zum Thema «Der Mond» passen/);
});

test('music providers call fetch as a plain function, as Workers require', async () => {
  // Workers throw "Illegal invocation" when fetch runs with a foreign `this`; simulate that.
  function workerFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(String(input).includes('accounts.spotify.com')
      ? Response.json({ access_token: 't', expires_in: 3600 })
      : String(input).includes('api.spotify.com') ? Response.json({ tracks: { items: [] } })
      : Response.json({ candidates: [{ content: { parts: [{ text: '{"subject":"Krautrock","reason":"r"}' }] } }] }));
  }
  const writer = new GeminiMusicWriter({ key: 'g' }, workerFetch as typeof fetch);
  assert.equal((await writer.pickSubject({ focus: 'genre', interests: [], avoid: [], instructions: '' })).subject, 'Krautrock');
  const catalog = new SpotifyCatalog({ clientId: 'id', clientSecret: 'secret' }, workerFetch as typeof fetch);
  assert.equal(await catalog.find({ title: 'Hallogallo', artist: 'Neu!' }), null);
});

test('song picks: taste, reactions and avoid list go to Gemini; picks without artist are dropped; announcements only when wanted', async () => {
  let body: any;
  const writer = new GeminiMusicWriter({ key: 'g' }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ songs: [{ title: 'Closer', artist: 'Nine Inch Nails', announcement: 'Jetzt: Closer.' }, { title: 'Ohne' }] }) }] } }] });
  });
  const request = { taste: 'Industrial', interests: ['Raumfahrt'], avoid: ['A – B'], liked: ['C – D'], disliked: ['E – F'], announce: true, listens: ['Nine Inch Nails'],
    direction: { persona: { name: 'Mira', tone: 'lebhaft', style: 'Radio', instructions: '' } } };
  assert.deepEqual(await writer.pickSongs(request), [{ title: 'Closer', artist: 'Nine Inch Nails', announcement: 'Jetzt: Closer.' }]);
  const input = JSON.parse(body.contents[0].parts[0].text);
  assert.deepEqual([input.geschmack, input.hört, input.vermeiden, input.mag, input['mag nicht']], ['Industrial', ['Nine Inch Nails'], ['A – B'], ['C – D'], ['E – F']]);
  assert.match(body.systemInstruction.parts[0].text, /«hört» sind die Künstler/);
  assert.match(body.systemInstruction.parts[0].text, /höchstens 35 Wörtern[\s\S]*Du sprichst als Mira/);
  assert.equal((await writer.pickSongs({ ...request, announce: false }))[0].announcement, '');
});

test('long moderations are split into parts Mistral can speak', () => {
  const sentence = 'Das ist ein Satz mit genau zehn Wörtern für den Test. ';
  const chunks = splitSpeech(sentence.repeat(60).trim(), 250);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => chunk.split(' ').length <= 250));
  assert.equal(chunks.join(' '), sentence.repeat(60).trim());
});
