/** Producing a spoken item: sources, research, draft, final edit, check, voice; and its retries. */
import { MUSIC_SHOW_ID, bringsOwnMusic, isMusicHour, stationSounds } from '../../src/domain/station.ts';
import type { ShowConfig, StationConfig } from '../../src/domain/station.ts';
import type { Profile, Script, Source } from '../../src/domain/program.ts';
import { learnedWeights, rankCandidates } from '../../src/domain/recommendation.ts';
import type { FeedItem } from '../feed.ts';
import { ProviderError } from '../providers.ts';
import { SERIES_PREFIX, episodeRefOf, episodeShow } from '../../src/domain/series.ts';
import type { StoryChoice } from '../../src/domain/play.ts';
import { REVIEW_DAYS, REVIEW_SHOW, reviewSources } from '../review.ts';
import { NOVELTY_PROMPT, parseNovelty } from '../follow.ts';
import { featureOn } from '../../src/domain/features.ts';
import { clockValues, expandPlaceholders, usesHeadlines, usesWeather } from '../tools.ts';
import { finishScript, repairScript } from '../editing.ts';
import type { StationContext } from '../editing.ts';
import { blockOf, blockShow } from '../../src/domain/blocks.ts';
import { agentOf, resolveAgents } from '../../src/domain/agents.ts';
import { NOTE_WINDOW_DAYS, listenerNotes } from '../../src/domain/listener-notes.ts';
import { PipelineError, fitSources } from '../segment-pipeline.ts';
import type { TimelineRow } from '../station-store.ts';
import { LEASE_MINUTES, MAX_ATTEMPTS, HEADLINES_CACHE_MINUTES, MAX_SOURCE_AGE_DAYS, minutes, nextUtcMidnight } from './core.ts';
import type { StationDeps } from './core.ts';
import { CONCERT_SHOW, followOf, followSince } from './plan.ts';
import { requestedHourSubject, produceMusicHour, produceSong, wildcardTaste, airTime, daytime, produceMusicBlock } from './music.ts';
import { kidsRules } from './blocks.ts';
import { rememberEpisode, planChoice, writeQuiz, withQuiz } from './series.ts';
import { followUpOf } from './listener.ts';
import { toView } from './views.ts';

export function interestsOf(profile: Profile, text: string) {
  const lower = text.toLocaleLowerCase();
  return [...profile.topics, ...profile.interests].filter(interest => lower.includes(interest.toLocaleLowerCase()));
}

export async function collectSources(deps: StationDeps, owner: string, config: StationConfig, show: ShowConfig, profile: Profile): Promise<Source[]> {
  const now = deps.now();
  const collected: FeedItem[] = [];
  for (const feed of config.feeds.filter(feed => show.feedIds.includes(feed.id))) {
    try { await deps.reserveFeed(owner); } catch { break; }
    try { collected.push(...await deps.fetchFeed(feed.url)); } catch { /* One unreachable feed must not block the others. */ }
  }
  const unique = [...new Map(collected.map(item => [item.url, item])).values()]
    .filter(item => now.getTime() - Date.parse(item.publishedAt) <= MAX_SOURCE_AGE_DAYS * 86_400_000);
  const covered = await deps.store.coveredUrls(owner, unique.map(item => item.url));
  const candidates = unique.filter(item => !covered.has(item.url)).map(item => ({ ...item, interests: interestsOf(profile, `${item.title} ${item.excerpt}`) }));
  const ranked = rankCandidates(candidates, [...profile.topics, ...profile.interests], profile.interestWeights, profile.exploration, (deps.random ?? Math.random)(), profile.interests);
  return ranked.slice(0, show.format === 'podcast' ? 3 : 1).map((item, index) => ({
    id: `s${index + 1}`, url: item.url, title: item.title, excerpt: item.excerpt.slice(0, 8000),
    publishedAt: item.publishedAt, retrievedAt: now.toISOString(),
  }));
}

/** What comes before an item: for the bridge into it and the station ident after music. */
export async function stationContext(deps: StationDeps, owner: string, config: StationConfig, row: TimelineRow, now: Date): Promise<StationContext> {
  const air = airTime(row, now), clock = clockValues(air, config.timezone);
  const previous = await deps.store.previousItem(owner, row.seq);
  const before = previous ? toView(previous, config) : undefined;
  const musical = !!previous && (previous.show_id === MUSIC_SHOW_ID || bringsOwnMusic((config.shows.find(show => show.id === previous.show_id) ?? blockOf(previous.show_id)?.show)?.format ?? 'brief'));
  return { stationName: config.name, when: `${clock.wochentag}, am ${daytime(air, config.timezone)}`, afterMusic: musical,
    ...(stationSounds(config).linker ? { live: true } : {}),
    ...(before && previous!.show_id !== MUSIC_SHOW_ID ? { previous: before.title ?? before.showName } : {}) };
}

/**
 * The headlines of the day: the newest items of the owner's feeds (last 36 hours); without feeds, a
 * web search for today's most important news. Several blocks of a morning use them (Morgenbriefing,
 * Schlagzeilen, shows with the headlines tool), so a result is reused for [HEADLINES_CACHE_MINUTES].
 */
export async function headlines(deps: StationDeps, owner: string, config: StationConfig, now: Date, date: string): Promise<{ text: string; sources: Source[] }> {
  const key = `headlines:${now.toISOString().slice(0, 10)}`;
  const hit = await deps.store.cached(owner, key, HEADLINES_CACHE_MINUTES, now);
  if (hit) {
    try { return JSON.parse(hit) as { text: string; sources: Source[] }; } catch { /* A damaged entry is simply researched again. */ }
  }
  const collected: FeedItem[] = [];
  for (const feed of config.feeds) {
    try { await deps.reserveFeed(owner); } catch { break; }
    try { collected.push(...await deps.fetchFeed(feed.url)); } catch { /* One unreachable feed must not block the others. */ }
  }
  let sources: Source[] = [...new Map(collected.map(item => [item.url, item])).values()]
    .filter(item => now.getTime() - Date.parse(item.publishedAt) <= 36 * 3_600_000)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 6)
    .map((item, index) => ({ id: `h${index + 1}`, url: item.url, title: item.title, excerpt: item.excerpt.slice(0, 1500), publishedAt: item.publishedAt, retrievedAt: now.toISOString() }));
  if (!sources.length && deps.researcher) {
    const found = await deps.researcher.research({ brief: `Die wichtigsten Nachrichten von heute${date ? `, ${date}` : ''}: sechs Schlagzeilen aus der Schweiz und der Welt, jeweils mit einem Satz Einordnung.`, interests: [], avoidTopics: [], now, agent: agentOf(resolveAgents(config.agents), 'research') });
    sources = found.sources.slice(0, 6).map((source, index) => ({ ...source, id: `h${index + 1}` }));
  }
  const result = { text: sources.map(source => `– ${source.title}`).join('\n'), sources };
  if (sources.length) await deps.store.cache(owner, key, JSON.stringify(result), now);
  return result;
}

/** The owner's repeated reasons for 👎 in the last weeks, as notes for the prompts. */
export async function notesFor(deps: StationDeps, owner: string, now: Date): Promise<string[]> {
  return listenerNotes(await deps.store.reasonCounts(owner, new Date(now.getTime() - NOTE_WINDOW_DAYS * 86_400_000)));
}

/** Topic memory: titles of the most recent produced segments. */
export async function recentTopics(deps: StationDeps, owner: string): Promise<string[]> {
  const titles: string[] = [];
  for (const row of (await deps.store.recentItems(owner, 30)).reverse()) {
    if (!row.script_json || !['voicing', 'ready', 'played', 'skipped', 'archived'].includes(row.state)) continue;
    try { const title = (JSON.parse(row.script_json) as Script).title; if (title) titles.push(title); } catch { /* Skip corrupt rows. */ }
    if (titles.length >= 15) break;
  }
  return titles;
}

/** `continue`: part of the work is done and saved; the rest follows in a new queue message (a fresh invocation). */
export type ProduceOutcome = 'ready' | 'voicing' | 'failed' | 'deferred' | 'retry' | 'skipped' | 'continue';

/**
 * Advances one timeline item through planned → voicing → ready. The approved script is stored before
 * speech synthesis, so a TTS retry never pays for a second draft. Permanent problems fail the item;
 * transient provider errors back off and are retried by a later tick.
 */
export async function produceItem(deps: StationDeps, owner: string, itemId: string): Promise<ProduceOutcome> {
  const now = deps.now();
  const config = await deps.store.getConfig(owner);
  if (!config) return 'skipped';
  const agents = resolveAgents(config.agents);
  const row = await deps.store.lease(owner, itemId, now, minutes(now, LEASE_MINUTES));
  if (!row) return 'skipped';
  const fail = async (error: string) => { await deps.store.update(owner, row.id, { state: 'failed', lease_until: null, error }, deps.now()); return 'failed' as const; };
  // A building block added from the app is produced with its template.
  const block = blockOf(row.show_id);
  let configured = config.shows.find(item => item.id === row.show_id) ?? (block ? blockShow(block, config, requestedHourSubject(row) ?? wildcardTaste(block.id, deps)) : undefined);
  // An episode of a series is produced from the series: its step (knowledge) or its chapter (story).
  const episode = row.show_id.startsWith(SERIES_PREFIX) ? episodeRefOf(row.research_json) : null;
  let seriesSources: Source[] = [];
  let storyChoice: StoryChoice | null = null;
  const followId = followOf(row);
  let followed: { id: number; topic: string; known: string; createdAt: string; reportedAt: string | null } | null = null, followNote = '';
  if (row.show_id.startsWith(SERIES_PREFIX)) {
    const series = episode ? await deps.store.getSeries(owner, episode.series) : null;
    if (!series || !episode || !series.episodes[episode.episode]) return fail('SERIES_REMOVED');
    // A Mitmach-Geschichte ends each episode but the last with a choice, planned before the episode is written.
    if (series.interactive && row.state === 'planned' && episode.episode < series.episodes.length - 1) {
      storyChoice = series.choices?.[episode.episode] ?? await planChoice(deps, series, episode.episode, config);
      if (storyChoice && !series.choices?.[episode.episode]) {
        const choices = [...(series.choices ?? [])];
        while (choices.length <= episode.episode) choices.push(null);
        choices[episode.episode] = storyChoice;
        await deps.store.updateSeries(owner, series.id, { choices }, now);
      }
    }
    const built = episodeShow(series, episode.episode, now, kidsRules(config), storyChoice);
    // Without the dialog voices a knowledge episode is told by the host alone.
    configured = built.show.format === 'podcast' && !deps.podcastAvailable ? { ...built.show, format: 'brief' } : built.show;
    seriesSources = built.sources;
  }
  if (!configured && row.show_id !== MUSIC_SHOW_ID) return fail('SHOW_REMOVED');
  try {
    // Tools (switched on per show, or as placeholders like {wetter}) are filled in once per production;
    // weather and headlines also become sources, so the writer can cite them.
    let show = configured, toolSources: Source[] = [...seriesSources];
    if (configured) {
      // Items are produced ahead: date and time of day are those of the expected air time, and the
      // speech never names a clock time (the live time signal in the app does that).
      const air = airTime(row, now), values = clockValues(air, config.timezone, config.location);
      values.uhrzeit = daytime(air, config.timezone);
      const tools = new Set(configured.tools ?? []);
      if (usesWeather(configured)) tools.add('weather');
      if (usesHeadlines(configured)) tools.add('headlines');
      const notes: string[] = [];
      if (tools.has('clock')) notes.push(`Heute ist ${values.wochentag}, ${values.datum}; der Beitrag läuft voraussichtlich am ${values.uhrzeit}.`);
      // Only a new draft needs fresh information; a retry of the voice keeps the approved script.
      if (row.state === 'planned') {
        // The Wochenrückblick is written from the week's heard items, questions and stickers.
        if (row.show_id === REVIEW_SHOW) {
          const since = new Date(now.getTime() - REVIEW_DAYS * 86_400_000);
          toolSources.push(...reviewSources(await deps.store.heardSince(owner, since), await deps.week?.(owner, since) ?? { questions: [], stickers: [] }, now));
        }
        if (tools.has('weather')) {
          if (!config.location) return fail('NO_LOCATION');
          if (!deps.weather) return fail('WEATHER_NOT_CONFIGURED');
          const report = await deps.weather.report(config.location, config.timezone, now);
          values.wetter = report.text;
          toolSources.push(report.source);
          notes.push('Das aktuelle Wetter steht in der Quelle «wetter».');
        }
        if (tools.has('headlines')) {
          const news = await headlines(deps, owner, config, now, values.datum ?? '');
          values.schlagzeilen = news.text;
          toolSources.push(...news.sources);
          if (news.sources.length) notes.push('Die aktuellen Schlagzeilen stehen in den Quellen «h1» bis «h' + news.sources.length + '».');
        }
      }
      let researchPrompt = expandPlaceholders(configured.researchPrompt, values);
      // «Mehr dazu»: the item it deepens gives its sources and what was already said.
      const parentId = followUpOf(row);
      if (parentId && row.state === 'planned') {
        const parent = await deps.store.getItem(owner, parentId);
        let said: Script | undefined, before: Source[] = [];
        try { said = JSON.parse(parent?.script_json ?? 'null') ?? undefined; before = JSON.parse(parent?.sources_json ?? '[]'); } catch { /* Handled below. */ }
        if (!said?.title || typeof said.text !== 'string') return fail('FOLLOW_UP_WITHOUT_ITEM');
        const parentSources = before.slice(0, 6).map((source, index) => ({ ...source, id: `p${index + 1}`, excerpt: source.excerpt.slice(0, 2500) }));
        toolSources.push(...parentSources);
        notes.push(`Der vorherige Beitrag hiess «${said.title}» und sagte bereits: «${said.text.replace(/\s+/g, ' ').slice(0, 1500)}». Wiederhole das nicht, sondern gehe tiefer.${parentSources.length ? ` Seine Quellen stehen in «p1» bis «p${parentSources.length}».` : ''}`);
        // What the jury found missing in the first item is what this one looks for first.
        const missing = said.quality?.research?.trim();
        researchPrompt = `Recherchiere Hintergründe, Ursachen, Folgen und neue Aspekte zu «${said.title}», die über einen kurzen Nachrichtenbeitrag hinausgehen.${missing ? ` Vor allem: ${missing.slice(0, 300)}` : ''}`;
      }
      // Dranbleiben: research what is new about the topic since the last report.
      if (followId !== undefined && row.state === 'planned') {
        followed = await deps.follows?.get(owner, followId) ?? null;
        if (!followed) return fail('FOLLOW_REMOVED');
        const since = followSince(followed);
        researchPrompt = `Neue Entwicklungen zu «${followed.topic}» seit dem ${since.toISOString().slice(0, 10)}: was ist passiert, was wurde entschieden, was ist neu bekannt geworden? Nur Meldungen aus dieser Zeit.`;
      }
      // Konzerte: where the listener's Spotify top artists play soon (only artist names go to the AI).
      if (row.show_id === CONCERT_SHOW && row.state === 'planned') {
        const artists = (await deps.listening?.topArtists(owner, now).catch(() => []) ?? []).slice(0, 15);
        if (!artists.length) return fail('NO_ARTISTS');
        researchPrompt = `Angekündigte Konzerte in den nächsten vier Monaten in der Schweiz, möglichst nahe bei ${config.location?.name ?? 'Bern'} (etwa Bern, Zürich, Basel, Luzern), ` +
          `von diesen Künstlern: ${artists.join(', ')}. Nur bestätigte Termine mit Datum, Stadt und Halle.`;
      }
      const instructions = [expandPlaceholders(configured.instructions, values), ...notes].filter(Boolean).join(' ');
      show = { ...configured, instructions, researchPrompt };
    }
    if (!show) return await produceSong(deps, owner, config, row, fail);
    if (isMusicHour(show.format)) return await produceMusicHour(deps, owner, config, show, row, fail);
    if (show.format === 'music_block') return await produceMusicBlock(deps, owner, config, show, row, fail);
    let current = row;
    if (current.state === 'planned') {
      if (show.format === 'podcast' && !deps.podcastAvailable) return fail('PODCAST_PROVIDER_NOT_CONFIGURED');
      const generator = deps.generator ? deps.generator(show.textProvider, show.format) : undefined;
      if (deps.generator && !generator) return fail(show.textProvider === 'ask' ? 'ASK_NOT_CONFIGURED' : 'GEMINI_NOT_CONFIGURED');
      if (show.sourceMode === 'web' && !deps.researcher) return fail('GEMINI_NOT_CONFIGURED');
      await deps.reserveGeneration(owner);
      const profile: Profile = { ...config.profile, interestWeights: learnedWeights(await deps.store.feedback(owner), now.getTime()) };
      // A look back talks about the recent topics on purpose.
      const avoidTopics = row.show_id === REVIEW_SHOW ? [] : await recentTopics(deps, owner);
      let sources: Source[], queries: string[] = [];
      if (show.sourceMode === 'web') {
        ({ sources, queries } = await deps.researcher!.research({ brief: show.researchPrompt, interests: [...profile.topics, ...profile.interests], avoidTopics, now, agent: agentOf(agents, 'research') }));
      } else sources = await collectSources(deps, owner, config, show, profile);
      // Mark sources before drafting: a rejected article is not retried endlessly at provider cost.
      await deps.store.markCovered(owner, sources.map(source => source.url), now);
      // Tool results are evidence too; a show can live on them alone (a weather report). Together they must
      // fit what a draft accepts.
      sources = fitSources([...toolSources, ...sources]);
      // Nothing new to talk about is no fault: the item leaves the program quietly (the circuit breaker still counts it).
      if (!sources.length) {
        await deps.store.update(owner, row.id, { state: 'expired', lease_until: null, error: 'NO_SOURCES' }, deps.now());
        return 'skipped';
      }
      // Dranbleiben says nothing when there is nothing new: the check leaves the program quietly.
      if (followed) {
        const novelty = deps.agentModel ? parseNovelty(await deps.agentModel.askJson(NOVELTY_PROMPT, {
          thema: followed.topic, seit: followSince(followed).toISOString().slice(0, 10), bisher: followed.known || 'noch nichts',
          quellen: sources.slice(0, 8).map(source => ({ id: source.id, titel: source.title, datum: source.publishedAt, text: source.excerpt.slice(0, 1500) })),
        }, 'Gemini follow check', 0.2)) : { neu: true, was: '' };
        if (!novelty.neu) {
          await deps.store.update(owner, row.id, { state: 'expired', lease_until: null, error: 'NOTHING_NEW' }, deps.now());
          return 'skipped';
        }
        followNote = `Das Thema ist «${followed.topic}». Bisher bekannt: ${followed.known || 'noch nichts'}. Neu ist: ${novelty.was}`;
        followed.known = novelty.was;
      }
      const direction = { instructions: [show.instructions, followNote].filter(Boolean).join(' '), targetMinutes: show.targetMinutes, stationName: config.name, persona: config.host, avoidTopics, agents,
        listenerNotes: await notesFor(deps, owner, now), ...(episode?.kind === 'geschichte' ? { story: true } : {}) };
      let script = await deps.pipeline.draft(profile, sources, show.format === 'podcast' ? 'podcast' : 'brief', direction, generator);
      // Final desk: rewrite for the ear, connect to the program, score; facts are checked on the final text.
      const context = await stationContext(deps, owner, config, row, now);
      if (deps.editor) script = await finishScript(deps.editor, script, sources, direction, context);
      try { await deps.pipeline.review(script, sources, show.verification, agentOf(agents, 'verifier').instructions); }
      catch (error) {
        // A rejected script gets one repair: the editor drops or narrows the unsupported claims, then the check runs again.
        if (!(error instanceof PipelineError) || error.code !== 'REJECTED' || !deps.editor) throw error;
        const repaired = await repairScript(deps.editor, script, sources, direction, context, error.detail ?? '');
        if (repaired === script) throw error;
        script = repaired;
        await deps.pipeline.review(script, sources, show.verification, agentOf(agents, 'verifier').instructions);
      }
      if (script.quality) await deps.store.logQuality(owner, { itemId: row.id, showId: row.show_id, overall: script.quality.overall, at: now });
      // On a child's station a knowledge item ends with a quiz question, spoken and answered in the app.
      const quiz = kidsRules(config) && featureOn(config, 'quiz') && episode?.kind !== 'geschichte' && show.verification !== 'off' && show.targetMinutes >= 3 ? await writeQuiz(deps, script) : null;
      if (quiz) script = withQuiz(script, quiz);
      // The research record keeps what the item already carries (a requested subject, its series).
      const kept = (() => { try { return JSON.parse(row.research_json ?? 'null') ?? {}; } catch { return {}; } })() as Record<string, unknown>;
      const research = { ...kept, ...(queries.length ? { queries } : {}), ...(storyChoice ? { choice: storyChoice } : {}), ...(quiz ? { quiz } : {}) };
      const patch = { state: 'voicing' as const, script_json: JSON.stringify(script), sources_json: JSON.stringify(sources), verification: show.verification,
        research_json: Object.keys(research).length ? JSON.stringify(research) : null };
      await deps.store.update(owner, row.id, patch, deps.now());
      if (episode) await rememberEpisode(deps, owner, episode, script);
      if (followed) await deps.follows?.reported(owner, followed.id, followed.known, deps.now());
      current = { ...current, ...patch };
    }
    const script = JSON.parse(current.script_json ?? 'null') as Script;
    const format = script.turns ? 'podcast' : 'brief';
    // The show's own voice wins; otherwise the host persona speaks.
    // Dialogs speak with the host's and the co-host's voice; a brief with the show's own voice, else the host's.
    const voiced = await deps.pipeline.voice(owner, script, format, format === 'brief' ? show.voiceId ?? config.host.voiceId : undefined, config.host.voiceStyle,
      { bed: stationSounds(config).musicBed, compress: deps.compressSpeech, ...(format === 'podcast' ? { voices: [config.host.voiceId, config.host.cohostVoiceId] } : {}) });
    const key = `segments/${row.id}.${voiced.contentType === 'audio/wav' ? 'wav' : 'mp3'}`;
    await deps.audio.put(key, voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
    await deps.store.update(owner, row.id, { state: 'ready', lease_until: null, audio_key: key, content_type: voiced.contentType, error: null }, deps.now());
    return 'ready';
  } catch (error) {
    if (error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED') {
      await deps.store.update(owner, row.id, { lease_until: nextUtcMidnight(now).toISOString(), error: 'DAILY_LIMIT' }, deps.now());
      return 'deferred';
    }
    if (error instanceof ProviderError && error.status === 429) {
      // Rate limit or exhausted quota: wait as long as the provider asks (at least 2 minutes, at most 1 hour).
      // It is not the item's fault, so it neither uses up an attempt nor counts towards the failure pause.
      const waitMs = Math.min(Math.max(error.retryAfterMs ?? 0, 2 * 60_000), 60 * 60_000);
      await deps.store.update(owner, row.id, { lease_until: new Date(now.getTime() + waitMs).toISOString(), error: error.message.slice(0, 300) }, deps.now());
      return 'deferred';
    }
    if (error instanceof PipelineError && (error.code === 'REJECTED' || error.code === 'INVALID_INPUT')) return fail(error.message.slice(0, 300));
    const attempts = row.attempts + 1;
    const detail = (error instanceof Error ? error.message : 'UNKNOWN').slice(0, 160);
    if (attempts >= MAX_ATTEMPTS) {
      await deps.store.update(owner, row.id, { state: 'failed', attempts, lease_until: null, error: detail }, deps.now());
      return 'failed';
    }
    await deps.store.update(owner, row.id, { attempts, lease_until: minutes(now, 5 * 2 ** attempts).toISOString(), error: detail }, deps.now());
    return 'retry';
  }
}
