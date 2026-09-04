# kryptheon

Record what you do in your app, and get told in plain English when it breaks.

No test code to write, no config to edit.

## Use it

Install it into your project first:

```
npm i -D kryptheon
```

This step is not optional. Every recording kryptheon writes starts with
`import { test, expect } from 'kryptheon/kryptheon-fixture'`, and your tests can
only find that import if kryptheon lives in your project's `node_modules`.
Running `npx kryptheon` without installing will record fine but fail to check.

Then record:

```
npx kryptheon record https://your-app.example.com
```

A browser opens. Use your app the way a customer would — click, type, sign in.
Close the browser when you are done, and the recording is saved as a test.

```
npx kryptheon check
```

Runs everything you have recorded and reports what happened:

```
OK  Sign in  (4.1s)

X  Checkout
   Could not find the button "Place order" on the page.
   This was working on 12 Mar at 9:14 AM.
   What to check: your last change may have renamed, hidden, or removed it.
   Where to look:
     - Browser was on: https://your-app.example.com/cart
     - POST /api/orders returned 500
       the server crashed or is unavailable - the error is in backend code, not the page
```

Every failure also ends with a short summary you can paste straight into an AI
coding tool.

## Automatic checks

The first time a test passes, kryptheon remembers where the browser ended up
and what the page was called. If either changes later, the test fails and tells
you what changed — so a recording catches regressions without you writing a
single assertion.

When a change is intentional, accept it for that one test:

```
npx kryptheon accept "Checkout"
```

`npx kryptheon accept` on its own lists what has been saved.

## Files it creates in your folder

| File | What it is |
| --- | --- |
| `tests/` | your recordings |
| `kryptheon-baselines.json` | the remembered result for each test |
| `kryptheon-history.jsonl` | one line per run, used for "this was working on …" |

`.env` in the same folder is loaded automatically, so a recording can sign in
without the password living in the test file.

Worth adding to `.gitignore`: `.env`, `kryptheon-baselines.json`,
`kryptheon-history.jsonl`, `test-results/`.

## Requirements

Node 20.6 or later. The first run downloads a browser (about 200MB, once).

## Licence

MIT
