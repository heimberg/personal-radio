// Server-only orchestration. Invoke only after authenticating the owner.
import { parseProfile, parseScript } from '../src/domain/program.ts';
import type { Profile, Source, Script, TextGenerator, SpeechSynthesizer, EditorialDirection } from '../src/domain/program.ts';
import type { VerificationPolicy } from '../src/domain/station.ts';
import { normalizeSpeech, wavToMp3, withBed } from './audio.ts';
import { withoutVoiceTags } from './providers.ts';

export interface EditorialDecision { approved: boolean; reasons: string[] }
/** [hints]: the owner's extra instructions for the fact check; they may sharpen it, never loosen it. */
export interface EditorialVerifier { verify(script: Script, sources: Source[], hints?: string): Promise<EditorialDecision> }
export interface VoicedAudio { audio: Uint8Array; contentType: 'audio/mpeg' | 'audio/wav'; ttsCharacters: number }
export interface PreparedSegment { script: Script; audio: Uint8Array; contentType: 'audio/mpeg' | 'audio/wav'; ttsCharacters: number; mode: 'brief' | 'podcast' }
export interface PodcastProviders { text: TextGenerator; speech: SpeechSynthesizer }
export interface CharacterBudgetStore { reserve(ownerId: string, characters: number): Promise<void> }
/**
 * [reserve] false: the caller caps the cost itself (live transitions); [bed]: a soft music bed under short
 * speech; [lite]: the cheaper voice model for short, frequent speech.
 */
export interface VoiceOptions {
  reserve?: boolean; bed?: boolean; lite?: boolean; /** A dialog's two voices (host, co-host). */ voices?: Array<string | undefined>;
  /** What the app streams is stored as MP3 (about an eighth of the WAV); sounds the Worker builds on stay WAV. */
  compress?: boolean;
}

export class PipelineError extends Error {
  readonly code: 'INVALID_INPUT' | 'REJECTED' | 'BUDGET_EXCEEDED' | 'IDEMPOTENCY_CONFLICT' | 'TOO_MANY_REQUESTS';
  /** Human-readable reason, e.g. which claim the verifier could not find in the sources. */
  readonly detail?: string;
  constructor(code: PipelineError['code'], detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail;
  }
}

/** An https link without credentials. */
function usableLink(link: string): boolean {
  try { const url = new URL(link); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}

/** The limits a draft accepts: at most this many sources and this many characters of excerpts together. */
export const MAX_SOURCES = 8, MAX_SOURCE_CHARS = 24_000;

/**
 * Sources as a draft accepts them: tool and series sources come first and the web after, so the list is
 * cut to [MAX_SOURCES] from the end, duplicate ids and unusable links are dropped, and the excerpts are
 * shortened to fit [MAX_SOURCE_CHARS] together. Without this a show with live data and a full web search
 * failed with INVALID_INPUT.
 */
export function fitSources(sources: Source[]): Source[] {
  const ids = new Set<string>(), usable: Source[] = [];
  for (const source of sources) {
    if (usable.length >= MAX_SOURCES) break;
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) || !source.excerpt?.trim()) continue;
    if (source.url !== '' && !usableLink(source.url)) continue;
    if (!Number.isFinite(Date.parse(source.publishedAt)) || !Number.isFinite(Date.parse(source.retrievedAt))) continue;
    ids.add(source.id);
    usable.push({ ...source, title: source.title.slice(0, 300) });
  }
  // An equal share for every source, and what a short one leaves goes to the others.
  let budget = MAX_SOURCE_CHARS;
  return usable.map((source, index) => {
    const share = Math.floor(budget / (usable.length - index));
    const excerpt = source.excerpt.slice(0, Math.min(12_000, share));
    budget -= excerpt.length;
    return { ...source, excerpt };
  });
}

function validateSources(sources: Source[]) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_SOURCES) throw new PipelineError('INVALID_INPUT', `${Array.isArray(sources) ? sources.length : 0} Quellen`);
  const ids = new Set<string>(); let total = 0;
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id) ||
        typeof source.title !== 'string' || source.title.length > 300 ||
        typeof source.excerpt !== 'string' || !source.excerpt.trim() || source.excerpt.length > 12_000 ||
        typeof source.publishedAt !== 'string' || !Number.isFinite(Date.parse(source.publishedAt)) ||
        typeof source.retrievedAt !== 'string' || !Number.isFinite(Date.parse(source.retrievedAt))) {
      throw new PipelineError('INVALID_INPUT', `Quelle ${typeof source?.id === 'string' ? source.id.slice(0, 40) : '?'} unvollständig`);
    }
    // The station's own material (a story's plan, the week's review) has no link; anything else is https.
    if (source.url !== '' && !usableLink(source.url)) throw new PipelineError('INVALID_INPUT', `Quelle ${source.id}: Link nicht nutzbar`);
    ids.add(source.id); total += source.excerpt.length;
  }
  if (total > MAX_SOURCE_CHARS) throw new PipelineError('INVALID_INPUT', `${total} Zeichen Quellentext`);
}

/** Hard cap per individual segment, before any paid provider call. */
export class CharacterBudget implements CharacterBudgetStore {
  private spent = new Map<string, { day: string; used: number }>();
  readonly maxCharactersPerOwnerPerDay: number;
  private readonly now: () => Date;
  constructor(maxCharactersPerOwnerPerDay = 12_000, now = () => new Date()) {
    this.maxCharactersPerOwnerPerDay = maxCharactersPerOwnerPerDay;
    this.now = now;
    if (!Number.isSafeInteger(maxCharactersPerOwnerPerDay) || maxCharactersPerOwnerPerDay < 1) throw new Error('Invalid character budget');
  }
  async reserve(ownerId: string, characters: number) {
    if (!ownerId || !Number.isSafeInteger(characters) || characters < 1) throw new PipelineError('INVALID_INPUT');
    const day = this.now().toISOString().slice(0, 10), current = this.spent.get(ownerId);
    const used = current?.day === day ? current.used : 0;
    if (characters > this.maxCharactersPerOwnerPerDay - used) throw new PipelineError('BUDGET_EXCEEDED');
    // Count before the provider call. A timeout might occur after the provider charged for the request.
    this.spent.set(ownerId, { day, used: used + characters });
  }
}

export class SegmentPipeline {
  private active = new Map<string, { fingerprint: string; promise: Promise<PreparedSegment> }>();
  private readonly text: TextGenerator;
  private readonly speech: SpeechSynthesizer;
  private readonly verifier: EditorialVerifier;
  private readonly budget: CharacterBudgetStore;
  private readonly maxConcurrent: number;
  private readonly podcast?: PodcastProviders;
  constructor(
    text: TextGenerator,
    speech: SpeechSynthesizer,
    verifier: EditorialVerifier,
    budget: CharacterBudgetStore,
    maxConcurrent = 4,
    podcast?: PodcastProviders,
  ) {
    this.text = text; this.speech = speech; this.verifier = verifier;
    this.budget = budget; this.maxConcurrent = maxConcurrent; this.podcast = podcast;
  }

  prepare(ownerId: string, idempotencyKey: string, profile: Profile, sources: Source[], mode: 'brief' | 'podcast' = 'brief', voiceId?: string): Promise<PreparedSegment> {
    if (!ownerId || !/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey)) return Promise.reject(new PipelineError('INVALID_INPUT'));
    try { validateSources(sources); } catch (error) { return Promise.reject(error); }
    const safeProfile = parseProfile(profile);
    if (mode !== 'brief' && mode !== 'podcast' || mode === 'podcast' && !this.podcast) return Promise.reject(new PipelineError('INVALID_INPUT'));
    const fingerprint = JSON.stringify({ profile: safeProfile, sources, mode, voiceId });
    const key = `${ownerId}:${idempotencyKey}`;
    const existing = this.active.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new PipelineError('IDEMPOTENCY_CONFLICT'));
      return existing.promise;
    }
    if (this.active.size >= this.maxConcurrent) return Promise.reject(new PipelineError('TOO_MANY_REQUESTS'));
    // Remove settled entries: this coalesces concurrent retries only, not retries after completion.
    const promise = this.run(ownerId, safeProfile, sources, mode, voiceId).finally(() => this.active.delete(key));
    this.active.set(key, { fingerprint, promise });
    return promise;
  }

  private async run(ownerId: string, profile: Profile, sources: Source[], mode: 'brief' | 'podcast', voiceId?: string): Promise<PreparedSegment> {
    const script = await this.draft(profile, sources, mode);
    await this.review(script, sources, 'strict');
    const voiced = await this.voice(ownerId, script, mode, voiceId);
    return { script, ...voiced, mode };
  }

  /** Step 1: provider draft, structurally validated against the supplied sources. */
  async draft(profile: Profile, sources: Source[], mode: 'brief' | 'podcast', direction?: EditorialDirection, generator?: TextGenerator): Promise<Script> {
    validateSources(sources);
    if (mode !== 'brief' && mode !== 'podcast' || mode === 'podcast' && !this.podcast) throw new PipelineError('INVALID_INPUT');
    const safeProfile = parseProfile(profile);
    const textProvider = generator ?? (mode === 'podcast' ? this.podcast!.text : this.text);
    const script = parseScript(await textProvider.generate(safeProfile, sources, direction), sources);
    const allowedTags = new Set([...safeProfile.topics, ...safeProfile.interests]);
    script.interestTags = script.interestTags?.filter(tag => allowedTags.has(tag)).slice(0, 30) ?? [];
    if (script.text.length > 12_000 || [...script.text.trim().split(/\s+/)].length > 1400) throw new PipelineError('INVALID_INPUT', 'Text zu lang');
    if (mode === 'podcast' && !script.turns) throw new PipelineError('INVALID_INPUT', 'Dialog ohne Sprecherwechsel');
    return script;
  }

  /** Step 2: evidence review. Only the strict policy calls the verifier; the show decides. */
  async review(script: Script, sources: Source[], policy: VerificationPolicy, hints?: string): Promise<EditorialDecision> {
    if (policy !== 'strict') return { approved: true, reasons: [`VERIFICATION_${policy.toUpperCase()}`] };
    let decision: EditorialDecision;
    // Voice tags are performance, not claims: the check reads the words only.
    const words: Script = { ...script, text: withoutVoiceTags(script.text), ...(script.turns ? { turns: script.turns.map(turn => ({ ...turn, text: withoutVoiceTags(turn.text) })) } : {}) };
    try { decision = await this.verifier.verify(words, sources, hints || undefined); }
    catch (error) {
      // A rate-limited verifier says nothing about the script; let the caller wait and retry.
      if ((error as { status?: unknown } | null)?.status === 429) throw error;
      throw new PipelineError('REJECTED', `Prüfinstanz nicht erreichbar oder fehlerhaft (${(error instanceof Error ? error.message : 'unbekannt').slice(0, 160)})`);
    }
    if (!decision.approved) throw new PipelineError('REJECTED', decision.reasons.join('; ').slice(0, 240) || undefined);
    return decision;
  }

  /** Step 3: reserve the character budget, then synthesize. */
  async voice(ownerId: string, script: Script, mode: 'brief' | 'podcast', voiceId?: string, style?: string, options: VoiceOptions = {}): Promise<VoicedAudio> {
    if (mode === 'podcast' && !this.podcast) throw new PipelineError('INVALID_INPUT');
    const speechProvider = mode === 'podcast' ? this.podcast!.speech : this.speech;
    const characters = [...script.text].length;
    if (options.reserve !== false) await this.budget.reserve(ownerId, characters);
    const audio = await speechProvider.synthesize(script.text, script.turns, mode === 'brief' ? voiceId : undefined, style,
      options.lite || options.voices ? { ...(options.lite ? { lite: true } : {}), ...(options.voices ? { voices: options.voices } : {}) } : undefined);
    if (!(audio instanceof Uint8Array) || audio.length < 1 || audio.length > 18_000_000) throw new PipelineError('INVALID_INPUT');
    // Mistral returns MP3; Gemini voices return WAV, which is brought to one speech level with trimmed edges.
    const wav = audio.length > 12 && String.fromCharCode(...audio.subarray(0, 4)) === 'RIFF';
    const level = wav ? normalizeSpeech(audio) : audio;
    const finished = wav && options.bed && mode === 'brief' ? withBed(level) : level;
    const mp3 = wav && options.compress ? wavToMp3(finished) : null;
    if (mp3) return { audio: mp3, contentType: 'audio/mpeg', ttsCharacters: characters };
    return { audio: finished, contentType: wav ? 'audio/wav' : 'audio/mpeg', ttsCharacters: characters };
  }
}
