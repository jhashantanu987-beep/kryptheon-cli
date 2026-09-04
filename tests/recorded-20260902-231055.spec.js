import { test, expect } from '../kryptheon-fixture';

test('test', async ({ page }) => {
  await page.goto('https://www.catchai.live/');
  await page.getByRole('link', { name: 'Product' }).click();
  await page.locator('#main-nav').getByRole('link', { name: 'Features' }).click();
  await page.getByRole('link', { name: 'About Us' }).click();
});