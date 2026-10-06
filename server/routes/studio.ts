import { PipelineError } from '../segment-pipeline.ts';
import { fetchFeed, FeedError, validateFeedUrl } from '../feed.ts';
import { StationStore } from '../station-store.ts';
import { showNameOf, trialAgent } from '../station.ts';
import type { TrialAgent } from '../station.ts';
import { ConfigError, MOOD_IDS, defaultStationConfig, formatList, parseStationConfig } from '../../src/domain/station.ts';
import type { MoodId, StationConfig } from '../../src/domain/station.ts';
import { endOfDay } from '../../src/domain/mood.ts';
import { AGENTS, agentOf, parseAgentConfig, resolveAgents } from '../../src/domain/agents.ts';
import { AGENT_PRESETS } from '../../src/domain/agent-presets.ts';
import { usageSummary } from '../usage.ts';
import { FEATURES, featureOn, parseFeatures, parseHiddenBlocks } from '../../src/domain/features.ts';
import { allBlockViews } from '../../src/domain/blocks.ts';
import { generationLimit, isKids, listenersOf } from '../listeners.ts';
import { FEEDBACK_REASONS, NOTE_MIN_COUNT, NOTE_WINDOW_DAYS, listenerNotes } from '../../src/domain/listener-notes.ts';
import { json, readJson } from '../http.ts';
import { backupRoutes } from '../backups.ts';
import type { Environment } from '../http.ts';
import { D1FeedCounter } from '../counters.ts';
import { stationDeps, refreshProgram } from '../services.ts';

/** The studio: station settings, setup, agents and formats, mood, features, quality, feed checks. */
export async function studioRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  const store = new StationStore(env.DB);
  const sameOrigin = request.headers.get('Origin') === url.origin;
  if (url.pathname === '/api/station') {
    if (request.method === 'GET') return json({ config: await store.getConfig(owner) }, 200);
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 65_536);
    if (body.error) return body.error;
    try {
      // Today's mood is set in the app (POST /api/mood); saving the settings keeps it.
      const { mood: _mood, ...parsed } = parseStationConfig(body.value);
      const before = await store.getConfig(owner), now = new Date();
      const config: StationConfig = before?.mood ? { ...parsed, mood: before.mood } : parsed;
      const changed = AGENTS.filter(agent => JSON.stringify(before?.agents?.[agent.id] ?? null) !== JSON.stringify(config.agents?.[agent.id] ?? null)).map(agent => agent.name);
      await store.saveConfig(owner, config, now);
      if (before && changed.length) await store.logAgentChange(owner, now, changed);
      return json({ config }, 200);
    } catch (error) {
      if (error instanceof ConfigError) return json({ error: 'invalid_config', detail: error.message }, 400);
      throw error;
    }
  }
  if (url.pathname === '/api/setup') {
    // The first start in the app: a station with the default shows, planned right away.
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    if (await store.getConfig(owner)) return json({ error: 'already_configured' }, 409);
    const body = await readJson(request, 4096);
    if (body.error) return body.error;
    // The first-start flow may bring interests, a voice and a music taste; the rest are the defaults.
    const input = (body.value ?? {}) as { timezone?: unknown; interests?: unknown; voiceId?: unknown; taste?: unknown };
    const base = defaultStationConfig({ timezone: typeof input.timezone === 'string' ? input.timezone : undefined });
    const interests = Array.isArray(input.interests)
      ? [...new Set(input.interests.filter((item): item is string => typeof item === 'string').map(item => item.replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))].slice(0, 20) : [];
    let config = base;
    try {
      config = parseStationConfig({
        ...base,
        ...(interests.length ? { profile: { ...base.profile, interests } } : {}),
        ...(typeof input.voiceId === 'string' && input.voiceId.trim() ? { host: { ...base.host, voiceId: input.voiceId.trim().slice(0, 100) } } : {}),
        ...(typeof input.taste === 'string' && input.taste.trim() ? { music: { ...base.music, taste: input.taste.trim().slice(0, 300) } } : {}),
      });
    } catch (error) {
      return json({ error: 'invalid_setup', detail: error instanceof Error ? error.message.slice(0, 200) : 'ungültig' }, 400);
    }
    await store.saveConfig(owner, config, new Date());
    await refreshProgram(env, owner, false);
    return json({ config }, 201);
  }
  if (url.pathname === '/api/agents') {
    // What the app's «Redaktion» shows: every agent with its shipped instructions, and the style presets.
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({ agents: AGENTS, presets: AGENT_PRESETS }, 200);
  }
  if (url.pathname === '/api/diagnostics/crash') {
    // A crash of the app, sent on its next start: version, device and the first lines of the trace.
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 16_384);
    if (body.error) return body.error;
    const { version, device, trace } = (body.value ?? {}) as { version?: unknown; device?: unknown; trace?: unknown };
    if (typeof trace !== 'string' || !trace.trim()) return json({ error: 'invalid_crash' }, 400);
    const head = [version, device].filter((part): part is string => typeof part === 'string' && !!part.trim()).map(part => part.slice(0, 60)).join(' · ');
    await store.logError(owner, 'app', `${head ? `${head}: ` : ''}${trace.trim().slice(0, 1200)}`, new Date());
    return json({ ok: true }, 200);
  }
  if (url.pathname === '/api/backups' || url.pathname === '/api/backups/restore') return backupRoutes(request, env, owner, url, sameOrigin);
  if (url.pathname === '/api/diagnostics') {
    // The studio's «Diagnose»: the latest errors of productions, transitions and the queue.
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({ errors: await store.errors(owner) }, 200);
  }
  if (url.pathname === '/api/formats') {
    // The show formats with the lengths the config check accepts, so the app's editor never offers more.
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({ formats: formatList() }, 200);
  }
  if (url.pathname === '/api/mood') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 256);
    if (body.error) return body.error;
    const id = (body.value as { mood?: unknown } | null)?.mood ?? null;
    if (id !== null && !MOOD_IDS.includes(id as MoodId)) return json({ error: 'invalid_mood' }, 400);
    const config = await store.getConfig(owner), now = new Date();
    if (!config) return json({ error: 'not_configured' }, 409);
    // A mood holds until midnight in the station's time zone; null clears it.
    const { mood: _old, ...rest } = config;
    const next: StationConfig = id === null ? rest : { ...rest, mood: { id: id as MoodId, until: endOfDay(now, config.timezone).toISOString() } };
    await store.saveConfig(owner, next, now);
    return json({ mood: next.mood ?? null }, 200);
  }
  // Funktionen: what the station does on its own, and which blocks the palette shows – managed in one place.
  if (url.pathname === '/api/features') {
    const config = await store.getConfig(owner);
    if (!config) return json({ error: 'not_configured' }, 404);
    const kids = isKids(owner, await listenersOf(env));
    const view = (current: typeof config) => ({
      features: FEATURES.filter(feature => !feature.only || (feature.only === 'kids') === kids)
        .map(({ id, name, description, cost }) => ({ id, name, description, cost, enabled: featureOn(current, id) })),
      blocks: allBlockViews(current).map(({ id, name, description }) => ({ id, name, description, visible: !(current.hiddenBlocks ?? []).includes(id) })),
    });
    if (request.method === 'GET') return json(view(config), 200);
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 8192);
    if (body.error) return body.error;
    const input = (body.value ?? {}) as { features?: Record<string, unknown>; hiddenBlocks?: unknown };
    const changed = parseFeatures(input.features) ?? {};
    const linker = input.features?.linker;
    const next: typeof config = {
      ...config,
      features: { ...config.features, ...changed },
      ...(typeof linker === 'boolean' ? { sounds: { ident: true, hourChange: true, ...config.sounds, linker } } : {}),
      ...(input.hiddenBlocks !== undefined ? { hiddenBlocks: parseHiddenBlocks(input.hiddenBlocks) ?? [] } : {}),
    };
    if (!next.hiddenBlocks?.length) delete next.hiddenBlocks;
    if (!Object.keys(next.features ?? {}).length) delete next.features;
    await store.saveConfig(owner, next, new Date());
    return json(view(next), 200);
  }
  if (url.pathname === '/api/insights') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const now = new Date(), since = new Date(now.getTime() - 30 * 86_400_000);
    const [counts, quality, changes, usage, config, byShow] = await Promise.all([
      store.reasonCounts(owner, new Date(now.getTime() - NOTE_WINDOW_DAYS * 86_400_000)), store.qualityLog(owner, since), store.agentChanges(owner, since),
      usageSummary(env.DB, owner, now, 14, { generations: generationLimit(owner, await listenersOf(env), Math.max(1, Number(env.DAILY_GENERATIONS) || 24)), ttsCharacters: Math.max(1, Number(env.DAILY_TTS_CHARACTERS) || 12_000) },
        env.GEMINI_API_KEY ? { model: env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts', liteModel: env.GEMINI_TTS_LITE_MODEL || 'gemini-3.8-flash-lite-tts', dailyRequests: Math.max(1, Number(env.GEMINI_TTS_DAILY_REQUESTS) || 100) } : undefined),
      store.getConfig(owner),
      store.producedByShow(owner, new Date(now.getTime() - 7 * 86_400_000)),
    ]);
    // Shows the jury keeps marking below its bar over 30 days (at least three marks), weakest first, with its latest notes.
    const bar = agentOf(config?.agents ? resolveAgents(config.agents) : undefined, 'jury').threshold;
    const perShow = new Map<string, number[]>();
    for (const entry of quality) perShow.set(entry.showId, [...perShow.get(entry.showId) ?? [], entry.overall]);
    const weak = [...perShow].map(([showId, marks]) => ({ showId, count: marks.length, average: Math.round(marks.reduce((sum, mark) => sum + mark, 0) / marks.length * 10) / 10 }))
      .filter(show => show.count >= 3 && show.average < bar).sort((a, b) => a.average - b.average).slice(0, 5);
    const weakShows = await Promise.all(weak.map(async show => ({ ...show, showName: showNameOf(show.showId, config), notes: await store.juryNotes(owner, show.showId) })));
    return json({
      weakShows, juryBar: bar,
      byShow: byShow.map(entry => ({ ...entry, showName: showNameOf(entry.showId, config) })),
      reasons: counts.map(item => ({ ...item, label: FEEDBACK_REASONS[item.reason].label, active: item.count >= NOTE_MIN_COUNT })),
      notes: listenerNotes(counts),
      quality: quality.map(entry => ({ ...entry, showName: showNameOf(entry.showId, config) })),
      changes, usage, timezone: config?.timezone ?? 'UTC',
    }, 200);
  }
  if (url.pathname === '/api/insights/reasons') {
    if (request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    await store.clearReasons(owner);
    return json({ ok: true }, 200);
  }
  if (url.pathname === '/api/agents/trial') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 65_536);
    if (body.error) return body.error;
    const { agent, agents } = (body.value ?? {}) as { agent?: unknown; agents?: unknown };
    if (!AGENTS.some(item => item.trial && item.id === agent)) return json({ error: 'invalid_agent' }, 400);
    let draft;
    try { draft = parseAgentConfig(agents, (path, expected) => { throw new ConfigError(`${path}: ${expected}`); }); }
    catch (error) {
      if (error instanceof ConfigError) return json({ error: 'invalid_config', detail: error.message }, 400);
      throw error;
    }
    const result = await trialAgent(stationDeps(env, owner), owner, agent as TrialAgent, draft);
    return json(result, result.ok ? 200 : result.error === 'NO_ITEM' ? 404 : result.error === 'NOT_CONFIGURED' ? 409 : 502);
  }
  if (url.pathname === '/api/feed-items') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    if (Number(request.headers.get('Content-Length') ?? 0) > 4096) return json({ error: 'request_too_large' }, 413);
    if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return json({ error: 'json_required' }, 415);
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 4096) return json({ error: 'request_too_large' }, 413);
      let body: { url?: unknown };
      try { body = JSON.parse(raw) as { url?: unknown }; } catch { return json({ error: 'invalid_json' }, 400); }
      try { validateFeedUrl(body.url); } catch { return json({ error: 'invalid_feed_url' }, 400); }
      try { await new D1FeedCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_FEED_REQUESTS) || 60)); }
      catch (error) {
        if (error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED') return json({ error: 'feed_daily_limit' }, 429);
        return json({ error: 'feed_quota_unavailable' }, 503);
      }
      return json({ items: await fetchFeed(body.url) }, 200);
    } catch (error) {
      const status = error instanceof FeedError ? error.code === 'INVALID_FEED_URL' ? 400 : 422 : 502;
      const code = error instanceof FeedError ? error.code.toLowerCase() : 'feed_unavailable';
      return json({ error: code }, status);
    }
  }
  return null;
}
