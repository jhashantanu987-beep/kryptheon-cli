# kryptheon

Record a flow in your app once, replay it after every AI change, and get told in
plain English what broke.

Runs entirely on your machine. No account, no API key, nothing leaves your
computer. It is a wrapper around [Playwright](https://playwright.dev).

Made by a 17-year-old vibecoder who kept having AI break things in his own app.

## Install

```
npm i -D kryptheon
```

Install it into your project, not globally — every recording imports
`kryptheon/kryptheon-fixture`, and your tests can only find that if kryptheon is
in your project's `node_modules`.

## Record

```
npx kryptheon record https://your-app.example.com
```

A browser opens. Use your app the way a customer would. Close the browser when
you are done, and the recording is saved as a test.

## Check

```
npx kryptheon check
```

Runs everything you have recorded:

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

Every failure ends with a short summary you can paste straight into an AI coding
tool.

## Recording something that replays

A recording is only useful if it still works the second time. So:

- **Record one simple flow.** Sign in and look at a page. Open a thing and check
  it loaded. Short beats thorough.
- **Sign in with an account that already exists.** Do not sign up during a
  recording — the account exists next time, and the signup step fails.
- **Avoid steps that cannot repeat.** Adding data piles up a row on every run.
  Logging out at the end means the next run does not start where this one did.

Kryptheon warns you about these after a recording, and names the exact step.

## Automatic checks

The first time a test passes, kryptheon remembers where the browser ended up and
what the page was called. If either changes later, the test fails and says what
changed — so a recording catches regressions without you writing a single
assertion.

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

A `.env` in the same folder is loaded automatically, and anything you type into a
password box is replaced with an environment variable rather than written into
the test.

Worth adding to `.gitignore`: `.env`, `kryptheon-baselines.json`,
`kryptheon-history.jsonl`, `test-results/`.

## Requirements

Node 20.6 or later. Recording needs a real terminal window — it opens a browser,
so it cannot run inside an AI coding assistant. The first run downloads a browser
(about 200MB, once).

## Licence

MIT
