import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

function silentWav(seconds: number) {
  const rate = 8000, samples = rate * seconds, buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

const station = () => ({
  version: 1, name: 'Radio Melchnau', host: { name: 'Mira', tone: 'ruhig', style: 'Radio', instructions: '', voiceId: 'de_kerstin_cc0' }, timezone: 'Europe/Zurich', horizonMinutes: 20,
  profile: { topics: ['Wissenschaft'], interests: ['Geologie'], interestWeights: {}, speechMinutes: 2, exploration: 20 },
  feeds: [{ id: 'feed-1', name: 'Wissen', url: 'https://feeds.example.test/wissen.xml' }],
  shows: [
    { id: 'entdecken', name: 'Entdeckungen', enabled: true, format: 'brief', instructions: '', feedIds: [], targetMinutes: 2, verification: 'strict', textProvider: 'gemini', sourceMode: 'web', researchPrompt: 'Neues' },
    { id: 'kuenstler', name: 'Künstler-Stunde', enabled: false, format: 'artist_hour', instructions: '', feedIds: [], targetMinutes: 60, verification: 'light', textProvider: 'gemini', sourceMode: 'web', researchPrompt: '', tracks: 10, talkSeconds: 60 },
  ],
  schedule: [{ id: 'immer', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', showIds: ['entdecken'] }],
});

/** A private Worker in memory: station config, timeline and the program actions. */
async function fakeWorker(page: Page, initial: unknown) {
  const state = { stored: initial as any, saved: [] as any[], feedback: [] as any[], calls: [] as string[] };
  await page.route('**/api/station', async route => {
    if (route.request().method() === 'PUT') { state.stored = JSON.parse(route.request().postData() ?? '{}'); state.saved.push(state.stored); }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ config: state.stored }) });
  });
  await page.route('**/api/mistral-voices', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ voices: [{ id: 'de_kerstin_cc0', name: 'Kerstin · Deutsch (CC0)' }, { id: 'fr_marie_neutral', name: 'Marie · Neutral' }] }) }));
  await page.route('**/api/timeline', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: state.stored ? [
    { id: 't1', seq: 1, showId: 'entdecken', showName: 'Entdeckungen', plannedAt: '2026-09-27T08:00:00.000Z', state: 'ready', estimatedMinutes: 2,
      title: 'Sonde gelandet', verification: 'strict', interestTags: ['Raumfahrt'], audioUrl: 'api/timeline/t1/audio',
      sources: [{ title: 'Raumfahrt heute', url: 'https://news.example.test/a' }], searchQueries: ['sonde landung'] },
    { id: 'h1', seq: 2, showId: 'kuenstler', showName: 'Künstler-Stunde', plannedAt: '2026-09-27T08:02:00.000Z', state: 'ready', estimatedMinutes: 60,
      title: 'Portishead', focus: 'artist', subject: 'Portishead', parts: [{ kind: 'speech', audioUrl: 'api/timeline/h1/audio?part=0' },
        { kind: 'track', spotifyUri: 'spotify:track:1', title: 'Glory Box', artist: 'Portishead', durationMs: 1 }] },
  ] : [], failures: state.stored ? { count: 1, latestError: 'NO_SOURCES', latestAt: '2026-09-27T13:31:00.000Z' } : { count: 0 } }) }));
  for (const action of ['plan', 'retry', 'cleanup']) {
    await page.route(`**/api/timeline/${action}`, route => { state.calls.push(action); return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(action === 'plan' ? { planned: 2, queued: 2 } : action === 'retry' ? { retired: 1, restarted: 0, planned: 1, queued: 1 } : { removed: 1 }) }); });
  }
  await page.route('**/api/shows/*/produce', route => { state.calls.push(new URL(route.request().url()).pathname); return route.fulfill({ contentType: 'application/json', body: '{"itemId":"x"}' }); });
  await page.route('**/api/timeline/t1/audio', route => route.fulfill({ contentType: 'audio/wav', body: silentWav(2) }));
  await page.route('**/api/timeline/t1/feedback', async route => { state.feedback.push(JSON.parse(route.request().postData() ?? '{}')); await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
  return state;
}

test('first visit sets up the station and plans the program', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const worker = await fakeWorker(page, null);
  await page.goto('/');
  await page.getByRole('button', { name: 'Programm einrichten' }).click();
  await expect(page.getByRole('button', { name: '▶ Programm hören' })).toBeVisible();
  expect(worker.calls).toContain('plan');
  expect(worker.saved[0].shows.map((show: any) => show.id)).toEqual(['kurz', 'dialog', 'entdecken', 'kuenstler', 'genre', 'thema']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('program view: timeline, actions, browser playback with feedback; music hours are listed but left to the app', async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalAudio = window.Audio;
    window.Audio = class extends OriginalAudio {
      constructor(src?: string) { super(src); (window as unknown as { testAudio: HTMLAudioElement }).testAudio = this; }
    };
  });
  const external: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173')) external.push(request.url()); });
  const worker = await fakeWorker(page, station());
  await page.goto('/');
  await expect(page.getByText('Radio Melchnau')).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Programmablauf' });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await expect(timeline.getByText(/♫ Portishead: Glory Box/)).toBeVisible();
  await expect(timeline.getByRole('link', { name: 'Raumfahrt heute' })).toHaveAttribute('href', 'https://news.example.test/a');
  await expect(timeline.getByRole('link', { name: 'sonde landung' })).toHaveAttribute('href', 'https://www.google.com/search?q=sonde%20landung');
  await expect(page.getByText(/⚠ 1 fehlgeschlagen · zuletzt \d\d:\d\d: Keine neuen Quellen/)).toBeVisible();

  await page.getByLabel('Sendung sofort produzieren').selectOption('kuenstler');
  await page.getByRole('button', { name: 'Jetzt produzieren' }).click();
  await expect(page.getByText('«Künstler-Stunde» wird produziert.')).toBeVisible();
  await page.getByRole('button', { name: 'Aufräumen' }).click();
  await expect(page.getByText('1 Einträge entfernt.')).toBeVisible();
  await page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(page.getByText('1 Fehlschläge abgeräumt, 0 wartende Beiträge neu gestartet, 1 neu geplant, 1 in Produktion.')).toBeVisible();
  expect(worker.calls).toEqual(['/api/shows/kuenstler/produce', 'cleanup', 'retry']);

  // Only the spoken segment plays in the browser.
  await expect(page.getByText('1 Beitrag bereit')).toBeVisible();
  await page.getByRole('button', { name: '▶ Programm hören' }).click();
  await expect(page.getByRole('heading', { name: 'Sonde gelandet' })).toBeVisible();
  await expect(page.getByText('Läuft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mehr davon' }).click();
  await expect(page.getByRole('button', { name: 'Mehr davon' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { const audio = (window as unknown as { testAudio: HTMLAudioElement }).testAudio; audio.currentTime = audio.duration - 0.1; });
  await expect.poll(() => worker.feedback).toEqual([{ action: 'like', listenedRatio: 1 }, { action: 'complete', listenedRatio: 1 }]);
  expect(external).toEqual([]);
});

test('settings: persona, interests, a new theme hour with its subject and the schedule are edited as forms', async ({ page }) => {
  const worker = await fakeWorker(page, station());
  await page.goto('/');
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Änderungen' })).toContainText('Alles gespeichert');

  await page.getByLabel('Moderation', { exact: true }).fill('Lou');
  await page.getByRole('combobox', { name: 'Stimme' }).first().selectOption('fr_marie_neutral');
  await page.getByRole('button', { name: 'Kultur' }).click();
  await page.getByPlaceholder('Eigenes Interesse, z. B. Geologie').fill('Vulkane');
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await page.getByRole('button', { name: 'Geologie entfernen' }).click();

  await page.getByLabel('Format der neuen Sendung').selectOption('theme_hour');
  await page.getByRole('button', { name: 'Sendung hinzufügen' }).click();
  const theme = page.getByRole('article', { name: 'Sendung Themen-Stunde' });
  await theme.getByLabel('Thema').fill('Der Mond');
  await expect(theme.getByText('Moderation vor jedem Song: 120 s')).toBeVisible();

  // Switching the artist hour to a genre hour swaps the subject field.
  const hour = page.getByRole('article', { name: 'Sendung Künstler-Stunde' });
  await expect(hour.getByLabel('Format')).toHaveCount(0);
  await hour.getByRole('button', { name: 'Künstler-Stunde bearbeiten' }).click();
  await hour.getByLabel('Format').selectOption('genre_hour');
  await hour.getByLabel('Genre oder Szene').fill('Krautrock');
  await hour.getByRole('checkbox').check();

  const slot = page.getByRole('group', { name: 'Wochentage' }).first();
  await slot.getByRole('button', { name: 'So' }).click();
  await page.getByLabel('Zeitfenster 1').getByRole('button', { name: 'Themen-Stunde' }).click();

  await expect(page.getByRole('region', { name: 'Änderungen' })).toContainText('Ungespeicherte Änderungen');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByText(/^Gespeichert\./)).toBeVisible();
  const saved = worker.saved.at(-1);
  expect(saved.host).toMatchObject({ name: 'Lou', voiceId: 'fr_marie_neutral' });
  expect(saved.profile.topics).toEqual(['Wissenschaft', 'Kultur']);
  expect(saved.profile.interests).toEqual(['Vulkane']);
  expect(saved.shows.find((show: any) => show.format === 'theme_hour')).toMatchObject({ id: 'themen-stunde', theme: 'Der Mond', tracks: 8, talkSeconds: 120, enabled: true });
  expect(saved.shows.find((show: any) => show.id === 'kuenstler')).toMatchObject({ format: 'genre_hour', genre: 'Krautrock', enabled: true });
  expect(saved.shows.find((show: any) => show.id === 'kuenstler').artist).toBeUndefined();
  expect(saved.schedule[0]).toMatchObject({ days: [1, 2, 3, 4, 5, 6], showIds: ['entdecken', 'themen-stunde'] });

  // Invalid input is explained before anything is sent.
  await page.getByLabel('Zeitfenster 1').getByLabel('Von').fill('25:00');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Änderungen' })).toContainText('Bitte korrigieren – schedule[0].from');
  expect(worker.saved).toHaveLength(1);
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(page.getByLabel('Zeitfenster 1').getByLabel('Von')).toHaveValue('00:00');
});

test('YAML view saves valid documents and explains broken ones', async ({ page }) => {
  const worker = await fakeWorker(page, station());
  await page.goto('/');
  await page.getByRole('button', { name: 'YAML', exact: true }).click();
  const editor = page.getByLabel('Konfiguration als YAML');
  await expect(editor).toHaveValue(/# host: Moderations-Persona/);
  await expect(editor).toHaveValue(/\nhost:\n  name: Mira\n/);
  await editor.fill('shows: [unclosed');
  await page.getByRole('button', { name: 'YAML speichern' }).click();
  await expect(page.getByRole('alert')).toContainText('Kein gültiges YAML');
  await page.getByRole('button', { name: 'Programm', exact: true }).click();
  await page.getByRole('button', { name: 'YAML', exact: true }).click();
  await expect(editor).toHaveValue(/\nhost:\n  name: Mira\n/);
  await editor.fill((await editor.inputValue()).replace('  name: Mira\n', '  name: Lou\n'));
  await page.getByRole('button', { name: 'YAML speichern' }).click();
  await expect(page.getByText(/^Gespeichert\./)).toBeVisible();
  expect(worker.stored.host.name).toBe('Lou');
});

test('inside the Android app the page is the cockpit without its own player', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 15) PersonalRadioAndroid/1', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await fakeWorker(page, station());
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Programmablauf' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Audioplayer' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Sendungen' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

test('without the private Worker the page says so instead of failing', async ({ page }) => {
  // Access answers with its login page instead of JSON.
  await page.route('**/api/**', route => route.fulfill({ contentType: 'text/html', body: '<html>Login</html>' }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Nicht verbunden' })).toBeVisible();
});
