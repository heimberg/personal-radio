import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnedWeights, parseFeedback, rankCandidates } from '../src/domain/recommendation.ts';

const event = (action: 'like' | 'dislike' | 'skip' | 'complete', listenedRatio = 1, createdAt = '2026-09-26T00:00:00.000Z') => ({
  itemId: `item-${action}`, interests: ['Geologie'], action, listenedRatio, createdAt,
});

test('explicit ratings outweigh completions and a very early skip is ignored', () => {
  const now = Date.parse('2026-09-26T00:00:00.000Z');
  const weights = learnedWeights([event('like'), event('complete'), event('skip', 0.05)], now);
  assert.ok(Math.abs(weights.Geologie! - (1.18 / 3)) < 0.0001);
  assert.equal(learnedWeights([event('skip', 0.05)], now).Geologie, undefined);
});

test('negative explicit feedback lowers interest and old signals decay', () => {
  const now = Date.parse('2026-09-26T00:00:00Z');
  const fresh = learnedWeights([event('like')], now).Geologie;
  const old = learnedWeights([event('like', 1, '2026-06-28T00:00:00.000Z')], now).Geologie;
  assert.ok(fresh! > old!);
  assert.equal(learnedWeights([event('dislike')], now).Geologie, -0.5);
});

test('ranking promotes explicit interests and retains deliberate exploration', () => {
  const candidates = [
    { id: 'history', interests: ['Geschichte'] },
    { id: 'science', interests: ['Geologie'] },
    { id: 'other', interests: ['Kultur'] },
  ];
  const ordered = rankCandidates(candidates, ['Geologie'], {}, 0, 1);
  assert.equal(ordered[0]?.id, 'science');
  assert.deepEqual(new Set(ordered.slice(1).map(item => item.id)), new Set(['history', 'other']));
  const explore = rankCandidates(candidates, ['Geologie'], {}, 50, 0);
  assert.equal(explore.length, candidates.length);
  assert.notEqual(explore[0]?.id, 'science');
});

test('repeated negative evidence can suppress an explicit interest in candidate ranking', () => {
  const now = Date.parse('2026-09-26T00:00:00Z');
  const weights = learnedWeights([event('dislike'), { ...event('dislike'), itemId: 'item-2' }, { ...event('dislike'), itemId: 'item-3' }], now);
  const ordered = rankCandidates([{ id: 'geo', interests: ['Geologie'] }, { id: 'other', interests: ['Kultur'] }], ['Geologie'], weights, 0, 1);
  assert.equal(ordered[0]?.id, 'other');
});

test('feedback storage is validated and bounded', () => {
  assert.deepEqual(parseFeedback([event('like'), { ...event('skip'), listenedRatio: 9 }, null]).length, 1);
});
