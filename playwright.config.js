// @ts-check
const path = require('path');
const { defineConfig } = require('@playwright/test');

// Tool files come from the installed package; anything belonging to the person
// running the command comes from the folder they ran it in.
const PACKAGE_DIR = __dirname;
const USER_DIR = process.cwd();

// Node's built-in .env loader (no dependency). This file is re-evaluated in
// each worker process, so the values reach the tests themselves. A missing
// .env is not fatal: CI can supply the same variables as real env vars.
// loadEnvFile only exists from Node 20.12, and the package supports 20.6, so
// fall back to a small parser rather than silently skipping the file.
function loadEnv(file) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file);
      return;
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      return;
    }
  }
  let raw;
  try {
    raw = require('fs').readFileSync(file, 'utf8');
  } catch (err) {
    return; // no .env is fine
  }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadEnv(path.join(USER_DIR, '.env'));

module.exports = defineConfig({
  // The tests belong to the user, so they are found in their folder.
  testDir: path.join(USER_DIR, 'tests'),
  // Screenshots and other artefacts default to sitting next to the config,
  // which once installed means inside node_modules. Keep them with the user.
  outputDir: path.join(USER_DIR, 'test-results'),
  // These tests all run against one live site, so in parallel they interfere
  // with each other - a shared logged-in session, and rate limiting on the
  // real endpoints. Serial is the safe default here.
  fullyParallel: false,
  workers: 1,
  // Only the plain-language reporter: Playwright's 'list' reporter prints its
  // own stack-trace block on failure, which is what we are hiding here.
  // Resolved from the package so it is found wherever the command is run.
  reporter: [[path.join(PACKAGE_DIR, 'kryptheon-reporter.js')]],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
  },
});
