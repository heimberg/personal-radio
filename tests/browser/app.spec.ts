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
  await page.getByRole('button', { name: /Lokal Bern/ }).click();
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
