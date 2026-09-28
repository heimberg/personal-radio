import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import { produceItem, scheduleShowNow } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { OpenMeteo, clockValues, expandPlaceholders, usesWeather } from '../server/tools.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const NOW = new Date('2026-09-28T05:30:00Z');
const BERN = { name: 'Bern', latitude: 46.948, longitude: 7.4474 };
const forecast = {
  current: { temperature_2m: 11.6, weather_code: 2, wind_speed_10m: 7.2 },
  daily: { weather_code: [61, 0], temperature_2m_max: [17.4, 20.1], temperature_2m_min: [9.2, 8.6], precipitation_probability_max: [70, null] },
};

test('placeholders: date, weekday and time in the station time zone; unknown values leave the word, never braces', () => {
  const values = clockValues(NOW, 'Europe/Zurich', BERN);
  assert.deepEqual(values, { datum: '28. September 2026', wochentag: 'Montag', uhrzeit: '07:30', ort: 'Bern' });
  assert.equal(expandPlaceholders('Guten Morgen {Ort}, heute ist {wochentag}, {datum}. {wetter}', values), 'Guten Morgen Bern, heute ist Montag, 28. September 2026. wetter');
  assert.equal(expandPlaceholders('{unbekannt} bleibt', values), '{unbekannt} bleibt');
  assert.ok(usesWeather({ instructions: 'Sag das {Wetter}', researchPrompt: '' }));
  assert.ok(!usesWeather({ instructions: 'Wetterbericht', researchPrompt: '' }));
});

test('Open-Meteo: forecast becomes a German report and a source; places are found by name', async () => {
  const urls: string[] = [];
  const meteo = new OpenMeteo(async url => {
    urls.push(String(url));
    return String(url).startsWith('https://geocoding-api.open-meteo.com/')
      ? Response.json({ results: [{ name: 'Bern', admin1: 'Bern', country: 'Schweiz', latitude: 46.948, longitude: 7.4474 }, { name: 'kaputt' }] })
      : Response.json(forecast);
  });
  const report = await meteo.report(BERN, 'Europe/Zurich', NOW);
  assert.equal(report.text, 'Wetter in Bern: Jetzt 12 °C, teils bewölkt, Wind 7 km/h. Heute: leichter Regen, 9 bis 17 °C, Regenwahrscheinlichkeit 70 %. Morgen: klar, 9 bis 20 °C.');
  assert.equal(report.source.id, 'wetter');
  assert.ok(report.source.excerpt.includes('Heute: leichter Regen'));
  assert.match(urls[0], /latitude=46\.9480&longitude=7\.4474&timezone=Europe%2FZurich/);
  assert.deepEqual(await meteo.places('Bern'), [{ name: 'Bern', region: 'Bern', country: 'Schweiz', latitude: 46.948, longitude: 7.4474 }]);
  await assert.rejects(new OpenMeteo(async () => new Response('', { status: 503 })).report(BERN, 'UTC', NOW), /Open-Meteo weather request failed \(503\)/);
});

test('a show with {wetter} gets the report in its instructions and as evidence; without a location it fails clearly', async () => {
  const base = defaultStationConfig({ timezone: 'Europe/Zurich' });
  const weatherShow = { ...base.shows[0], id: 'morgen', name: 'Morgen', enabled: true, format: 'brief' as const, sourceMode: 'feeds' as const, feedIds: [],
    instructions: 'Begrüsse mich zum {wochentag} in {ort}. {wetter}', researchPrompt: '' };
  const station = parseStationConfig({ ...base, location: BERN, music: { ...base.music, between: 0 }, shows: [...base.shows, weatherShow] });
  const store = new StationStore(sqliteD1());
  let direction: EditorialDirection | undefined, drafted: Source[] = [];
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => NOW, newId: () => `item-${Math.random()}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    weather: { report: async location => ({ text: `Wetter in ${location.name}: sonnig.`, source: { id: 'wetter', url: 'https://open-meteo.com/', title: 'Wetter', excerpt: 'sonnig', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() } }) },
    pipeline: {
      draft: async (_profile, sources, _mode, given): Promise<Script> => { direction = given; drafted = sources; return { title: 'Guten Morgen', text: 'Text.', sourceIds: ['wetter'] }; },
      review: async () => ({ approved: true, reasons: [] }),
      voice: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 5 }),
    },
  };
  await store.saveConfig('o', station, NOW);
  const id = (await scheduleShowNow(deps, 'o', 'morgen'))!;
  assert.equal(await produceItem(deps, 'o', id), 'ready');
  assert.equal(direction?.instructions, 'Begrüsse mich zum Montag in Bern. Wetter in Bern: sonnig. Das aktuelle Wetter steht in der Quelle «wetter».');
  assert.deepEqual(drafted.map(source => source.id), ['wetter']);

  await store.saveConfig('o', parseStationConfig({ ...station, location: undefined }), NOW);
  const other = (await scheduleShowNow(deps, 'o', 'morgen'))!;
  assert.equal(await produceItem(deps, 'o', other), 'failed');
  assert.equal((await store.getItem('o', other))?.error, 'NO_LOCATION');
  assert.throws(() => parseStationConfig({ ...station, location: { name: 'X', latitude: 91, longitude: 0 } }), /location\.latitude/);
});
