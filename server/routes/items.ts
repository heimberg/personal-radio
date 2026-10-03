import { PipelineError } from '../segment-pipeline.ts';
import { ProviderError } from '../providers.ts';
import { StationStore } from '../station-store.ts';
import { addFollowUp, deleteItem, removeItem, swapItem, toView, transcriptView, answerQuiz, chooseStory, AnswerError, answerAbout } from '../station.ts';
import { PlayStore } from '../play.ts';
import { BookmarkStore } from '../follow.ts';
import { SERIES_PREFIX } from '../../src/domain/series.ts';
import { isKids, parseListeners } from '../listeners.ts';
import { isFeedbackReason } from '../../src/domain/listener-notes.ts';
import type { FeedbackAction } from '../../src/domain/recommendation.ts';
import { json, readJson, statusFor } from '../http.ts';
import type { Environment, StoredAudio } from '../http.ts';
import { stationDeps, refreshProgram } from '../services.ts';

/** One timeline item: its audio, script, feedback, questions, and changing or removing it. */
export async function itemRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  const store = new StationStore(env.DB);
  const sameOrigin = request.headers.get('Origin') === url.origin;
  const match = url.pathname.match(/^\/api\/timeline\/([A-Za-z0-9-]{1,64})\/(audio|feedback|reason|more|swap|remove|delete|script|choice|quiz|ask|bookmark)$/);
  if (!match) return null;
  const row = await store.getItem(owner, match[1]);
  if (!row) return json({ error: 'not_found' }, 404);
  // «Nachfragen»: a question about this item, answered from its sources, voiced and placed right after it.
  if (match[2] === 'ask') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 1024);
    if (body.error) return body.error;
    const raw = (body.value as { text?: unknown } | null)?.text;
    const question = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (question.length < 3) return json({ error: 'invalid_question' }, 400);
    try {
      const answer = await answerAbout(stationDeps(env, owner), owner, row.id, question);
      return answer ? json(answer, 200) : json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof AnswerError) return json({ error: error.code === 'NOT_SPOKEN' ? 'not_spoken' : 'gemini_not_configured' }, 409);
      if (error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED') return json({ error: 'daily_limit' }, 429);
      if (error instanceof PipelineError || error instanceof ProviderError) return json({ error: 'answer_failed' }, error instanceof ProviderError && error.status === 429 ? 429 : statusFor(error));
      throw error;
    }
  }
  // Merken: the item, its title and sources on the reading list.
  if (match[2] === 'bookmark') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const view = toView(row, await store.getConfig(owner));
    await new BookmarkStore(env.DB).add(owner, { itemId: row.id, title: view.title ?? view.showName, showName: view.showName, sources: view.sources ?? [] }, new Date());
    return json({ ok: true }, 200);
  }
  // Mitmachen: choosing how a story goes on, answering a quiz question; both can earn a sticker.
  if (match[2] === 'choice' || match[2] === 'quiz') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 256);
    if (body.error) return body.error;
    const picked = (body.value as { option?: unknown } | null)?.option;
    if (!Number.isInteger(picked)) return json({ error: 'invalid_option' }, 400);
    const deps = stationDeps(env, owner), play = new PlayStore(env.DB), now = new Date();
    if (match[2] === 'choice') {
      const result = await chooseStory(deps, owner, row.id, picked as number);
      if (!result) return json({ error: 'no_choice' }, 409);
      const sticker = result.fresh ? await play.award(owner, 'choice', now) : undefined;
      // The next episode joins the program right away when this one was already heard.
      if (result.fresh) await refreshProgram(env, owner, false);
      return json({ picked: result.choice.picked, ...(sticker ? { sticker } : {}) }, 200);
    }
    const result = await answerQuiz(deps, owner, row.id, picked as number);
    if (!result) return json({ error: 'no_quiz' }, 409);
    const sticker = result.right && result.fresh ? await play.award(owner, 'quiz', now) : undefined;
    return json({ right: result.right, correct: result.quiz.correct, ...(sticker ? { sticker } : {}) }, 200);
  }
  if (match[2] === 'script') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json(transcriptView(row, await store.getConfig(owner)), 200);
  }
  if (match[2] === 'swap') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const itemId = await swapItem(stationDeps(env, owner), owner, row.id);
    if (!itemId) return json({ error: 'not_swappable' }, 409);
    await env.PRODUCTION.send({ owner, itemId });
    return json({ itemId }, 200);
  }
  if (match[2] === 'more') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const itemId = await addFollowUp(stationDeps(env, owner), owner, row.id);
    if (!itemId) return json({ error: 'not_deepenable' }, 409);
    await env.PRODUCTION.send({ owner, itemId });
    return json({ itemId }, 200);
  }
  if (match[2] === 'reason') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 256);
    if (body.error) return body.error;
    const reason = (body.value as { reason?: unknown } | null)?.reason;
    if (!isFeedbackReason(reason)) return json({ error: 'invalid_reason' }, 400);
    return await store.setReason(owner, row.id, reason) ? json({ ok: true }, 200) : json({ error: 'no_dislike' }, 409);
  }
  if (match[2] === 'delete') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await deleteItem(stationDeps(env, owner), owner, row.id) ? json({ ok: true }, 200) : json({ error: 'not_deletable' }, 409);
  }
  if (match[2] === 'remove') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await removeItem(stationDeps(env, owner), owner, row.id) ? json({ ok: true }, 200) : json({ error: 'not_open' }, 409);
  }
  if (match[2] === 'audio') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    // Artist hours keep one file per spoken part: ?part=<index into the hour's parts>.
    let key = row.audio_key, contentType = row.content_type;
    const part = url.searchParams.get('part');
    if (part !== null) {
      let parts: Array<{ kind?: string; audioKey?: string; contentType?: string }> = [];
      try { parts = (JSON.parse(row.script_json ?? '{}') as { parts?: typeof parts }).parts ?? []; } catch { /* No parts. */ }
      const chosen = /^\d{1,3}$/.test(part) ? parts[Number(part)] : undefined;
      key = chosen?.kind === 'speech' && chosen.audioKey ? chosen.audioKey : null;
      contentType = chosen?.contentType ?? 'audio/mpeg';
    }
    if (!key || row.state === 'expired') return json({ error: 'audio_unavailable' }, 404);
    const wantsRange = request.headers.has('Range');
    let object: StoredAudio | null;
    try { object = await env.AUDIO.get(key, wantsRange ? { range: request.headers } : undefined); }
    catch { return new Response(null, { status: 416 }); }
    if (!object) return json({ error: 'audio_unavailable' }, 404);
    const headers = new Headers({ 'Content-Type': contentType ?? 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', ETag: object.httpEtag });
    if (wantsRange && object.range) {
      const { offset, length, suffix } = object.range;
      const start = suffix !== undefined ? object.size - suffix : offset ?? 0;
      const size = suffix !== undefined ? suffix : length ?? object.size - start;
      headers.set('Content-Range', `bytes ${start}-${start + size - 1}/${object.size}`); headers.set('Content-Length', String(size));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
  const body = await readJson(request, 1024);
  if (body.error) return body.error;
  const { action, listenedRatio } = (body.value ?? {}) as { action?: unknown; listenedRatio?: unknown };
  if (!['like', 'dislike', 'skip', 'complete'].includes(String(action)) || typeof listenedRatio !== 'number' || !(listenedRatio >= 0 && listenedRatio <= 1)) {
    return json({ error: 'invalid_feedback' }, 400);
  }
  let interests: string[] = [];
  try { interests = (JSON.parse(row.script_json ?? '{}') as { interestTags?: string[] }).interestTags ?? []; } catch { /* Feedback without tags still marks playback. */ }
  const now = new Date();
  // Listening again from the archive does not count twice; ratings always count.
  const listening = action === 'complete' || action === 'skip';
  if (listening && row.state !== 'ready' && row.state !== 'archived') return json({ ok: true }, 200);
  await store.addFeedback(owner, { itemId: row.id, interests, action: action as FeedbackAction, listenedRatio, createdAt: now.toISOString() });
  if (listening) await store.update(owner, row.id, { state: action === 'complete' ? 'played' : 'skipped' }, now);
  // On a child's station every episode heard to the end earns a sticker.
  if (action === 'complete' && row.show_id.startsWith(SERIES_PREFIX) && isKids(owner, parseListeners(env.LISTENERS))) {
    return json({ ok: true, sticker: await new PlayStore(env.DB).award(owner, 'episode', now) }, 200);
  }
  return json({ ok: true }, 200);
}
