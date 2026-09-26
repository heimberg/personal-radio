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
  await expect(page.getByText('ASK · Mistral · Quelle user-source-1')).toBeVisible();
  expect(submitted.profile.topics).toContain('Kultur');
  expect(submitted.sources[0]).toMatchObject({ title: 'Aktuelle Meldung', url: 'https://news.example.test/article', excerpt: 'Ein überprüfbarer Auszug der Nachricht.' });
});
