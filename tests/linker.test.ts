import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkerFacts, linkerKey, linkerSystem, linkerText, silentWav } from '../server/linker.ts';
import { defaultStationConfig, parseStationConfig, stationSounds } from '../src/domain/station.ts';
import type { TimelineRow } from '../server/station-store.ts';

const config = { ...defaultStationConfig({ profile: { topics: [], interests: [], interestWeights: {}, speechMinutes: 2, exploration: 0 } }), name: 'Radio Melchnau' };
const row = (id: string, showId: string, script: unknown): TimelineRow => ({
  id, owner_id: 'o', seq: 1, show_id: showId, planned_at: '2026-09-29T18:00:00Z', estimated_minutes: 3, state: 'ready', attempts: 0, lease_until: null,
  script_json: JSON.stringify(script), sources_json: null, verification: null, audio_key: null, content_type: null, research_json: null, error: null,
  created_at: '2026-09-29T18:00:00Z', updated_at: '2026-09-29T18:00:00Z',
});
const NOW = new Date('2026-09-29T18:35:00Z');
const next = row('n1', 'kurz', { title: 'Die Sonde ist gelandet', text: '…', sourceIds: [] });

test('the link knows the time of day (never the clock), what comes next and the song before, unless it came from a playlist', () => {
  const song = row('a1', '_musik', { kind: 'song', title: 'Björk – Joga', parts: [{ kind: 'speech', text: 'x' }, { kind: 'track', title: 'Joga', artist: 'Björk' }] });
  assert.deepEqual(linkerFacts(config, song, next, 'Kurzbeitrag', NOW), {
    station: 'Radio Melchnau', host: config.host.name, weekday: 'Dienstag', daytime: 'Abend',
    before: { music: true, song: 'Björk – Joga' }, next: { title: 'Die Sonde ist gelandet', show: 'Kurzbeitrag' },
  });
  const block = row('b1', '_block:musik', { kind: 'music_block', title: 'Indie am Abend', parts: [
    { kind: 'track', title: 'Neu', artist: 'Björk', picked: 'release' }, { kind: 'track', title: 'Privat', artist: 'Jemand', picked: 'playlist' }] });
  const facts = linkerFacts(config, block, next, 'Kurzbeitrag', NOW);
  assert.deepEqual(facts.before, { music: true, title: 'Indie am Abend' });
  assert.ok(!JSON.stringify(facts).includes('Privat') && !JSON.stringify(facts).includes('Jemand'));
  const spoken = row('s1', 'kurz', { title: 'Wetter in Bern', text: '…', sourceIds: [] });
  assert.deepEqual(linkerFacts(config, spoken, next, 'Kurzbeitrag', NOW).before, { music: false, title: 'Wetter in Bern' });
  assert.equal(linkerFacts(config, null, next, 'Kurzbeitrag', NOW).before, undefined);
});

test('the link text is short and clean; the station is named only after music or at the start', () => {
  assert.equal(linkerText({ text: '  Kurz nach **halb neun** –\n weiter geht es.  ' }), 'Kurz nach halb neun – weiter geht es.');
  assert.equal(linkerText({ text: 'Hi' }), null);
  assert.equal(linkerText(null), null);
  const long = linkerText({ text: `${'Ein Satz mit Inhalt. '.repeat(30)}` })!;
  assert.ok(long.length <= 320 && long.endsWith('.'));
  assert.match(linkerSystem(config, true), /Nenne den Sender «Radio Melchnau» einmal/);
  assert.match(linkerSystem(config, false), /Nenne den Sender nicht/);
  assert.match(linkerSystem(config, true), /Nenne keine Uhrzeit/);
  assert.match(linkerKey('2026-09-29', null, 'n1', 'v'), /^linkers\/2026-09-29\/start-n1-[a-z0-9]+$/);
  assert.notEqual(linkerKey('2026-09-29', 'a', 'n1', 'v1'), linkerKey('2026-09-29', 'a', 'n1', 'v2'));
  assert.equal(new TextDecoder().decode(silentWav().subarray(0, 4)), 'RIFF');
});

test('live transitions and the bed default to on and can be switched off', () => {
  assert.deepEqual(stationSounds(config), { ident: true, hourChange: true, linker: true, bed: true });
  const off = parseStationConfig({ ...config, sounds: { ident: true, hourChange: false, linker: false, bed: false } });
  assert.deepEqual(stationSounds(off), { ident: true, hourChange: false, linker: false, bed: false });
  assert.deepEqual(stationSounds(parseStationConfig({ ...config, sounds: { ident: false, hourChange: true } })), { ident: false, hourChange: true, linker: true, bed: true });
  assert.throws(() => parseStationConfig({ ...config, sounds: { ident: true, hourChange: true, linker: 'ja' } }), /sounds\.linker/);
});
