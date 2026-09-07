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
// Deliberately not process.loadEnvFile, and this is the whole reason:
//
// On Windows, PowerShell's `Out-File -Encoding utf8` and Notepad's "Save as
// UTF-8" both write a byte order mark. loadEnvFile keeps it, so the first line
// of the file defines "﻿KRYPTHEON_PASSWORD" rather than
// "KRYPTHEON_PASSWORD" - measured, not assumed. The variable then reads as
// undefined, the recording signs in with an empty password, and the login
// fails for a reason nothing in the report mentions. The file is right there,
// so nothing warns either.
//
// One parser, shared with the CLI, is also what stops the command that decides
// whether a password is present from disagreeing with the test that uses it.
function loadEnv(file) {
  const secrets = require(path.join(PACKAGE_DIR, 'kryptheon-secrets.js'));
  const values = secrets.readEnvFile(file);
  for (const name of Object.keys(values)) {
    // A real environment variable wins over the file - but only a real one.
    // A variable that exists and is empty is how "unset" arrives from a shell
    // or a CI job, and letting that beat the file would leave the password
    // blank with the answer sitting right there on disk.
    if (!secrets.isSet(process.env[name])) process.env[name] = values[name];
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
