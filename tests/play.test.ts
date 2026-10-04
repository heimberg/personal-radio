import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Profile, Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import { addBlock, answerQuiz, chooseStory, produceItem, startSeries, tick, toView } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { blockViews } from '../src/domain/blocks.ts';
import { STICKERS, drawSticker, parseChoice, parseQuiz, quizSpeech } from '../src/domain/play.ts';
import { PlayStore, albumView } from '../server/play.ts';
import { forKids } from '../server/listeners.ts';
import { linkerSystem } from '../server/linker.ts';
import { sqliteD1 } from './d1-sqlite.ts';
import { realPipeline } from './real-pipeline.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';

const OWNER = 'listener:nina';
const NOW = new Date('2026-10-01T08:00:00Z');
const profile: Profile = { topics: ['Wissenschaft'], interests: ['Weltall'], interestWeights: {}, speechMinutes: 2, exploration: 0 };
const outline = (count: number) => ({ title: 'Fini im Zauberwald', episodes: Array.from({ length: count }, (_, i) => ({ title: `Kapitel ${i + 1}`, idea: `Station ${i + 1} auf dem Weg.` })) });
const CHOICE = { question: 'Wohin geht Fini?', options: [{ label: 'In die dunkle Höhle', emoji: '🕳️' }, { label: 'Zum glitzernden See', emoji: '🌊' }] };
const QUIZ = { question: 'Wie heisst der grösste Planet?', options: ['Mars', 'Jupiter', 'Venus'], correct: 1 };

function station(kids: boolean) {
  const base = defaultStationConfig({ profile, feeds: [] });
  base.music = { ...base.music, between: 0 }; base.surprise = 0;
  base.schedule = [{ id: 'nie', days: [0], from: '03:00', to: '03:30', showIds: ['entdecken'] }];
  const config = parseStationConfig(base);
  return kids ? forKids(config) : config;
}

function harness(kids = true) {
  // A child's station reads its settings through the kids' rules, as the Worker does.
  const db = sqliteD1(), store = new StationStore(db, kids ? forKids : undefined);
  let ids = 0, now = NOW;
  const asked: Array<{ system: string; input: any }> = [], drafts: Array<{ sources: Source[]; direction?: EditorialDirection }> = [];
  const voiced: Script[] = [];
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => now, random: () => 0.99, newId: () => `id-${++ids}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    agentModel: { askJson: async (system, input) => {
      asked.push({ system, input });
      if (system.includes('Mitmach-Geschichte im Radio')) return CHOICE;
      if (system.includes('Quizfrage')) return QUIZ;
      return outline(Number(/genau (\d+) Folgen/.exec(system)?.[1] ?? 3));
    } },
    researcher: { research: async () => ({ sources: [{ id: 's1', url: 'https://example.test/a', title: 'Quelle', excerpt: 'Jupiter ist der grösste Planet.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }], queries: [] }) },
    pipeline: {
      draft: async (_profile, sources, _mode, direction): Promise<Script> => {
        drafts.push({ sources, direction });
        return { title: `Kapitel ${drafts.length}`, text: `Text von Kapitel ${drafts.length}.`, sourceIds: [sources[0].id], interestTags: [] };
      },
      review: async () => ({ approved: true, reasons: [] }),
      voice: async (_owner, script) => { voiced.push(script); return { audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 1 }; },
    },
  };
  const config = station(kids);
  const plain = station(false);
  const items = async () => (await store.recentItems(OWNER, 50)).filter(row => row.show_id.startsWith('_series:'));
  return { db, store, deps, asked, drafts, voiced, config, items, setup: () => store.saveConfig(OWNER, plain, NOW), later: (hours: number) => { now = new Date(NOW.getTime() + hours * 3_600_000); } };
}

test('a Mitmach-Geschichte ends each episode with a choice, waits for it, and the next episode follows it', async () => {
  const h = harness(); await h.setup();
  assert.ok(blockViews(h.config).some(block => block.id === 'mitmach'));
  const firstId = (await addBlock(h.deps, OWNER, 'mitmach', '🦊 ein schlauer Fuchs, im Zauberwald'))!;
  assert.match(h.asked[0].system, /Mitmach-Geschichte: wiederkehrende Figuren/);
  let [series] = await h.store.listSeries(OWNER);
  assert.equal(series.interactive, true);

  // Episode 1: the choice is planned first (from our own outline), and the episode ends with it.
  assert.equal(await produceItem(h.deps, OWNER, firstId), 'ready');
  assert.match(h.asked[1].system, /zwei klar verschiedene/);
  assert.deepEqual(h.asked[1].input.naechsteFolge, { title: 'Kapitel 2', idea: 'Station 2 auf dem Weg.' });
  assert.match(h.drafts[0].direction?.instructions ?? '', /Beende die Folge mit dieser Frage an die Hörerin: «Wohin geht Fini\?».*«In die dunkle Höhle» oder «Zum glitzernden See».*in der App wählen/);
  let view = toView((await h.store.getItem(OWNER, firstId))!, h.config);
  assert.deepEqual(view.choice, CHOICE);

  // Heard, but nobody chose yet: the story waits.
  await h.store.update(OWNER, firstId, { state: 'played' }, NOW);
  await tick(h.deps, OWNER);
  assert.equal((await h.items()).length, 1);

  // The listener chooses the lake: the next episode joins the program and follows the choice.
  assert.deepEqual(await chooseStory(h.deps, OWNER, firstId, 1), { choice: { ...CHOICE, picked: 1, by: 'listener' }, fresh: true });
  assert.equal((await chooseStory(h.deps, OWNER, firstId, 0))?.fresh, false); // Chosen once only.
  view = toView((await h.store.getItem(OWNER, firstId))!, h.config);
  assert.equal(view.choice?.picked, 1);
  await tick(h.deps, OWNER);
  const second = (await h.items()).find(row => row.id !== firstId)!;
  assert.equal(await produceItem(h.deps, OWNER, second.id), 'ready');
  assert.match(h.drafts[1].direction?.instructions ?? '', /hat die Hörerin gewählt: «Zum glitzernden See»/);

  // Nobody chooses after episode 2: after three hours the narrator decides and the story goes on.
  await h.store.update(OWNER, second.id, { state: 'played' }, NOW);
  h.later(2); await tick(h.deps, OWNER);
  assert.equal((await h.items()).length, 2);
  h.later(4); await tick(h.deps, OWNER);
  [series] = await h.store.listSeries(OWNER);
  assert.equal(series.choices?.[1]?.by, 'narrator');
  const third = (await h.items()).find(row => row.state === 'planned')!;
  assert.equal(await produceItem(h.deps, OWNER, third.id), 'ready');
  assert.match(h.drafts[2].direction?.instructions ?? '', /niemand hat gewählt, also entscheidet die Erzählerin: «Zum glitzernden See»/);
  assert.ok(toView((await h.store.getItem(OWNER, third.id))!, h.config).choice);
});

test('the last episode of a Mitmach-Geschichte closes the story without a choice', async () => {
  const h = harness(); await h.setup();
  const { itemId } = await startSeries(h.deps, OWNER, h.config, 'geschichte', 'ein Fuchs', 3, true);
  assert.equal(await produceItem(h.deps, OWNER, itemId), 'ready');
  await chooseStory(h.deps, OWNER, itemId, 0);
  await h.store.update(OWNER, itemId, { state: 'played' }, NOW);
  await tick(h.deps, OWNER);
  const second = (await h.items()).find(row => row.state === 'planned')!;
  assert.equal(await produceItem(h.deps, OWNER, second.id), 'ready');
  await chooseStory(h.deps, OWNER, second.id, 1);
  await h.store.update(OWNER, second.id, { state: 'played' }, NOW);
  await tick(h.deps, OWNER);
  const last = (await h.items()).find(row => row.state === 'planned')!;
  const asked = h.asked.length;
  assert.equal(await produceItem(h.deps, OWNER, last.id), 'ready');
  assert.equal(h.asked.length, asked); // No choice planned.
  assert.match(h.drafts[2].direction?.instructions ?? '', /letzte Folge/);
  assert.equal(toView((await h.store.getItem(OWNER, last.id))!, h.config).choice, undefined);
  assert.equal(await chooseStory(h.deps, OWNER, last.id, 0), null);
});

test('a plain story and a knowledge series offer no choice', async () => {
  const h = harness(false); await h.setup();
  const { itemId } = await startSeries(h.deps, OWNER, h.config, 'geschichte', 'ein Drache', 3);
  assert.equal(await produceItem(h.deps, OWNER, itemId), 'ready');
  assert.equal(h.asked.length, 1);
  assert.match(h.drafts[0].direction?.instructions ?? '', /Ausblick auf die nächste Folge/);
});

test('on a child\'s station a knowledge item ends with a spoken quiz; the answer is revealed once answered', async () => {
  const h = harness(); await h.setup();
  const { itemId } = await startSeries(h.deps, OWNER, h.config, 'wissen', 'Planeten', 3);
  assert.equal(await produceItem(h.deps, OWNER, itemId), 'ready');
  const quizAsk = h.asked.find(ask => ask.system.includes('Quizfrage'))!;
  assert.equal(quizAsk.input.text, 'Text von Kapitel 1.');
  assert.match(h.voiced[0].text, /Text von Kapitel 1\. Und jetzt die Quizfrage: Wie heisst der grösste Planet\? Ist es A: Mars, B: Jupiter, oder C: Venus\? Tipp deine Antwort in der App an!$/);
  let view = toView((await h.store.getItem(OWNER, itemId))!, h.config);
  assert.deepEqual(view.quiz, { question: QUIZ.question, options: QUIZ.options });

  assert.deepEqual(await answerQuiz(h.deps, OWNER, itemId, 0), { quiz: { ...QUIZ, answered: 0 }, right: false, fresh: true });
  assert.equal((await answerQuiz(h.deps, OWNER, itemId, 1))?.fresh, false); // One try.
  view = toView((await h.store.getItem(OWNER, itemId))!, h.config);
  assert.deepEqual(view.quiz, { question: QUIZ.question, options: QUIZ.options, answered: 0, correct: 1 });
  assert.equal(await answerQuiz(h.deps, OWNER, itemId, 7), null);

  // Not a child's station: no quiz.
  const adult = harness(false); await adult.setup();
  const plain = await startSeries(adult.deps, OWNER, adult.config, 'wissen', 'Planeten', 3);
  assert.equal(await produceItem(adult.deps, OWNER, plain.itemId), 'ready');
  assert.ok(!adult.asked.some(ask => ask.system.includes('Quizfrage')));
  assert.equal(toView((await adult.store.getItem(OWNER, plain.itemId))!, adult.config).quiz, undefined);
});

test('choices and quizzes are only taken in a usable shape', () => {
  assert.equal(parseChoice({ question: 'Wohin?', options: [{ label: 'Links', emoji: '⬅️' }] }), null);
  assert.equal(parseChoice({ question: 'Wohin?', options: [{ label: 'Links' }, { label: 'Links' }] }), null);
  assert.deepEqual(parseChoice({ question: ' Wohin <laugh>? ', options: [{ label: 'Links', emoji: 'abc' }, { label: 'Rechts', emoji: '➡️' }] }),
    { question: 'Wohin laugh?', options: [{ label: 'Links', emoji: '🅰️' }, { label: 'Rechts', emoji: '➡️' }] });
  assert.equal(parseQuiz({ question: 'Was?', options: ['a', 'a', 'b'], correct: 0 }), null);
  assert.equal(parseQuiz({ question: 'Was?', options: ['a', 'b', 'c'], correct: 3 }), null);
  assert.match(quizSpeech(parseQuiz(QUIZ)!), /^Und jetzt die Quizfrage/);
});

test('stickers fill the album without repeats; questions wait for the next transition', async () => {
  const play = new PlayStore(sqliteD1());
  let draws = 0;
  for (let i = 0; i < 3; i++) await play.award(OWNER, 'quiz', NOW, () => (draws++ % 2) * 0.5);
  const earned = await play.stickers(OWNER);
  assert.equal(new Set(earned.map(sticker => sticker.id)).size, 3);
  const album = albumView(earned);
  assert.equal(album.total, STICKERS.length);
  assert.equal(album.count, 3);
  assert.equal(album.stickers.filter(sticker => 'at' in sticker).length, 3);
  assert.equal(drawSticker(STICKERS.map(sticker => sticker.id), () => 0).id, STICKERS[0].id); // A full album repeats.
  assert.equal(new Set(STICKERS.map(sticker => sticker.id)).size, STICKERS.length);

  const id = await play.addQuestion(OWNER, 'Warum ist der Himmel blau?', NOW);
  assert.deepEqual({ ...await play.pendingQuestion(OWNER, NOW) }, { id, text: 'Warum ist der Himmel blau?' });
  assert.equal(await play.pendingQuestion('listener:else', NOW), null);
  assert.equal(await play.pendingQuestion(OWNER, new Date(NOW.getTime() + 3 * 86_400_000)), null);
  await play.answered(id, 'Weil das Licht …', NOW);
  assert.equal(await play.pendingQuestion(OWNER, NOW), null);
  assert.deepEqual((await play.questions(OWNER)).map(question => question.answer), ['Weil das Licht …']);

  const config = station(true);
  assert.match(linkerSystem(config, false, false, true), /beantwortest du eine Frage.*Vornamen.*ehrlich.*höchstens 140 Wörter/);
  assert.doesNotMatch(linkerSystem(config, false), /question/);
});

test('Mitmachen through the Worker: a question answered in the next transition, quiz and stickers, the summary in the timeline', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'kp', alg: 'RS256', use: 'sig' });
  const team = 'play-test.cloudflareaccess.com', aud = 'play-aud', ORIGIN = 'https://private.example';
  const sign = (name: string) => new SignJWT({ type: 'app', common_name: name }).setProtectedHeader({ alg: 'RS256', kid: 'kp' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const linkerAsks: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    if (url.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(String(init?.body));
      linkerAsks.push({ system: body.systemInstruction.parts[0].text, input: body.contents[0].parts[0].text });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: 'Nina will wissen, warum der Himmel blau ist: Das Sonnenlicht wird gestreut. Und jetzt geht es weiter.' }) }] } }] });
    }
    if (url.endsWith('/v1/audio/speech')) return Response.json({ audio_data: 'SUQz' });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: Uint8Array) => { objects.set(key, value); }, delete: async (key: string) => { objects.delete(key); },
    get: async (key: string) => { const value = objects.get(key); return value ? { body: new Blob([value as Uint8Array<ArrayBuffer>]).stream(), size: value.length, httpEtag: '"e"' } : null; },
    list: async () => ({ objects: [] }),
  };
  const db = sqliteD1();
  const env = { DB: db, AUDIO: bucket, PRODUCTION: { send: async () => {} }, ASSETS: { fetch: async () => new Response('app') },
    ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'owner@example.test', ACCESS_SERVICE_TOKEN_ID: 'radio-app.access',
    LISTENERS: 'nina-app.access=nina:kids', GEMINI_API_KEY: 'gemini', MISTRAL_API_KEY: 'mistral', MISTRAL_VOICE_ID: 'voice' };
  const tokens = { owner: await sign('radio-app.access'), nina: await sign('nina-app.access') };
  const call = (who: keyof typeof tokens, path: string, body?: unknown) => worker.fetch(new Request(`${ORIGIN}${path}`, body === undefined
    ? { headers: { 'Cf-Access-Jwt-Assertion': tokens[who] } }
    : { method: 'POST', body: JSON.stringify(body), headers: { 'Cf-Access-Jwt-Assertion': tokens[who], Origin: ORIGIN, 'Content-Type': 'application/json' } }), env as never);
  try {
    const store = new StationStore(db);
    for (const owner of ['owner@example.test', 'listener:nina']) await store.saveConfig(owner, parseStationConfig(defaultStationConfig({ voiceId: 'voice-test' })), NOW);
    const nina = 'listener:nina';
    await store.insertItem(nina, { id: 'wissen-1', seq: 1, showId: '_block:hintergrund', plannedAt: NOW.toISOString(), estimatedMinutes: 5 }, NOW);
    await store.update(nina, 'wissen-1', { state: 'ready', audio_key: 'segments/wissen-1.mp3', content_type: 'audio/mpeg', research_json: JSON.stringify({ quiz: QUIZ }),
      script_json: JSON.stringify({ title: 'Planeten', text: 'Text.', sourceIds: [] }), sources_json: '[]' }, NOW);
    await store.insertItem(nina, { id: 'folge-1', seq: 2, showId: '_series:abc', plannedAt: NOW.toISOString(), estimatedMinutes: 6 }, NOW);
    await store.update(nina, 'folge-1', { state: 'ready', audio_key: 'segments/folge-1.mp3', content_type: 'audio/mpeg',
      research_json: JSON.stringify({ series: 'abc', episode: 0, total: 3, seriesTitle: 'Fini', kind: 'geschichte' }),
      script_json: JSON.stringify({ title: 'Kapitel 1', text: 'Es war einmal.', sourceIds: [] }), sources_json: '[]' }, NOW);

    // The timeline tells the app what Mitmachen offers.
    const timeline = async (who: keyof typeof tokens) => (await (await call(who, '/api/timeline?peek=1')).json()) as any;
    assert.deepEqual((await timeline('nina')).play, { stickers: 0, kids: true, ask: true });
    assert.equal((await timeline('owner')).play.kids, false);
    const listed = (await timeline('nina')).items.find((item: any) => item.id === 'wissen-1');
    assert.deepEqual(listed.quiz, { question: QUIZ.question, options: QUIZ.options });

    // Quiz: the right answer earns a sticker, once.
    const answer = await call('nina', '/api/timeline/wissen-1/quiz', { option: 1 });
    const answered = (await answer.json()) as any;
    assert.equal(answered.right, true); assert.equal(answered.correct, 1); assert.ok(STICKERS.some(sticker => sticker.id === answered.sticker.id));
    assert.equal(((await (await call('nina', '/api/timeline/wissen-1/quiz', { option: 1 })).json()) as any).sticker, undefined);
    assert.equal((await call('nina', '/api/timeline/wissen-1/quiz', { option: 'b' })).status, 400);
    assert.equal((await call('nina', '/api/timeline/folge-1/quiz', { option: 1 })).status, 409);
    assert.equal((await call('nina', '/api/timeline/folge-1/choice', { option: 1 })).status, 409); // no choice in this episode

    // An episode heard to the end earns a sticker on a child's station.
    const heard = await call('nina', '/api/timeline/folge-1/feedback', { action: 'complete', listenedRatio: 1 });
    assert.ok(((await heard.json()) as any).sticker);
    const album = (await (await call('nina', '/api/stickers')).json()) as any;
    assert.equal(album.count, 2); assert.equal(album.total, STICKERS.length);
    assert.equal((await timeline('nina')).play.stickers, 2);
    assert.equal(((await (await call('owner', '/api/stickers')).json()) as any).count, 0);

    // «Frag das Radio»: in the family chat right away, answered in Nina's next live transition with her name.
    assert.equal((await call('nina', '/api/questions', { text: '  Warum ist der   Himmel blau? ' })).status, 200);
    assert.equal((await call('nina', '/api/questions', { text: 'x' })).status, 400);
    const chat = (await (await call('owner', '/api/family')).json()) as any;
    assert.deepEqual(chat.messages.at(-1), { ...chat.messages.at(-1), fromName: 'Nina', text: '❓ Frage ans Radio: Warum ist der Himmel blau?' });
    const link = await call('nina', '/api/linker?after=wissen-1&next=folge-1');
    assert.equal(link.headers.get('Content-Type'), 'audio/mpeg');
    assert.match(linkerAsks[0].system, /beantwortest du eine Frage/);
    assert.deepEqual(JSON.parse(linkerAsks[0].input).question, { from: 'Nina', text: 'Warum ist der Himmel blau?' });
    const questions = (await (await call('nina', '/api/questions')).json()) as any;
    assert.match(questions.questions[0].answer, /Sonnenlicht wird gestreut/);
    // Answered once: the next transition is an ordinary one.
    await call('nina', '/api/linker?after=folge-1&next=wissen-1');
    assert.doesNotMatch(linkerAsks[1].system, /beantwortest du eine Frage/);

    // Without live transitions there is nobody to answer.
    await store.saveConfig(nina, parseStationConfig({ ...defaultStationConfig(), sounds: { ident: true, hourChange: true, linker: false } }), NOW);
    assert.equal((await call('nina', '/api/questions', { text: 'Wie hoch ist der Mond?' })).status, 409);
  } finally { globalThis.fetch = originalFetch; }
});

test('a Mitmach-Geschichte passes the real pipeline: the story plan is the station\'s own source', async () => {
  const h = harness(); await h.setup();
  const real = realPipeline();
  h.deps.pipeline = real.pipeline;
  const firstId = (await addBlock(h.deps, OWNER, 'mitmach', '🦊 ein schlauer Fuchs, im Zauberwald'))!;
  assert.equal(await produceItem(h.deps, OWNER, firstId), 'ready');
  assert.ok(real.seen[0].some(source => source.url === ''));
});
