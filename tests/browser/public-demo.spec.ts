import { test, expect } from '@playwright/test';

test('public demo keeps AI routes hidden and locally learns to rank sample topics', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) apiRequests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByText('Öffentliche Demo')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Beitrag aus einer Quelle' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'So lernt dein Radio' })).toBeVisible();
  await page.getByRole('button', { name: 'Mein Programm', exact: true }).click();
  await page.getByLabel('Eigene Interessen').fill('Geologie');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
  await page.locator('#explore').focus();
  await page.locator('#explore').press('Home');
  await page.getByRole('button', { name: 'Radio', exact: true }).click();
  await expect(page.locator('.example-stories li').first()).toContainText('Wie die Alpen entstanden');
  await page.getByRole('button', { name: 'Mehr davon: Wie die Alpen entstanden' }).click();
  await expect(page.getByRole('button', { name: 'Mehr davon: Wie die Alpen entstanden' })).toHaveAttribute('aria-pressed', 'true');
  const events = await page.evaluate(() => JSON.parse(localStorage.getItem('radio.feedback.v1') ?? '[]'));
  expect(events[0]).toMatchObject({ itemId: 'alpine-geology', action: 'like', interests: ['Geologie', 'Wissenschaft'] });
  expect(apiRequests).toEqual([]);
});
