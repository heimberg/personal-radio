import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiMusicWriter, SpotifyCatalog, albumImage, matchesPick, normalizeMusic, parseHourScript } from '../server/music.ts';
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
      { uri: 'spotify:track:orig', name: 'Glory Box - Remastered', duration_ms: 305000, artists: [{ name: 'Portishead' }],
        album: { images: [{ url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'https://i.scdn.co/image/mid', width: 300 }, { url: 'https://i.scdn.co/image/small', width: 64 }] } },
    ] } });
  });
  // The album cover about 300 px wide comes along for the app.
  assert.deepEqual(await catalog.find({ title: 'Glory Box', artist: 'Portishead' }), { uri: 'spotify:track:orig', durationMs: 305000, imageUrl: 'https://i.scdn.co/image/mid' });
  assert.equal(tokens, 2);
  assert.match(new URL(calls.at(-1)!).searchParams.get('q')!, /^track:Glory Box artist:Portishead$/);
  const limited = new SpotifyCatalog({ clientId: 'id', clientSecret: 'secret' }, async input => String(input).includes('token')
    ? Response.json({ access_token: 't', expires_in: 3600 }) : new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
  await assert.rejects(limited.find({ title: 'x', artist: 'y' }), (error: any) => error.status === 429 && error.retryAfterMs === 30_000);
});

test('the Gemini music writer requires one moderation per song and drops unknown sources and indexes', async () => {
  const replies: unknown[] = [
    { tracks: [{ title: 'Glory Box', artist: 'Portishead', year: 1994, reason: 'Schlüsselsong' }, { title: '', artist: 'x' }, { title: 'Roads', reason: 'Stille' }] },
    { title: 'Portishead', intro: { text: 'Willkommen.', sourceIds: ['w1', 'erfunden'] },
      tracks: [{ index: 0, text: 'Glory Box erschien 1994.', sourceIds: ['w1'] }, { index: 1, text: 'Roads entstand als eigener Song.', sourceIds: ['erfunden'] }, { index: 7, text: 'Gibt es nicht.' }], outro: { text: 'Danke.', sourceIds: [] } },
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
  assert.match(body.systemInstruction.parts[0].text, /etwa 130 Wörter/);
  assert.match(body.systemInstruction.parts[0].text, /Du sprichst als Mira/);
  assert.doesNotMatch(body.systemInstruction.parts[0].text, /keine Quellen geliefert/);
  assert.deepEqual(hour.intro, { text: 'Willkommen.', sourceIds: ['w1'] });
  assert.deepEqual(hour.tracks, [{ index: 0, text: 'Glory Box erschien 1994.', sourceIds: ['w1'] }, { index: 1, text: 'Roads entstand als eigener Song.', sourceIds: [] }]);
  assert.match(body.systemInstruction.parts[0].text, /genau 2 Einträge mit index 0 bis 1/);
});

test('hour scripts tolerate 1-based, duplicate and a few missing moderations, but not a broken script', () => {
  const frame = { title: 'T', intro: { text: 'Hallo.', sourceIds: ['w1', 'erfunden'] }, outro: { text: 'Tschüss.', sourceIds: [] } };
  const names = ['A', 'B', 'C', 'D', 'E', 'F'].map(title => ({ title, artist: 'X' }));
  const moderation = (index: number, text = `Song ${index}.`) => ({ index, text, sourceIds: ['w1'] });
  // Counted from 1: shifted to 0.
  const oneBased = parseHourScript({ ...frame, tracks: [1, 2, 3].map(index => moderation(index)) }, 3, ['w1'], 'F');
  assert.deepEqual(oneBased.tracks.map(track => [track.index, track.text]), [[0, 'Song 1.'], [1, 'Song 2.'], [2, 'Song 3.']]);
  assert.deepEqual(oneBased.intro.sourceIds, ['w1']);
  // A duplicate index keeps the first entry; the missing song gets a plain announcement.
  const gap = parseHourScript({ ...frame, tracks: [moderation(0), moderation(1), moderation(1, 'doppelt'), moderation(3), moderation(4), moderation(5)] }, 6, ['w1'], 'F', names);
  assert.equal(gap.tracks[1].text, 'Song 1.');
  assert.deepEqual(gap.tracks[2], { text: 'Als Nächstes: «C» von X.', sourceIds: [], index: 2 });
  // Entries without an index take their position.
  const unnumbered = parseHourScript({ ...frame, tracks: [{ text: 'Erster.' }, { text: 'Zweiter.' }] }, 2, [], 'F');
  assert.deepEqual(unnumbered.tracks.map(track => track.text), ['Erster.', 'Zweiter.']);
  // Without names, with too many gaps or without the frame, the script is rejected.
  assert.throws(() => parseHourScript({ ...frame, tracks: [moderation(0)] }, 2, [], 'F'), /1 of 2/);
  assert.throws(() => parseHourScript({ ...frame, tracks: [moderation(0), moderation(1)] }, 6, [], 'F', names), /2 of 6/);
  assert.throws(() => parseHourScript({ ...frame, intro: null, tracks: [moderation(0)] }, 1, [], 'F', names), /no intro/);
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
  assert.match(body.systemInstruction.parts[0].text, /«hört» ist eine Auswahl der Künstler.*Höchstens ein Viertel.*Mische bewusst breit/);
  assert.match(body.systemInstruction.parts[0].text, /keine Künstler aus «zuletzt gespielt»\. Jeder Künstler höchstens einmal/);
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

test('playlist tracks: owner token or app token, /items with fallback to /tracks, pages, local and broken entries skipped', async () => {
  const seen: string[] = [];
  let itemsMissing = true;
  const catalog = new SpotifyCatalog({ clientId: 'id', clientSecret: 'secret' }, async (input, init) => {
    const url = String(input);
    if (url === 'https://accounts.spotify.com/api/token') return Response.json({ access_token: 'app', expires_in: 3600 });
    seen.push(`${new Headers(init?.headers).get('Authorization')} ${url.replace('https://api.spotify.com/v1/playlists/37i9dQZF1DX4sWSpwq3LiO/', '')}`);
    if (url.includes('/items') && itemsMissing) return new Response('', { status: 404 });
    if (url.includes('offset=100')) return Response.json({ items: [{ track: { uri: 'spotify:track:c', name: 'C', duration_ms: 3, artists: [{ name: 'Z' }] } }], next: null });
    return Response.json({ next: 'https://api.spotify.com/v1/playlists/37i9dQZF1DX4sWSpwq3LiO/tracks?offset=100', items: [
      { track: { uri: 'spotify:track:a', name: 'A', duration_ms: 1, artists: [{ name: 'X' }, { name: 'Y' }] } },
      { track: { uri: 'spotify:local:x', name: 'Lokal', duration_ms: 2, is_local: true, artists: [] } },
      { track: null },
      { item: { uri: 'spotify:track:b', name: 'B', duration_ms: 2, artists: [{ name: 'Y' }] } },
    ] });
  });
  assert.deepEqual(await catalog.playlistTracks('37i9dQZF1DX4sWSpwq3LiO', 'owner'), [
    { uri: 'spotify:track:a', title: 'A', artist: 'X, Y', durationMs: 1 }, { uri: 'spotify:track:b', title: 'B', artist: 'Y', durationMs: 2 },
    { uri: 'spotify:track:c', title: 'C', artist: 'Z', durationMs: 3 },
  ]);
  assert.deepEqual(seen, ['Bearer owner items?limit=100&market=CH', 'Bearer owner tracks?limit=100&market=CH', 'Bearer owner tracks?offset=100']);
  itemsMissing = false; seen.length = 0;
  assert.equal((await catalog.playlistTracks('37i9dQZF1DX4sWSpwq3LiO')).length, 3);
  assert.deepEqual(seen.map(call => call.split(' ').slice(1, 3).join(' ')), ['app items?limit=100&market=CH', 'app tracks?offset=100']);
  await assert.rejects(catalog.playlistTracks('../x'), /invalid playlist id/);
});

test('block moderation: one text per moment, only the AI\'s own picks are named, missing texts stay empty', async () => {
  let body: any;
  const writer = new GeminiMusicWriter({ key: 'g' }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ moderationen: [{ index: 1, text: 'Weiter mit Neu!' }, { index: 0, text: 'Guten Morgen.' }, { index: 7, text: 'x' }] }) }] } }] });
  });
  const texts = await writer.writeBlock({ blockName: 'Morgenmusik', groups: ['Kaffee', 'Entdeckungen'], nextShow: 'Kurzbeitrag', daytime: 'Morgen', talkSeconds: 20,
    moments: [{ triggers: ['block_start'] }, { triggers: ['group_transition', 'before_track'], fromGroup: 'Kaffee', toGroup: 'Entdeckungen', next: { artist: 'Neu!', title: 'Hallogallo' } }, { triggers: ['block_end'] }],
    direction: { persona: { name: 'Mira', tone: 'lebhaft', style: 'Radio', instructions: '' } } });
  assert.deepEqual(texts, ['Guten Morgen.', 'Weiter mit Neu!', '']);
  const input = JSON.parse(body.contents[0].parts[0].text);
  assert.deepEqual(input.momente[1], { index: 1, anlässe: ['group_transition', 'before_track'], danach: { artist: 'Neu!', title: 'Hallogallo' }, von: 'Kaffee', nach: 'Entdeckungen' });
  assert.equal(input['nächste Sendung'], 'Kurzbeitrag');
  assert.match(body.systemInstruction.parts[0].text, /über andere Songs weisst du nichts[\s\S]*Du sprichst als Mira/);
});

test('album covers come only from Spotify\'s image CDN', () => {
  assert.equal(albumImage([{ url: 'https://i.scdn.co/image/abc', width: 640 }]), 'https://i.scdn.co/image/abc');
  assert.equal(albumImage([{ url: 'https://evil.example/image/abc', width: 300 }]), undefined);
  assert.equal(albumImage([{ url: 'http://i.scdn.co/image/abc' }]), undefined);
  assert.equal(albumImage('nope'), undefined);
  assert.equal(albumImage([]), undefined);
});

test('artists rotate: the last tracks\' artists wait, top artists come in a different handful each time', async () => {
  const { recentArtists, rotateListens, ARTIST_GAP, LISTENS_PER_PICK } = await import('../server/station/music.ts');
  const rows = [
    { script_json: JSON.stringify({ kind: 'song', parts: [{ kind: 'track', artist: 'The Notwist', title: 'a' }] }) },
    { script_json: JSON.stringify({ kind: 'music_block', parts: [{ kind: 'track', artist: 'Privat', title: 'p', picked: 'playlist' }, { kind: 'track', artist: 'Björk', title: 'b', picked: 'ai' }] }) },
  ];
  const deps = { store: { recentItems: async () => rows } } as never;
  const recent = await recentArtists(deps, 'o');
  assert.deepEqual([...recent.all].sort(), ['bjork', 'notwist', 'privat']);
  assert.deepEqual(recent.named, ['Björk', 'The Notwist'], 'playlist artists are never named to the AI');
  const top = Array.from({ length: 30 }, (_, index) => `Artist ${index}`);
  const one = rotateListens(['Björk', ...top], recent.all, () => 0.1), two = rotateListens(['Björk', ...top], recent.all, () => 0.9);
  assert.equal(one.length, LISTENS_PER_PICK);
  assert.ok(!one.includes('Björk'));
  assert.notDeepEqual(one, two);
  // Only played artists left: they come back rather than nothing.
  assert.deepEqual(rotateListens(['Björk'], recent.all, () => 0.5), ['Björk']);
  assert.ok(ARTIST_GAP >= 20);
});
