import { test, expect } from '@playwright/test';

test('mobile playback, navigation and preferences work without provider requests', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const external: string[] = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173')) external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Platz für gute Gedanken.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '▶ Start', exact: true }).click();
  await expect(page.getByText('Wiedergabe läuft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nächster Titel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Testsequenz 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).click();
  await expect(page.getByText('Pausiert', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mein Programm', exact: true }).click();
  await page.getByRole('button', { name: 'Kultur', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kultur', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.getByRole('button', { name: 'Mein Programm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kultur', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Audiotest', exact: true }).click();
  await page.route('**/api/testing/reset-daily-limits', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reset: true, utcDay: '2026-09-27' }) }));
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Heutige Limits zurücksetzen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Tageslimits für heute (2026-09-27) zurückgesetzt.' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Testprotokoll herunterladen' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('radio-audiotest.json');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('ended event advances real audio and corrupt stored profile recovers', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('radio.profile.v1', '{broken');
    const OriginalAudio = window.Audio;
    window.Audio = class extends OriginalAudio {
      constructor(src?: string) { super(src); (window as unknown as { testAudio: HTMLAudioElement }).testAudio = this; }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '▶ Start', exact: true }).click();
  await expect(page.getByText('Wiedergabe läuft', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { testAudio: HTMLAudioElement }).testAudio.currentTime = 29.8; });
  await expect(page.getByRole('heading', { name: 'Testsequenz 2', exact: true })).toBeVisible();
  await expect(page.getByText('Wiedergabe läuft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Audiotest', exact: true }).click();
  await expect(page.locator('.stats strong').first()).toHaveText('1');
});

test('source form sends selected profile to private API and plays returned segment', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Mein Programm', exact: true }).click();
  await page.getByRole('button', { name: 'Kultur', exact: true }).click();
  let submitted: any;
  await page.route('**/api/segments', async route => {
    submitted = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'audio/mpeg',
      headers: { 'X-Script-Title': encodeURIComponent('Ein eingeordneter Beitrag'), 'X-Script-Source-Ids': 'user-source-1' }, body: Buffer.from('ID3') });
  });
  await page.getByRole('button', { name: 'Radio', exact: true }).click();
  await page.getByLabel('Titel', { exact: true }).fill('Aktuelle Meldung');
  await page.getByLabel('HTTPS-Link zur Quelle').fill('https://news.example.test/article');
  await page.getByLabel('Kurzer Textauszug').fill('Ein überprüfbarer Auszug der Nachricht.');
  await page.getByRole('button', { name: 'Beitrag erstellen und abspielen' }).click();
  await expect(page.getByRole('heading', { name: 'Ein eingeordneter Beitrag' })).toBeVisible();
  await expect(page.locator('.queue').getByText('ASK · Mistral · Quelle user-source-1')).toBeVisible();
  expect(submitted.profile.topics).toContain('Kultur');
  expect(submitted.sources[0]).toMatchObject({ title: 'Aktuelle Meldung', url: 'https://news.example.test/article', excerpt: 'Ein überprüfbarer Auszug der Nachricht.' });
});

test('podcast mode, explicit interests and thumbs feedback stay local and affect future profile payloads', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Mein Programm', exact: true }).click();
  await page.getByLabel('Eigene Interessen').fill('Geologie');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
  await page.reload();
  let submitted: any;
  await page.route('**/api/segments', async route => {
    submitted = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'audio/wav',
      headers: { 'X-Script-Title': 'Ortsgeschichte', 'X-Script-Source-Ids': 'user-source-1', 'X-Script-Interest-Tags': 'Geologie' }, body: Buffer.from('RIFF') });
  });
  await page.getByRole('button', { name: 'Radio', exact: true }).click();
  await page.getByLabel('Beitragsstil').selectOption('podcast');
  await page.getByLabel('Titel', { exact: true }).fill('Geologie am Ort');
  await page.getByLabel('HTTPS-Link zur Quelle').fill('https://news.example.test/geology');
  await page.getByLabel('Kurzer Textauszug').fill('Geologie erklärt Gestein und Landschaft.');
  await page.getByRole('button', { name: 'Beitrag erstellen und abspielen' }).click();
  await expect(page.locator('.queue').getByText(/Gemini · Zwei Hosts/)).toBeVisible();
  await page.getByRole('button', { name: 'Gefällt mir' }).click();
  await expect(page.getByText(/1 Lernsignale/)).toBeVisible();
  expect(submitted.mode).toBe('podcast');
  expect(submitted.profile.interests).toContain('Geologie');
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('radio.feedback.v1') ?? '[]'))[0].action).toBe('like');
});

test('feed URL can be saved locally, restored and used to fill the source form', async ({ page }) => {
  let feedRequest: any;
  await page.route('**/api/feed-items', async route => {
    feedRequest = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
      { id: 'feed-1', title: 'Bundesrat informiert', url: 'https://news.example.test/article/1', excerpt: 'Der ausgewählte Auszug.', publishedAt: '2026-09-25T12:00:00.000Z' },
    ] }) });
  });
  await page.goto('/');
  await page.getByLabel('RSS/Atom-Feed URL').fill('https://news.example.test/rss.xml');
  await page.getByLabel('Name des Feeds').fill('Lokal Bern');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Feed wurde auf diesem Gerät gespeichert.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Lokal Bern news.example.test' }).click();
  await page.getByRole('button', { name: 'Feed laden' }).click();
  await expect(page.getByRole('button', { name: /Bundesrat informiert/ })).toBeVisible();
  expect(feedRequest.url).toBe('https://news.example.test/rss.xml');
  await page.getByRole('button', { name: /Bundesrat informiert/ }).click();
  await expect(page.getByLabel('Titel', { exact: true })).toHaveValue('Bundesrat informiert');
  await expect(page.getByLabel('HTTPS-Link zur Quelle')).toHaveValue('https://news.example.test/article/1');
  await expect(page.getByLabel('Kurzer Textauszug')).toHaveValue('Der ausgewählte Auszug.');
});

test('saved feeds are searched together and the strongest initial interest match is preselected', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('radio.profile.v1', JSON.stringify({ topics: [], interests: ['Geologie'], interestWeights: {}, speechMinutes: 3, exploration: 0 })));
  await page.route('**/api/feed-items', async route => {
    const { url } = JSON.parse(route.request().postData() ?? '{}');
    const isGeo = String(url).includes('geo');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
      { id: isGeo ? 'geo-1' : 'tech-1', title: isGeo ? 'Geologie der Alpen' : 'Neue Smartphone-News', url: `https://news.example.test/${isGeo ? 'geology' : 'phone'}`, excerpt: isGeo ? 'Geologie und Gestein der Alpen.' : 'Ein Telefon erscheint.', publishedAt: '2026-09-25T12:00:00.000Z' },
    ] }) });
  });
  await page.goto('/');
  await page.getByLabel('RSS/Atom-Feed URL').fill('https://news.example.test/tech.xml');
  await page.getByLabel('Name des Feeds').fill('Technik'); await page.getByRole('button', { name: 'Speichern' }).click();
  await page.getByLabel('RSS/Atom-Feed URL').fill('https://news.example.test/geo.xml');
  await page.getByLabel('Name des Feeds').fill('Geologie'); await page.getByRole('button', { name: 'Speichern' }).click();
  await page.getByRole('button', { name: 'Passenden Beitrag in allen Feeds finden' }).click();
  await expect(page.getByLabel('Titel', { exact: true })).toHaveValue('Geologie der Alpen');
});

function silentWav(seconds: number) {
  const rate = 8000, samples = rate * seconds, buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

test('server program: import device settings, show timeline, play ready segments and report completion', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('radio.feeds.v1', JSON.stringify([{ id: 'x', name: 'Wissen', url: 'https://feeds.example.test/wissen.xml' }]));
    const OriginalAudio = window.Audio;
    window.Audio = class extends OriginalAudio {
      constructor(src?: string) { super(src); (window as unknown as { testAudio: HTMLAudioElement }).testAudio = this; }
    };
  });
  let stored: any = null;
  const feedback: any[] = [];
  await page.route('**/api/station', async route => {
    if (route.request().method() === 'PUT') stored = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ config: stored }) });
  });
  await page.route('**/api/timeline', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: stored ? [
    { id: 't1', seq: 1, showId: 'kurz', showName: 'Kurzbeitrag', plannedAt: '2026-09-27T08:00:00.000Z', state: 'ready', estimatedMinutes: 2,
      title: 'Sonde gelandet', verification: 'strict', interestTags: ['Raumfahrt'], audioUrl: 'api/timeline/t1/audio',
      sources: [{ title: 'Raumfahrt heute', url: 'https://news.example.test/a' }] },
    { id: 't2', seq: 2, showId: 'kurz', showName: 'Kurzbeitrag', plannedAt: '2026-09-27T08:02:00.000Z', state: 'failed', estimatedMinutes: 2, error: 'NO_SOURCES' },
  ] : [] }) }));
  let planned = 0;
  await page.route('**/api/timeline/plan', route => { planned++; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"planned":2,"queued":2,"expired":0}' }); });
  await page.route('**/api/timeline/t1/audio', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav(2) }));
  await page.route('**/api/timeline/t1/feedback', async route => {
    feedback.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Einstellungen dieses Geräts übernehmen' }).click();
  await expect(page.getByRole('button', { name: '▶ Programm hören' })).toBeVisible();
  await expect(page.getByText('2 neue Beiträge geplant, 2 in Produktion.')).toBeVisible();
  expect(planned).toBe(1);
  expect(stored.feeds).toEqual([{ id: 'feed-1', name: 'Wissen', url: 'https://feeds.example.test/wissen.xml' }]);
  expect(stored.shows[0]).toMatchObject({ id: 'kurz', feedIds: ['feed-1'], verification: 'strict' });
  const timeline = page.getByRole('list', { name: 'Programmablauf' });
  await expect(timeline.getByText('Keine neuen Artikel in den Feeds dieser Sendung.')).toBeVisible();
  await expect(timeline.getByRole('link', { name: 'Raumfahrt heute' })).toHaveAttribute('href', 'https://news.example.test/a');
  await page.getByRole('button', { name: '▶ Programm hören' }).click();
  await expect(page.getByRole('heading', { name: 'Sonde gelandet' })).toBeVisible();
  await expect(page.getByText('Wiedergabe läuft', { exact: true })).toBeVisible();
  await page.evaluate(() => { const audio = (window as unknown as { testAudio: HTMLAudioElement }).testAudio; audio.currentTime = audio.duration - 0.1; });
  await expect.poll(() => feedback).toEqual([{ action: 'complete', listenedRatio: 1 }]);
});
