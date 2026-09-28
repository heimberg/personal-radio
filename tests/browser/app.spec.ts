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
      title: 'Portishead', focus: 'artist', subject: 'Portishead', team: { songs: 10, specialists: 1, corrections: 2 }, parts: [{ kind: 'speech', audioUrl: 'api/timeline/h1/audio?part=0' },
        { kind: 'track', spotifyUri: 'spotify:track:1', title: 'Glory Box', artist: 'Portishead', durationMs: 1 }] },
  ] : [], failures: state.stored ? { count: 1, latestError: 'NO_SOURCES', latestAt: '2026-09-27T13:31:00.000Z' } : { count: 0 } }) }));
  await page.route('**/api/places?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ places: [{ name: 'Bern', region: 'Bern', country: 'Schweiz', latitude: 46.94809, longitude: 7.44744 }] }) }));
  await page.route('**/api/spotify/profile', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ connected: true, artists: ['Nine Inch Nails', 'Protomartyr'] }) }));
  await page.route('**/api/timeline/arrange', route => { state.calls.push(`arrange ${JSON.parse(route.request().postData() ?? '{}').order.join(',')}`); return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
  await page.route('**/api/timeline/shuffle', route => { state.calls.push('shuffle'); return route.fulfill({ contentType: 'application/json', body: '{"added":1}' }); });
  await page.route('**/api/timeline/*/remove', route => { state.calls.push(`remove ${new URL(route.request().url()).pathname.split('/')[3]}`); return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
  for (const action of ['plan', 'retry', 'cleanup']) {
    await page.route(`**/api/timeline/${action}`, route => { state.calls.push(action); return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(action === 'plan' ? { planned: 2, queued: 2 } : action === 'retry' ? { retired: 1, restarted: 0, planned: 1, queued: 1 } : { removed: 1 }) }); });
  }
  await page.route('**/api/blocks', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ blocks: [
    { id: 'wetter', name: 'Wetter', description: 'Das Wetter für heute und morgen', minutes: 1, music: false, own: false },
    { id: 'kuenstler', name: 'Künstler-Stunde', description: 'Eine Stunde mit einer Band', minutes: 60, music: true, own: false, input: { kind: 'artist', label: 'Künstler oder Band', example: 'z. B. Portishead' } },
  ] }) }));
  await page.route('**/api/blocks/*/add', route => {
    state.calls.push(`add ${new URL(route.request().url()).pathname.split('/')[3]} ${route.request().postData()}`);
    return route.fulfill({ contentType: 'application/json', body: '{"itemId":"x"}' });
  });
  await page.route('**/api/shows/*/produce', route => { state.calls.push(new URL(route.request().url()).pathname); return route.fulfill({ contentType: 'application/json', body: '{"itemId":"x"}' }); });
  await page.route('**/api/timeline/t1/audio', route => route.fulfill({ contentType: 'audio/wav', body: silentWav(2) }));
  await page.route('**/api/timeline/t1/feedback', async route => { state.feedback.push(JSON.parse(route.request().postData() ?? '{}')); await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
  return state;
}

/** Settings open as an overview; each area opens on its own. */
async function openArea(page: Page, title: string) {
  if (await page.getByRole('button', { name: '← Alle Einstellungen' }).count()) await page.getByRole('button', { name: '← Alle Einstellungen' }).click();
  await page.getByRole('button', { name: new RegExp(`^${title}: `) }).click();
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
  await expect(timeline.getByText('Redaktionsteam: 10 Songs einzeln recherchiert · 1 Fachrecherchen · 2 Korrekturen im Faktencheck')).toBeVisible();
  await expect(timeline.getByRole('link', { name: 'Raumfahrt heute' })).toHaveAttribute('href', 'https://news.example.test/a');
  await expect(timeline.getByRole('link', { name: 'sonde landung' })).toHaveAttribute('href', 'https://www.google.com/search?q=sonde%20landung');
  await expect(page.getByText(/⚠ 1 fehlgeschlagen · zuletzt \d\d:\d\d: Keine neuen Quellen/)).toBeVisible();

  // Building blocks: one tap, or one word first.
  const blocks = page.getByRole('group', { name: 'Bausteine' });
  await blocks.getByRole('button', { name: /^Wetter/ }).click();
  await expect(page.getByText('«Wetter» kommt als Nächstes und wird produziert.')).toBeVisible();
  await blocks.getByRole('button', { name: /^Künstler-Stunde/ }).click();
  await blocks.getByLabel('Künstler oder Band').fill('Portishead');
  await blocks.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(page.getByText('«Künstler-Stunde» über «Portishead» kommt als Nächstes und wird produziert.')).toBeVisible();
  await page.getByRole('button', { name: 'Aufräumen' }).click();
  await expect(page.getByText('1 Einträge entfernt.')).toBeVisible();
  await page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(page.getByText('1 Fehlschläge abgeräumt, 0 wartende Beiträge neu gestartet, 1 neu geplant, 1 in Produktion.')).toBeVisible();
  expect(worker.calls).toEqual(['add wetter {}', 'add kuenstler {"subject":"Portishead"}', 'cleanup', 'retry']);

  // Arranging the program: move, remove, shuffle, add a song.
  await page.getByRole('group', { name: 'Sonde gelandet verschieben' }).getByRole('button', { name: 'Nach unten' }).click();
  await expect(page.getByText('Reihenfolge gespeichert.', { exact: false })).toBeVisible();
  await page.getByRole('group', { name: 'Portishead verschieben' }).getByRole('button', { name: 'Entfernen' }).click();
  await expect(page.getByText('«Portishead» entfernt.')).toBeVisible();
  await page.getByRole('button', { name: '🔀 Mischen' }).click();
  await expect(page.getByText('Programm gemischt, 1 Songs ergänzt.')).toBeVisible();
  await page.getByRole('button', { name: '+ Song' }).click();
  await expect(page.getByText('Ein Song wird ausgewählt und hinten angehängt.')).toBeVisible();
  expect(worker.calls.slice(4)).toEqual(['arrange h1,t1', 'remove h1', 'shuffle', '/api/shows/_musik/produce']);

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
  // The overview says what is set in each area.
  await expect(page.getByRole('button', { name: /^Sendungen: \d+ aktiv von \d+$/ })).toBeVisible();

  await openArea(page, 'Sender und Moderation');
  await page.getByLabel('Moderation', { exact: true }).fill('Lou');
  await page.getByRole('combobox', { name: 'Stimme' }).first().selectOption('fr_marie_neutral');
  // The place for {ort} and {wetter} is found by name.
  await page.getByLabel('Ort suchen').fill('Bern');
  await page.getByRole('button', { name: 'Suchen' }).click();
  await page.getByRole('button', { name: 'Bern, Bern, Schweiz' }).click();
  await expect(page.getByText('Ort: Bern')).toBeVisible();

  await openArea(page, 'Interessen');
  await page.getByRole('button', { name: 'Kultur' }).click();
  await page.getByPlaceholder('Eigenes Interesse, z. B. Geologie').fill('Vulkane');
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await page.getByRole('button', { name: 'Geologie entfernen' }).click();

  await openArea(page, 'Sendungen');
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
  await hour.getByText('Weitere Optionen').click();
  await hour.getByLabel('Produktion').selectOption('agents');
  await hour.getByRole('checkbox').check();
  // Live information is switched on, not typed as placeholders.
  const discovery = page.getByRole('article', { name: 'Sendung Entdeckungen' });
  await discovery.getByRole('button', { name: 'Entdeckungen bearbeiten' }).click();
  await discovery.getByRole('group', { name: 'Aktuelles einbauen' }).getByRole('button', { name: 'Wetter' }).click();
  await expect(discovery.getByRole('button', { name: 'Wetter' })).toHaveAttribute('aria-pressed', 'true');

  await openArea(page, 'Sendeuhr');
  const slot = page.getByRole('group', { name: 'Wochentage' }).first();
  await slot.getByRole('button', { name: 'So' }).click();
  await page.getByLabel('Zeitfenster 1').getByRole('button', { name: 'Themen-Stunde' }).click();

  await openArea(page, 'Musik');
  const music = page.getByRole('region', { name: 'Musik' });
  await expect(music.getByRole('group', { name: 'Spotify-Hörprofil' })).toContainText('Nine Inch Nails, Protomartyr');
  await music.getByRole('slider').fill('2');
  await music.getByRole('textbox').fill('Industrial, Indie, Rock');

  await expect(page.getByRole('region', { name: 'Änderungen' })).toContainText('Ungespeicherte Änderungen');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByText(/^Gespeichert\./)).toBeVisible();
  const saved = worker.saved.at(-1);
  expect(saved.host).toMatchObject({ name: 'Lou', voiceId: 'fr_marie_neutral' });
  expect(saved.profile.topics).toEqual(['Wissenschaft', 'Kultur']);
  expect(saved.profile.interests).toEqual(['Vulkane']);
  expect(saved.shows.find((show: any) => show.format === 'theme_hour')).toMatchObject({ id: 'themen-stunde', theme: 'Der Mond', tracks: 8, talkSeconds: 120, enabled: true });
  expect(saved.shows.find((show: any) => show.id === 'kuenstler')).toMatchObject({ format: 'genre_hour', genre: 'Krautrock', enabled: true, production: 'agents' });
  expect(saved.shows.find((show: any) => show.id === 'kuenstler').artist).toBeUndefined();
  expect(saved.music).toEqual({ between: 2, announce: true, taste: 'Industrial, Indie, Rock' });
  expect(saved.shows.find((show: any) => show.id === 'entdecken').tools).toEqual(['weather']);
  expect(saved.location).toEqual({ name: 'Bern', latitude: 46.9481, longitude: 7.4474 });
  expect(saved.schedule[0]).toMatchObject({ days: [1, 2, 3, 4, 5, 6], showIds: ['entdecken', 'themen-stunde'] });

  // Invalid input is explained before anything is sent.
  await openArea(page, 'Sendeuhr');
  await page.getByLabel('Zeitfenster 1').getByLabel('Von').fill('25:00');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Änderungen' })).toContainText('Bitte korrigieren – schedule[0].from');
  expect(worker.saved).toHaveLength(1);
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(page.getByLabel('Zeitfenster 1').getByLabel('Von')).toHaveValue('00:00');
});

test('settings: a music block with a playlist group, an AI group, rotation and moderation triggers', async ({ page }) => {
  const worker = await fakeWorker(page, station());
  await page.goto('/');
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await openArea(page, 'Sendungen');
  await page.getByLabel('Format der neuen Sendung').selectOption('music_block');
  await page.getByRole('button', { name: 'Sendung hinzufügen' }).click();
  const block = page.getByRole('article', { name: 'Sendung Musikblock' });
  const first = block.getByLabel('Gruppe 1');
  await first.getByLabel('Name der Gruppe').fill('Kaffee');
  // Typing a second line keeps the blank line while typing; stored are the playlist IDs.
  const links = first.getByLabel('Spotify-Playlists');
  await links.fill('https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO?si=x\n');
  await links.press('End');
  await links.pressSequentially('spotify:playlist:0vvXsWCC9xrXsKd4FyS8kM');
  await expect(first.getByLabel('Geschmack dieser Gruppe')).toHaveCount(0);
  await block.getByRole('button', { name: 'Gruppe hinzufügen' }).click();
  await block.getByLabel('Gruppe 2').getByLabel('Geschmack dieser Gruppe').fill('Krautrock');
  await block.getByLabel('Gruppe wechseln nach: 3 Songs').fill('4');
  await block.getByRole('checkbox', { name: 'Am Ende, mit Überleitung zur nächsten Sendung' }).uncheck();
  await block.getByLabel('Zwischendurch: aus').fill('10');
  await expect(block.getByText('Zwischendurch: alle 10 Min.')).toBeVisible();
  await expect(block.getByLabel('Quellenprüfung')).toHaveCount(0);

  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByText(/^Gespeichert\./)).toBeVisible();
  expect(worker.saved.at(-1).shows.find((show: any) => show.format === 'music_block')).toMatchObject({
    id: 'musikblock', targetMinutes: 30, switchAfterTracks: 4, switchAfterMinutes: 0, talkSeconds: 20,
    groups: [{ name: 'Kaffee', playlists: ['37i9dQZF1DX4sWSpwq3LiO', '0vvXsWCC9xrXsKd4FyS8kM'], taste: '' }, { name: 'Gruppe 2', playlists: [], taste: 'Krautrock' }],
    triggers: { blockStart: true, blockEnd: false, beforeTrack: 1, afterTrack: 0, everyMinutes: 10, groupTransition: true },
  });
});

test('YAML view saves valid documents and explains broken ones', async ({ page }) => {
  const worker = await fakeWorker(page, station());
  await page.goto('/');
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByRole('button', { name: /Als Text \(YAML\) bearbeiten/ }).click();
  const editor = page.getByLabel('Konfiguration als YAML');
  await expect(editor).toHaveValue(/# host: Moderations-Persona/);
  await expect(editor).toHaveValue(/\nhost:\n  name: Mira\n/);
  await editor.fill('shows: [unclosed');
  await page.getByRole('button', { name: 'YAML speichern' }).click();
  await expect(page.getByRole('alert')).toContainText('Kein gültiges YAML');
  await page.getByRole('button', { name: 'Programm', exact: true }).click();
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByRole('button', { name: /Als Text \(YAML\) bearbeiten/ }).click();
  await expect(editor).toHaveValue(/\nhost:\n  name: Mira\n/);
  await editor.fill((await editor.inputValue()).replace('  name: Mira\n', '  name: Lou\n'));
  await page.getByRole('button', { name: 'YAML speichern' }).click();
  await expect(page.getByText(/^Gespeichert\./)).toBeVisible();
  expect(worker.stored.host.name).toBe('Lou');
});

test('inside the Android app the page is the settings, without tabs or its own player', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 15) PersonalRadioAndroid/1', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await fakeWorker(page, station());
  await page.goto('/');
  // Program and player are native in the app: the page opens on the settings, without tabs.
  await expect(page.getByRole('navigation', { name: 'Bereiche' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Audioplayer' })).toHaveCount(0);
  await openArea(page, 'Sendungen');
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
