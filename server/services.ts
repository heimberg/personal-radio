/** Providers, pipeline and station dependencies, built once per database binding and isolate. */
import { SegmentPipeline } from './segment-pipeline.ts';
import { AskEditorialVerifier, AskTextGenerator, FallbackVerifier, GeminiBriefGenerator, GeminiEditorialVerifier, GeminiPodcastGenerator, GeminiPodcastSpeechSynthesizer, GeminiResearcher, GeminiSpeechSynthesizer, MistralSpeechSynthesizer, ProviderError, VoiceRouter } from './providers.ts';
import type { Researcher } from './providers.ts';
import type { EditorialVerifier } from './segment-pipeline.ts';
import type { TextGenerator } from '../src/domain/program.ts';
import { fetchFeed } from './feed.ts';
import { StationStore } from './station-store.ts';
import { OpenMeteo } from './tools.ts';
import { GeminiScriptEditor } from './editing.ts';
import { tick } from './station.ts';
import { GeminiMusicWriter, SpotifyCatalog } from './music.ts';
import { SpotifyListening } from './listening.ts';
import { D1StepRunner } from './agentic/steps.ts';
import type { MusicCatalog, PlaylistSource } from './music.ts';
import type { StationDeps } from './station.ts';
import { meteredFetch } from './usage.ts';
import { PlayStore } from './play.ts';
import { FollowStore } from './follow.ts';
import { forKids, isKids, listenersNow, listenersOf } from './listeners.ts';
import { familyMembers } from './family.ts';
import type { AudioObjects, Member } from './family.ts';
import type { Environment } from './http.ts';
import { D1CharacterBudget, D1DailyCounter, D1FeedCounter } from './counters.ts';

/** Where Google's sample of an own voice is kept. */
export const voiceSampleKey = (voiceId: string) => `sounds/voice-sample-${voiceId}`;

const pipelines = new WeakMap<object, SegmentPipeline>();

interface Providers { ask?: TextGenerator; geminiBrief?: TextGenerator; geminiDialog?: TextGenerator; researcher?: Researcher; verifier: EditorialVerifier }
const providerCache = new WeakMap<object, Providers>();

/** ASK is optional: Gemini writes by default; ASK, when configured, is the independent second model that verifies. */
/** Provider requests go through one counting fetch per database, for the daily usage overview. */
const meters = new WeakMap<object, typeof fetch>();
export function metered(env: Environment): typeof fetch {
  let meter = meters.get(env.DB as object);
  if (!meter) {
    let askHost: string | undefined;
    try { askHost = env.ASK_BASE_URL ? new URL(env.ASK_BASE_URL).hostname : undefined; } catch { /* Invalid ASK URL: the provider refuses it anyway. */ }
    meter = meteredFetch(env.DB, { askHost });
    meters.set(env.DB as object, meter);
  }
  return meter;
}

export function providersFor(env: Environment): Providers {
  let providers = providerCache.get(env.DB as object);
  if (!providers) {
    const counted = metered(env);
    const askConfig = { baseUrl: env.ASK_BASE_URL, key: env.ASK_API_KEY, model: env.ASK_MODEL };
    const askReady = Boolean(env.ASK_BASE_URL && env.ASK_API_KEY && env.ASK_MODEL);
    const gemini = env.GEMINI_API_KEY ? { key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL } : undefined;
    const unavailable: EditorialVerifier = { verify: async () => { throw new ProviderError('No verifier configured'); } };
    providers = {
      ...(askReady ? { ask: new AskTextGenerator(askConfig, counted) } : {}),
      ...(gemini ? {
        geminiBrief: new GeminiBriefGenerator(gemini, counted), geminiDialog: new GeminiPodcastGenerator(gemini, counted),
        researcher: new GeminiResearcher({ key: gemini.key, model: env.GEMINI_RESEARCH_MODEL || gemini.model }, counted),
      } : {}),
      verifier: askReady && gemini ? new FallbackVerifier(new AskEditorialVerifier(askConfig, counted), new GeminiEditorialVerifier(gemini, counted))
        : askReady ? new AskEditorialVerifier(askConfig, counted) : gemini ? new GeminiEditorialVerifier(gemini, counted) : unavailable,
    };
    providerCache.set(env.DB as object, providers);
  }
  return providers;
}

export function pipelineFor(env: Environment): SegmentPipeline {
  let pipeline = pipelines.get(env.DB as object);
  if (!pipeline) {
    const providers = providersFor(env);
    const missing: TextGenerator = { generate: async () => { throw new ProviderError('No text provider configured'); } };
    pipeline = new SegmentPipeline(
      // The manual single-segment tool keeps ASK when present and otherwise uses Gemini.
      providers.ask ?? providers.geminiBrief ?? missing,
      new VoiceRouter(new MistralSpeechSynthesizer({
        // Kerstin is the bundled German reference voice, so a missing setting never blocks speech.
        key: env.MISTRAL_API_KEY, voiceId: env.MISTRAL_VOICE_ID || 'de_kerstin_cc0', model: env.MISTRAL_TTS_MODEL,
        referenceAudio: async () => {
          const response = await env.ASSETS.fetch(new Request('https://assets.local/audio/kerstin-reference.flac'));
          if (!response.ok) throw new Error('German reference audio unavailable');
          return new Uint8Array(await response.arrayBuffer());
        },
      }, metered(env)), env.GEMINI_API_KEY ? new GeminiSpeechSynthesizer({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL, liteModel: env.GEMINI_TTS_LITE_MODEL }, metered(env)) : undefined),
      providers.verifier,
      new D1CharacterBudget(env.DB, Math.max(1, Number(env.DAILY_TTS_CHARACTERS) || 12_000)),
      4,
      env.GEMINI_API_KEY ? {
        text: providers.geminiDialog!,
        speech: new GeminiPodcastSpeechSynthesizer({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL, liteModel: env.GEMINI_TTS_LITE_MODEL, voiceA: env.GEMINI_VOICE_A, voiceB: env.GEMINI_VOICE_B }, metered(env)),
      } : undefined,
    );
    pipelines.set(env.DB as object, pipeline);
  }
  return pipeline;
}

const musicCache = new WeakMap<object, { writer?: GeminiMusicWriter; catalog?: MusicCatalog; cleanCatalog?: MusicCatalog }>();
export function musicFor(env: Environment) {
  let music = musicCache.get(env.DB as object);
  if (!music) {
    const spotify = env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET ? { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET, market: env.SPOTIFY_MARKET } : null;
    music = {
      ...(env.GEMINI_API_KEY ? { writer: new GeminiMusicWriter({ key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL, liteModel: env.GEMINI_LITE_MODEL ?? 'gemini-3.8-flash-lite' }, metered(env)) } : {}),
      ...(spotify ? { catalog: new SpotifyCatalog(spotify), cleanCatalog: new SpotifyCatalog({ ...spotify, clean: true }) } : {}),
    };
    musicCache.set(env.DB as object, music);
  }
  return music;
}

/** Production for one station; a child's station gets its rules and never an explicit track. */
export function stationDeps(env: Environment, owner: string): StationDeps {
  const kids = isKids(owner, listenersNow(env));
  const catalog = kids ? musicFor(env).cleanCatalog : musicFor(env).catalog;
  return {
    store: new StationStore(env.DB, kids ? forKids : undefined), pipeline: pipelineFor(env), audio: env.AUDIO,
    fetchFeed: url => fetchFeed(url),
    reserveFeed: owner => new D1FeedCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_FEED_REQUESTS) || 60)),
    reserveGeneration: owner => new D1DailyCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_GENERATIONS) || 24)),
    podcastAvailable: Boolean(env.GEMINI_API_KEY), compressSpeech: env.SPEECH_MP3 === 'on', now: () => new Date(), random: Math.random,
    generator: (provider, format) => {
      const providers = providersFor(env);
      if (provider === 'ask') return format === 'brief' ? providers.ask : undefined;
      return format === 'podcast' ? providers.geminiDialog : providers.geminiBrief;
    },
    researcher: providersFor(env).researcher,
    weather: new OpenMeteo(),
    musicWriter: musicFor(env).writer,
    // The final edit and the quality jury use the same Gemini JSON calls as the music desk.
    ...(musicFor(env).writer ? { editor: new GeminiScriptEditor((system, input, label, temperature) => musicFor(env).writer!.askJson(system, input, label, temperature)) } : {}),
    ...(musicFor(env).writer ? { agentModel: musicFor(env).writer } : {}),
    agentSteps: (owner, runId) => new D1StepRunner(env.DB, owner, runId),
    week: (owner, since) => new PlayStore(env.DB).week(owner, since),
    follows: new FollowStore(env.DB),
    catalog,
    ...(listeningFor(env) ? { listening: listeningFor(env)! } : {}),
    ...(catalog instanceof SpotifyCatalog ? { playlists: playlistsFor(catalog, listeningFor(env)) } : {}),
  };
}

/** Releases younger than this count as new for the «Neu von deinen Künstlern» block. */
const RELEASE_DAYS = 60;

/** The owner's token reads private playlists; without a connection (or when refused) the app token reads public ones. */
function playlistsFor(catalog: SpotifyCatalog, listening: SpotifyListening | null): PlaylistSource {
  return {
    tracks: async (owner, id) => {
      const token = listening ? await listening.accessToken(owner) : null;
      if (token) {
        try { return await catalog.playlistTracks(id, token); }
        catch (error) { if (!(error instanceof ProviderError) || ![401, 403, 404].includes(error.status ?? 0)) throw error; }
      }
      return catalog.playlistTracks(id);
    },
    releases: async owner => {
      const artists = listening ? await listening.topArtists(owner, new Date()) : [];
      if (!artists.length) throw new Error('Spotify-Hörprofil nicht verbunden oder noch ohne Top-Künstler');
      return catalog.newReleases(artists, new Date(Date.now() - RELEASE_DAYS * 86_400_000));
    },
  };
}

export function listeningFor(env: Environment): SpotifyListening | null {
  return env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET ? new SpotifyListening(env.DB, { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET }) : null;
}

/** The family on this Worker: the owner and the listeners who are not guests. */
export const membersOf = async (env: Environment): Promise<Member[]> => familyMembers(env.ALLOWED_EMAIL ?? '', await listenersOf(env), env.OWNER_NAME);

/** R2 objects as the family copy reads them. */
export const audioObjects = (env: Environment): AudioObjects => ({
  get: async key => {
    const object = await env.AUDIO.get(key);
    return object ? { arrayBuffer: () => new Response(object.body).arrayBuffer(), httpMetadata: (object as { httpMetadata?: { contentType?: string } }).httpMetadata } : null;
  },
  put: (key, value, options) => env.AUDIO.put(key, value, options),
});

/** Plans the program and hands due items to the production queue. */
export async function refreshProgram(env: Environment, owner: string, requireListener: boolean) {
  const result = await tick(stationDeps(env, owner), owner, { requireListener });
  for (const itemId of result.due) await env.PRODUCTION.send({ owner, itemId });
  return result;
}
