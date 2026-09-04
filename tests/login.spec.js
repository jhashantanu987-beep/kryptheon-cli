const { test, expect } = require('../kryptheon-fixture');

// Credentials come from .env (loaded in playwright.config.js via Node's
// built-in process.loadEnvFile). Copy .env.example to .env and fill it in.
const EMAIL = process.env.CATCHAI_EMAIL;
const PASSWORD = process.env.CATCHAI_PASSWORD;

test('Login', async ({ page }) => {
  expect(EMAIL, 'CATCHAI_EMAIL is not set - copy .env.example to .env and fill it in').toBeTruthy();
  expect(PASSWORD, 'CATCHAI_PASSWORD is not set - copy .env.example to .env and fill it in').toBeTruthy();

  await page.goto('https://www.catchai.live/auth.html');

  // auth.html opens on the Create Account tab, with the sign-in fields hidden.
  // Without this switch the email and password would go into the sign-up form.
  await page.getByText('Sign in', { exact: true }).click();

  await page.getByRole('textbox', { name: 'Email Address' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In →' }).click();

  await expect(page).toHaveURL(/\/dashboard\.html/);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});
