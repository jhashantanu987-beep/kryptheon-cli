# kryptheon

Record a flow in your app once, replay it after every AI change, and get told in
plain English what broke.

Runs entirely on your machine. No account, no API key, nothing leaves your
computer. It is a wrapper around [Playwright](https://playwright.dev).

## Only have a web address?

Built your app in Lovable, Bolt or v0, and there is no project folder on your
computer? Open a terminal and run:

```
npx kryptheon record https://your-app.lovable.app
```

Before it opens anything, it looks at the folder you are in. If that folder is
not set up for recordings it says so and asks first, then adds a `package.json`
and kryptheon itself (about 20MB) — nothing else. A new terminal opens in your
home folder, so from there it keeps your recordings in a `kryptheon-tests`
folder of their own and tells you where that is.

After every change to your app, from that same folder:

```
npx kryptheon check
```

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

On its own, a recording knows that every button and field is still there and
that the last page looks the same. To say what must be true — "Reservation
received" appears after booking — use the toolbar at the top of the page while
recording:

| Button | Click it, then click… | Kryptheon then checks |
| --- | --- | --- |
| Eye | any element | it is on the page |
| `ab` | some text | that text is there |
| Box | a filled-in field | the field still holds that value |
| `{ }` | a part of the page | that part is laid out the same |

The round red button pauses and resumes recording. The arrow only shows how an
element would be found; it adds nothing to the test. One check at the end of a
flow — on the success message — is usually all a recording needs.

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

## Make your AI assistant check its own work

An assistant will happily call a change done after only reading the code. This
writes a rule into the files assistants already read, so it has to run the check
first:

```
npx kryptheon setup-ai
```

It writes `CLAUDE.md`, `AGENTS.md` and `.cursorrules`. If a file already exists,
it adds a marked section at the end rather than overwriting anything, and
running it again replaces that section instead of adding a second copy.

The rule: after any change, run `npx kryptheon check`, show the output, and do
not report the work as done until it passes.

For an assistant running the check after every change, `--quiet` keeps the
conversation readable — one line when everything passes, the full explanation
only when something breaks:

```
npx kryptheon check --quiet
```

```
OK  3 recordings still working.
```

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

## Renamed buttons

A button that only changed its words has not broken anything. When a step
cannot find "Reserve a table" and the page shows exactly one new button in its
place — "Reserve here" — kryptheon clicks that one, carries on through the rest
of the flow, and says so:

```
OK  Reserve a table  (16.0s)
    Renamed: The button "Reserve a table" is now called "Reserve here" - I used "Reserve here" and carried on.
    Nothing is broken. To stop seeing this, record the flow again.
```

It only does this when the page proves it: one name gone, the one the step
wanted, and one new name of the same kind. A button that is gone with nothing
in its place, or a rename next to other new buttons, fails as it always did.
Checks you added with the toolbar are never redirected.

## What goes where

Only your recordings go in your project, in `tests/`. Everything Kryptheon
remembers about the project is kept outside it, so it can never end up in your
repo:

    ~/.kryptheon/projects/<folder-name>-<id>/
      baselines.json   the remembered result for each test
      history.jsonl    one line per run, used for "this was working on …"
      test-results/    the screenshot of the last failure

Set `KRYPTHEON_HOME` to keep them somewhere else. Each project folder gets its
own store, so two projects are never mixed. A project folder that is moved or
renamed starts a new store.

Older versions kept `kryptheon-baselines.json`, `kryptheon-history.jsonl` and
`test-results/` in the project. The first run of this version moves them out,
once, and says so.

A `.env` in the same folder is loaded automatically, and anything you type into a
password box is replaced with an environment variable rather than written into
the test. When there is a password, `.env` is added to an existing `.gitignore`.

## Requirements

Node 20.6 or later. The first run downloads a browser (about 200MB, once).

Recording opens a browser window, so it needs a machine with a screen. It will
always try — if no window appears within 30 seconds it stops and says so,
rather than refusing up front.

## Licence

MIT
