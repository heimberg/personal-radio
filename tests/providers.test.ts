import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskEditorialVerifier, AskTextGenerator, FallbackVerifier, GeminiBriefGenerator, parseModelJson, GeminiEditorialVerifier, GeminiPodcastGenerator, GeminiPodcastSpeechSynthesizer, GeminiResearcher, GeminiSpeechSynthesizer, GeminiVoiceCatalog, MistralSpeechSynthesizer, VoiceRouter, pcmToWav, personaPrompt, withoutVoiceTags, mapLimited, quoteInSource } from '../server/providers.ts';
import { defaultProfile, parseProfile, parseScript } from '../src/domain/program.ts';
const sources = [{ id: 's1', url: 'https://example.org/news', title: 'Test', excerpt: 'Ein Test.', publishedAt: '2026-09-25', retrievedAt: '2026-09-25' }];
test('script rejects invented source IDs', () => {
  assert.throws(() => parseScript({ title: 'News', text: 'Text', sourceIds: ['invented'] }, sources));
});
test('script rejects missing sources and empty text', () => {
  assert.throws(() => parseScript({ title: 'News', text: 'Text', sourceIds: [] }, sources));
  assert.throws(() => parseScript({ title: 'News', text: ' ', sourceIds: ['s1'] }, sources));
});
test('corrupt profile is bounded and unknown topics removed', () => {
  assert.deepEqual(parseProfile({ topics: ['Wissenschaft', 'Wissenschaft', 'bad'], speechMinutes: 999, exploration: -10 }), {
    topics: ['Wissenschaft'], interests: [], interestWeights: {}, speechMinutes: 10, exploration: 0,
  });
  assert.equal(parseProfile({ speechMinutes: NaN }).speechMinutes, 3);
});
test('Gemini creates a validated, source-cited two-host script from the official generation endpoint', async () => {
  const generator = new GeminiPodcastGenerator({ key: 'test-key' }, async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Zwei Hosts', turns: [
      { speaker: 'host-a', text: 'Erste Aussage.' }, { speaker: 'host-b', text: 'Zweite Aussage.' },
    ], sourceIds: ['s1'], interestTags: ['Geschichte'] }) }] } }] });
  });
  const result = await generator.generate({ ...defaultProfile, interests: ['Geschichte'] }, sources);
  assert.equal(result.text, 'Erste Aussage. Zweite Aussage.');
  assert.equal(result.turns?.[1]?.speaker, 'host-b');
});
test('Gemini text generation retries a transient 503 once and succeeds', async () => {
  let attempts = 0;
  const generator = new GeminiPodcastGenerator({ key: 'test-key' }, async () => {
    attempts++;
    if (attempts === 1) return Response.json({ error: { message: 'temporarily overloaded' } }, { status: 503 });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      title: 'Zwei Hosts', turns: [
        { speaker: 'host-a', text: 'Erste Aussage.' }, { speaker: 'host-b', text: 'Zweite Aussage.' },
      ], sourceIds: ['s1'], interestTags: ['Wissenschaft'],
    }) }] } }] });
  });
  const result = await generator.generate(defaultProfile, sources);
  assert.equal(attempts, 2);
  assert.equal(result.title, 'Zwei Hosts');
});
test('Gemini TTS sends two configured voices and accepts only WAV audio', async () => {
  const wav = Buffer.alloc(48); wav.write('RIFF', 0); wav.write('WAVE', 8);
  const synth = new GeminiPodcastSpeechSynthesizer({ key: 'test-key', voiceA: 'Kore', voiceB: 'Puck' }, async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generation_config.speech_config.mode, 'conversational');
    assert.deepEqual(body.generation_config.speech_config.speakers.map((speaker: any) => speaker.voice), ['Kore', 'Puck']);
    assert.deepEqual(body.input[0].content.map((turn: any) => turn.annotations[0].speaker), ['host-a', 'host-b']);
    return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64') }] }] });
  });
  const result = await synth.synthesize('A B', [{ speaker: 'host-a', text: 'A' }, { speaker: 'host-b', text: 'B' }]);
  assert.equal(Buffer.from(result).toString('ascii', 0, 4), 'RIFF');
});
test('dialogs speak with the station voices; with an own voice every turn is spoken alone and joined', async () => {
  const pcm = Buffer.alloc(4800, 1).toString('base64');
  const calls: any[] = [];
  const synth = new GeminiPodcastSpeechSynthesizer({ key: 'k' }, async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16;rate=24000', data: pcm }] }] });
  });
  const turns = [{ speaker: 'host-a' as const, text: 'Hallo' }, { speaker: 'host-b' as const, text: 'Hoi' }, { speaker: 'host-a' as const, text: 'Also' }];
  await synth.synthesize('Hallo Hoi Also', turns, undefined, undefined, { voices: ['gemini_Laomedeia', 'de_kerstin_cc0'] });
  assert.deepEqual(calls[0].generation_config.speech_config.speakers.map((speaker: any) => speaker.voice), ['Laomedeia', 'Puck']);
  calls.length = 0;
  const audio = await synth.synthesize('Hallo Hoi Also', turns, undefined, undefined, { voices: ['gemini_voice_mine', 'gemini_Charon'] });
  assert.deepEqual(calls.map(call => call.generation_config.speech_config[0].voice), ['voice_mine', 'Charon', 'voice_mine']);
  // Three turns of 0.1 s and two pauses of 0.35 s.
  assert.equal(audio.length, 44 + 3 * 4800 + 2 * Math.round(24_000 * 0.35) * 2);
});
test('ASK keeps source text in data and uses configured endpoint', async () => {
  const ask = new AskTextGenerator({ baseUrl: 'https://ask.example/api/v1/', key: 'test-only', model: 'test-model' }, async (url, init) => {
    assert.equal(url, 'https://ask.example/api/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, 'json_object');
    assert.deepEqual(JSON.parse(body.messages[1].content).sources, sources);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Test', text: 'Ein Test.', sourceIds: ['s1'] }) } }] });
  });
  assert.equal((await ask.generate(defaultProfile, sources)).title, 'Test');
});
test('provider failures do not expose response body or secrets', async () => {
  const ask = new AskTextGenerator({ baseUrl: 'https://ask.example/api/v1', key: 'sensitive', model: 'test' }, async () => new Response('sensitive upstream dump', { status: 401 }));
  await assert.rejects(ask.generate(defaultProfile, sources), { message: 'ASK request failed (401)' });
});
test('ASK rejects insecure endpoint and missing sources before request', async () => {
  assert.throws(() => new AskTextGenerator({ baseUrl: 'http://ask.example', key: 'test', model: 'test' }));
  const ask = new AskTextGenerator({ baseUrl: 'https://ask.example', key: 'test', model: 'test' }, async () => { throw new Error('must not call'); });
  await assert.rejects(ask.generate(defaultProfile, []), /sources missing/);
});
test('ASK verifier approves only direct quotes from cited source excerpts', async () => {
  const verifier = new AskEditorialVerifier({ baseUrl: 'https://ask.example/api/v1', key: 'test', model: 'test' }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.temperature, 0);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ approved: true,
      checks: [{ claim: 'Ein Test', sourceIds: ['s1'], quote: 'Ein Test.', supported: true }], reasons: [] }) } }] });
  });
  assert.equal((await verifier.verify({ title: 'News', text: 'Ein Test.', sourceIds: ['s1'] }, sources)).approved, true);
  const forged = new AskEditorialVerifier({ baseUrl: 'https://ask.example/api/v1', key: 'test', model: 'test' }, async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ approved: true,
      checks: [{ claim: 'Behauptung', sourceIds: ['s1'], quote: 'Das steht hier nicht.', supported: true }], reasons: [] }) } }] }));
  assert.equal((await forged.verify({ title: 'News', text: 'Behauptung.', sourceIds: ['s1'] }, sources)).approved, false);
});
test('Mistral decodes audio_data and sends voice and model', async () => {
  const tts = new MistralSpeechSynthesizer({ key: 'test', voiceId: 'voice-test' }, async (url, init) => {
    assert.equal(url, 'https://api.mistral.ai/v1/audio/speech');
    const body = JSON.parse(String(init?.body)); assert.equal(body.voice_id, 'voice-test');
    assert.equal(body.model, 'voxtral-mini-tts-2603');
    return Response.json({ audio_data: 'SUQz' });
  });
  assert.equal(Buffer.from(await tts.synthesize('Guten Tag.')).toString(), 'ID3');
});
test('Mistral sends bundled German CC0 reference audio when Kerstin is selected', async () => {
  const sample = new Uint8Array(1024).fill(65);
  let referenceLoads = 0;
  const synth = new MistralSpeechSynthesizer({ key: 'test', referenceAudio: async () => {
    referenceLoads++;
    return sample;
  } }, async (url, init) => {
    assert.equal(url, 'https://api.mistral.ai/v1/audio/speech');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.ref_audio, Buffer.from(sample).toString('base64'));
    assert.equal('voice_id' in body, false);
    return Response.json({ audio_data: 'SUQz' });
  });
  await synth.synthesize('Guten Tag.', undefined, 'de_kerstin_cc0');
  assert.equal(referenceLoads, 1);
});
test('Mistral accepts the voice selected by the authenticated app without a Worker voice secret', async () => {
  const synth = new MistralSpeechSynthesizer({ key: 'test' }, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).voice_id, 'preset-de');
    return Response.json({ audio_data: 'SUQz' });
  });
  await synth.synthesize('Guten Tag.', undefined, 'preset-de');
});

test('TTS rejects oversized input without spending money', async () => {
  const tts = new MistralSpeechSynthesizer({ key: 'test', voiceId: 'test' }, async () => { throw new Error('must not call'); });
  await assert.rejects(tts.synthesize('Wort '.repeat(281)), /budget/);
});

test('persona and show instructions reach the system prompt; dialogs name host and co-host', async () => {
  const direction = { instructions: 'Nur Raumfahrt, keine Börse.', targetMinutes: 2, stationName: 'Nachtfunk',
    persona: { name: 'Mira', tone: 'ruhig', style: 'Hintergrund', instructions: 'Duze den Hörer.', cohostName: 'Jonas' } };
  let askSystem = '';
  const ask = new AskTextGenerator({ baseUrl: 'https://ask.example/api/v1', key: 'k', model: 'm' }, async (_url, init) => {
    askSystem = JSON.parse(String(init?.body)).messages[0].content;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'T', text: 'Ein Test.', sourceIds: ['s1'] }) } }] });
  });
  await ask.generate(defaultProfile, sources, direction);
  assert.match(askSystem, /Du sprichst als Mira, Moderation von «Nachtfunk»\. Tonfall: ruhig\. Stil: Hintergrund\. Duze den Hörer\./);
  assert.match(askSystem, /Vorgaben des Hörers für diese Sendung: Nur Raumfahrt, keine Börse\./);
  assert.match(askSystem, /maximal 250 Wörter/);
  let geminiSystem = '';
  const gemini = new GeminiPodcastGenerator({ key: 'k' }, async (_url, init) => {
    geminiSystem = JSON.parse(String(init?.body)).systemInstruction.parts[0].text;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'D', sourceIds: ['s1'],
      turns: [{ speaker: 'host-a', text: 'Hallo Jonas.' }, { speaker: 'host-b', text: 'Hallo Mira.' }] }) }] } }] });
  });
  await gemini.generate(defaultProfile, sources, { ...direction, targetMinutes: 5 });
  assert.match(geminiSystem, /host-a ist Mira, Moderation von «Nachtfunk»; host-b ist Jonas\./);
  assert.match(geminiSystem, /etwa 650 Wörter/);
});

const geminiText = (text: string, groundingMetadata?: unknown) => Response.json({ candidates: [{ content: { parts: [{ text }] }, ...(groundingMetadata ? { groundingMetadata } : {}) }] });

test('Gemini brief uses the shared prompt, JSON output and topic memory', async () => {
  let body: any, url = '';
  const gemini = new GeminiBriefGenerator({ key: 'g', model: 'gemini-test' }, async (input, init) => {
    url = String(input); body = JSON.parse(String(init?.body));
    return geminiText(JSON.stringify({ title: 'Kurz', text: 'Ein Test.', sourceIds: ['s1'] }));
  });
  const script = await gemini.generate(defaultProfile, sources, { avoidTopics: ['Mondlandung'], persona: { name: 'Mira', tone: 'ruhig', style: 'Radio', instructions: '' } });
  assert.equal(script.title, 'Kurz');
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.match(body.systemInstruction.parts[0].text, /Du sprichst als Mira/);
  assert.match(body.systemInstruction.parts[0].text, /wiederhole sie nicht.*«Mondlandung»/);
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text).sources, sources);
});

test('Gemini research keeps only search-grounded sentences, grouped by result, plus the search queries', async () => {
  let body: any;
  const researcher = new GeminiResearcher({ key: 'g' }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return geminiText('Satz A. Satz B. Unbelegte Behauptung.', {
      webSearchQueries: ['portishead dummy 1994'],
      groundingChunks: [{ web: { uri: 'https://example.org/a', title: 'example.org' } }, { web: { uri: 'https://example.net/b', title: 'example.net' } }, { web: { uri: 'http://insecure.example/c', title: 'insecure' } }],
      groundingSupports: [
        { segment: { text: 'Satz A.' }, groundingChunkIndices: [0, 1] },
        { segment: { text: 'Satz B.' }, groundingChunkIndices: [1] },
        { segment: { text: 'Unsicher.' }, groundingChunkIndices: [2] },
        { segment: { text: 'Kaputt.' }, groundingChunkIndices: [9] },
      ],
    });
  });
  const now = new Date('2026-09-27T08:00:00Z');
  const result = await researcher.research({ brief: 'Hintergrund zu Portishead', interests: ['Trip-Hop'], avoidTopics: ['Dummy'], now });
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.equal(JSON.parse(body.contents[0].parts[0].text).heute, '2026-09-27');
  assert.deepEqual(result.queries, ['portishead dummy 1994']);
  assert.deepEqual(result.sources.map(source => [source.id, source.url, source.excerpt]), [
    ['w1', 'https://example.net/b', 'Satz A. Satz B.'],
    ['w2', 'https://example.org/a', 'Satz A.'],
  ]);
  assert.ok(!result.sources.some(source => source.excerpt.includes('Unbelegte')));
  const empty = new GeminiResearcher({ key: 'g' }, async () => geminiText('Nichts gefunden.'));
  assert.deepEqual(await empty.research({ brief: '', interests: [], avoidTopics: [], now }), { sources: [], queries: [] });
});

test('Gemini verifier applies the same local quote check as ASK', async () => {
  const script = { title: 'T', text: 'Ein Test.', sourceIds: ['s1'] };
  const answer = (quote: string) => new GeminiEditorialVerifier({ key: 'g' }, async () => geminiText(JSON.stringify({
    approved: true, checks: [{ claim: 'Test', sourceIds: ['s1'], quote, supported: true }], reasons: [] })));
  assert.equal((await answer('Ein Test.').verify(script, sources)).approved, true);
  assert.deepEqual(await answer('Erfundenes Zitat.').verify(script, sources), { approved: false, reasons: ['Zitat nicht in der Quelle: «Erfundenes Zitat.»'] });
  // Typographic differences do not fail a correct quote.
  const typographic = [{ ...sources[0], excerpt: 'Er sagte: „Die Sonde – gebaut in Bern – startet 2027.“' }];
  const verifier = new GeminiEditorialVerifier({ key: 'g' }, async () => geminiText(JSON.stringify({ approved: true, reasons: [],
    checks: [{ claim: 'Start 2027', sourceIds: ['s1'], quote: '"Die Sonde - gebaut in  Bern - startet 2027."', supported: true }] })));
  assert.equal((await verifier.verify(script, typographic)).approved, true);
  const unsupported = new GeminiEditorialVerifier({ key: 'g' }, async () => geminiText(JSON.stringify({ approved: false, reasons: [],
    checks: [{ claim: 'Die Sonde landet auf dem Mars', sourceIds: ['s1'], quote: '', supported: false }] })));
  assert.deepEqual(await unsupported.verify(script, sources), { approved: false, reasons: ['Nicht belegt: «Die Sonde landet auf dem Mars»'] });
});

test('Gemini quota errors carry Google\'s explanation and retry delay and are not retried immediately', async () => {
  let calls = 0;
  const researcher = new GeminiResearcher({ key: 'secret-key' }, async () => {
    calls++;
    return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.8-flash',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } }, { status: 429 });
  });
  await assert.rejects(researcher.research({ brief: '', interests: [], avoidTopics: [], now: new Date() }), (error: any) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 37_000);
    assert.match(error.message, /^Gemini research request failed \(429\): You exceeded your current quota\. \* Quota exceeded for metric: generate_content_free_tier_requests, limit: 0/);
    assert.ok(!error.message.includes('secret-key'));
    return true;
  });
  assert.equal(calls, 1);
});

test('model JSON is accepted inside a Markdown code block or with text around it', () => {
  assert.deepEqual(parseModelJson('```json\n{"approved":true}\n```'), { approved: true });
  assert.deepEqual(parseModelJson('Hier ist das Ergebnis: {"approved":false,"checks":[]} Ende.'), { approved: false, checks: [] });
  assert.throws(() => parseModelJson('{"approved":tru'));
});

test('ASK verification tolerates code fences, explains cut-off answers, and Gemini stands in when ASK fails', async () => {
  const script = { title: 'T', text: 'Ein Test.', sourceIds: ['s1'] };
  const verdict = JSON.stringify({ approved: true, checks: [{ claim: 'Test', sourceIds: ['s1'], quote: 'Ein Test.', supported: true }], reasons: [] });
  const ask = (content: string, finish = 'stop') => new AskEditorialVerifier({ baseUrl: 'https://ask.example/api/v1', key: 'k', model: 'm' },
    async () => Response.json({ choices: [{ message: { content }, finish_reason: finish }] }));
  assert.equal((await ask('```json\n' + verdict + '\n```').verify(script, sources)).approved, true);
  await assert.rejects(ask('{"approved":true,"checks":[{"claim":"Te', 'length').verify(script, sources), /cut off \(max_tokens reached\)/);
  await assert.rejects(ask('', 'length').verify(script, sources), /no verification content \(finish_reason: length\)/);
  const gemini = new GeminiEditorialVerifier({ key: 'g' }, async () => geminiText(verdict));
  const fallback = await new FallbackVerifier(ask('kaputt'), gemini).verify(script, sources);
  assert.equal(fallback.approved, true);
  assert.match(fallback.reasons.at(-1)!, /Geprüft durch Ersatz, weil: ASK returned invalid verification data/);
  // A real verdict from ASK is final, even a rejection.
  let geminiCalls = 0;
  const counting = new GeminiEditorialVerifier({ key: 'g' }, async () => { geminiCalls++; return geminiText(verdict); });
  const rejected = JSON.stringify({ approved: false, checks: [{ claim: 'Mars', sourceIds: ['s1'], quote: '', supported: false }], reasons: [] });
  assert.equal((await new FallbackVerifier(ask(rejected), counting).verify(script, sources)).approved, false);
  assert.equal(geminiCalls, 0);
});

test('Gemini voices: Interactions API with the style as annotation, lite model for short speech, PCM wrapped as WAV; the router picks the engine by voice ID', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const pcm = new Uint8Array(4800).fill(1);
  const gemini = new GeminiSpeechSynthesizer({ key: 'g', model: 'gemini-3.8-flash-tts' }, async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16;rate=24000', data: btoa(String.fromCharCode(...pcm)) }] }] });
  });
  const audio = await gemini.synthesize('Guten Morgen, <laugh> Melchnau!', undefined, 'gemini_Puck', 'energisch und warm');
  assert.match(calls[0].url, /\/v1beta\/interactions$/);
  assert.equal(calls[0].body.model, 'gemini-3.8-flash-tts');
  assert.deepEqual(calls[0].body.generation_config, { speech_config: [{ voice: 'Puck' }] });
  assert.deepEqual(calls[0].body.input[0].content[0], { type: 'text', text: 'Guten Morgen, <laugh> Melchnau!', annotations: [{ type: 'speech_metadata', style: 'energisch und warm; Deutsch' }] });
  assert.equal(String.fromCharCode(...audio.subarray(0, 4)), 'RIFF');
  assert.equal(audio.length, 44 + pcm.length);
  assert.equal(new DataView(pcmToWav(pcm).buffer).getUint32(24, true), 24000);
  // Short speech takes the lite model, except with an own voice, which was made with the full one.
  await gemini.synthesize('Kurz.', undefined, 'gemini_Kore', undefined, { lite: true });
  assert.equal(calls[1].body.model, 'gemini-3.8-flash-lite-tts');
  await gemini.synthesize('Kurz.', undefined, 'gemini_voice_abc123', undefined, { lite: true });
  assert.equal(calls[2].body.model, 'gemini-3.8-flash-tts');
  assert.deepEqual(calls[2].body.generation_config.speech_config, [{ voice: 'voice_abc123' }]);
  await assert.rejects(gemini.synthesize('x', undefined, 'de_kerstin_cc0'), /Gemini voice is not selected/);

  // Without the Interactions API, a prebuilt voice falls back to generateContent, without voice tags.
  let legacy: any;
  const fallback = new GeminiSpeechSynthesizer({ key: 'g' }, async (input, init) => {
    if (String(input).endsWith('/interactions')) return new Response('{}', { status: 404 });
    legacy = { url: String(input), body: JSON.parse(String(init?.body)) };
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: btoa(String.fromCharCode(...pcm)) } }] } }] });
  });
  await fallback.synthesize('Hallo <sigh> du |mhm| da.', undefined, 'gemini_Puck');
  assert.match(legacy.url, /models\/gemini-3\.8-flash-tts:generateContent$/);
  assert.match(legacy.body.contents[0].parts[0].text, /#### TRANSCRIPT\nHallo du da\.$/);

  const used: string[] = [], texts: string[] = [];
  const engine = (name: string) => ({ synthesize: async (text: string) => { used.push(name); texts.push(text); return new Uint8Array([1]); } });
  const router = new VoiceRouter(engine('mistral'), engine('gemini'));
  await router.synthesize('a <laugh>', undefined, 'gemini_Fenrir'); await router.synthesize('a <laugh> b', undefined, 'de_kerstin_cc0'); await router.synthesize('a');
  assert.deepEqual(used, ['gemini', 'mistral', 'mistral']);
  assert.deepEqual(texts, ['a <laugh>', 'a b', 'a']);
  await assert.rejects(new VoiceRouter(engine('mistral')).synthesize('a', undefined, 'gemini_Puck'), /GEMINI_API_KEY/);
});

test('voice tags stay out of what is read and checked', () => {
  assert.equal(withoutVoiceTags('Das ist <laugh> erstaunlich. |mhm| Wirklich <short pause>!'), 'Das ist erstaunlich. Wirklich!');
  assert.equal(withoutVoiceTags('3 < 5 und 7 > 2'), '3 < 5 und 7 > 2');
  assert.match(personaPrompt({ persona: { name: 'Mira', tone: 'ruhig', style: 'Radio', instructions: '' } }, 'brief'), /<laugh>/);
});

test('own voices: library in German, designed and cloned voices, delete', async () => {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const catalog = new GeminiVoiceCatalog({ key: 'g' }, async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (method === 'POST') return Response.json({ id: 'voice_new1', sample_audio: { data: 'AAAA' } });
    const type = new URL(url).searchParams.get('type');
    if (type === 'prompted') return Response.json({ voices: [{ id: 'voice_mine', display_name: 'Meine Moderatorin', gender: 'FEMALE' }] });
    if (type === 'replicated') return Response.json({ voices: [] });
    return Response.json({ voices: [{ id: 'Bernerin', display_name: 'Bernerin', description: 'warm, Berner Dialekt' }, { id: 'bad id!' }] });
  });
  const voices = await catalog.list('warm');
  assert.deepEqual(voices, [
    { id: 'gemini_voice_mine', name: 'Meine Moderatorin', group: 'own', gender: 'female' },
    { id: 'gemini_Bernerin', name: 'Bernerin', group: 'library', description: 'warm, Berner Dialekt' },
  ]);
  const library = new URL(calls.find(call => new URL(call.url).searchParams.get('type') === 'prebuilt')!.url);
  assert.deepEqual(library.searchParams.getAll('language_code'), ['de-DE', 'de-CH']);
  assert.equal(library.searchParams.get('search'), 'warm');
  assert.deepEqual(await catalog.design({ name: 'Mira', description: 'Warme Moderatorin, ruhig', gender: 'female' }), { id: 'gemini_voice_new1', name: 'Mira', group: 'own' });
  assert.deepEqual(calls.at(-1)!.body, { store: true, voice: { model: 'gemini-3.8-flash-tts', type: 'prompted', display_name: 'Mira', language_code: 'de-DE', gender: 'female', prompted: { input: 'Warme Moderatorin, ruhig' } } });
  await catalog.replicate({ name: 'Ich', source: 'U09VUkNF', consent: 'Q09OU0VOVA==' });
  assert.deepEqual(calls.at(-1)!.body.voice.replicated, { source_audio: { mime_type: 'audio/wav', data: 'U09VUkNF' }, consent_audio: { mime_type: 'audio/wav', data: 'Q09OU0VOVA==' } });
  await catalog.remove('gemini_voice_new1');
  assert.equal(calls.at(-1)!.method, 'DELETE'); assert.match(calls.at(-1)!.url, /\/v1beta\/voices\/voice_new1$/);
  await assert.rejects(catalog.remove('gemini_Kore'));
});

test('every persona prompt asks for scripts written to be heard', () => {
  assert.match(personaPrompt({ persona: { name: 'Mira', tone: 'ruhig', style: 'Radio', instructions: '' } }, 'brief'), /Schreibe fürs Ohr/);
});

test('mapLimited runs a few calls at once and keeps the order', async () => {
  let running = 0, most = 0;
  const results = await mapLimited([30, 5, 20, 1, 10], 3, async (ms, index) => {
    running++; most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, ms));
    running--;
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(most, 3);
});

test('spent TTS quota (429) moves speech once to the lite model: prebuilt and own voices, dialogs; never when lite is the main model', async () => {
  const pcm = btoa(String.fromCharCode(...new Uint8Array(4800).fill(1)));
  const models: string[] = [];
  const quota = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model;
    models.push(model);
    if (model === 'gemini-3.8-flash-tts') return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, { status: 429 });
    return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16;rate=24000', data: pcm }] }] });
  };
  const single = new GeminiSpeechSynthesizer({ key: 'g' }, quota);
  await single.synthesize('Hallo.', undefined, 'gemini_Puck');
  await single.synthesize('Hallo.', undefined, 'gemini_voice_mine');
  assert.deepEqual(models, ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);

  models.length = 0;
  const dialog = new GeminiPodcastSpeechSynthesizer({ key: 'g' }, quota);
  await dialog.synthesize('A B', [{ speaker: 'host-a', text: 'A' }, { speaker: 'host-b', text: 'B' }]);
  assert.deepEqual(models, ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);

  models.length = 0;
  const same = new GeminiSpeechSynthesizer({ key: 'g', liteModel: 'gemini-3.8-flash-tts' }, quota);
  await assert.rejects(same.synthesize('Hallo.', undefined, 'gemini_voice_mine'), /429/);
  assert.deepEqual(models, ['gemini-3.8-flash-tts']);
});

test('a quote with a dropped or bent word still counts; an invented one does not', () => {
  const excerpt = 'Peking. Forschende der Chinesischen Akademie der Wissenschaften haben sechs bisher unentdeckte Zonen im Erdmantel kartiert, wie das Team am Montag mitteilte.';
  assert.equal(quoteInSource('Forschende der Chinesischen Akademie der Wissenschaften sechs bisher unentdeckte Zonen', excerpt), true);
  assert.equal(quoteInSource('„sechs bisher unentdeckte Zonen im Erdmantel“', excerpt), true);
  // A changed word (here a number) or a dropped negation is no longer the source.
  assert.equal(quoteInSource('Forschende der Chinesischen Akademie der Wissenschaften haben zehn bisher unentdeckte Zonen im Erdmantel kartiert', excerpt), false);
  assert.equal(quoteInSource('Die Behörde hat den Impfstoff zugelassen', 'Die Behörde hat den Impfstoff bisher nicht zugelassen.'), false);
  assert.equal(quoteInSource('Die Behörde hat den Impfstoff zugelassen', 'Die Behörde hat den neuen Impfstoff zugelassen.'), true);
  assert.equal(quoteInSource('Forschende der Universität Zürich haben sechs neue Vulkane auf dem Mond entdeckt', excerpt), false);
  assert.equal(quoteInSource('sechs neue Zonen', excerpt), false);
  assert.equal(quoteInSource('das Team hat am Dienstag nichts mitgeteilt', excerpt), false);
});
