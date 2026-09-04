const { test, expect } = require('../kryptheon-fixture');

test('Demo form', async ({ page }) => {
  // Intercept the demo-request submission so the test never hits the real
  // endpoint (it sends a live email on every run). Fulfilled with a fake 200.
  await page.route('**/api/demo-requests', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, success: true }),
    });
  });

  await page.goto('https://www.catchai.live/');

  await expect(page).toHaveTitle(/.+/);
  await expect(page.getByText('Schedule a Demo Demo')).toBeVisible();

  await page.getByText('Schedule a Demo Demo').click();
  await page.getByRole('textbox', { name: 'Full name' }).click();
  await page.getByRole('textbox', { name: 'Full name' }).fill('Test User');
  await page.getByRole('textbox', { name: 'Clinic name' }).click();
  await page.getByRole('textbox', { name: 'Clinic name' }).fill('Test Clinic');
  await page.getByRole('textbox', { name: 'Work email' }).click();
  await page.getByRole('textbox', { name: 'Work email' }).fill('test@example.com');
  await page.getByRole('button', { name: 'Request my demo' }).click();

  await expect(page.getByText('Thanks for submitting.')).toBeVisible();
});
