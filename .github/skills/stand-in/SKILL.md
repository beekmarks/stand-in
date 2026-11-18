---
name: stand-in
description: Record polished 1080p60 demo videos of any website from a plain-English description, using this workspace's Stand-in recorder (Chrome 153+ native tab recording). Inspects the page, writes a step plan in demos/, rehearses it, fixes failures, records it to recordings/, and verifies the result, using exactly the same commands and files a person uses from the VS Code tasks. Handles signed-in sites via a one-time manual sign-in, chat assistants with streamed answers, iframes, pop-ups and redaction of sensitive data. Use whenever the user asks for a demo video, screen recording, walkthrough or screencast of a website flow, or to create, fix, re-record or batch-record demos in this workspace.
---

# Stand-in (agent instructions)

This workspace records demo videos of websites. A person normally drives it from VS Code tasks without any AI.
You can do that person's work on their behalf: turn their description into a plan, rehearse, record, verify.

**Work exactly as a person would, through the same interface.** Use only the commands below (they are what
the VS Code tasks run) and the documented file formats. Don't write your own Playwright/Puppeteer scripts,
don't edit anything in `tools/recorder/`, and don't put files outside the standard folders. Then everything
you produce can be re-run, edited or re-captured by a person, and your results match theirs. If something
can't be done with these commands, say so instead of working around it.

Run all commands from the workspace root:

| Command | What it does |
| --- | --- |
| `node tools/recorder/record.mjs init-site <name> <url> [--signed-in]` | Create `sites/<name>.json` (+ `<name>-signed-in.json`) |
| `node tools/recorder/record.mjs login --site <name>-signed-in` | **Human step**: opens a visible Chrome for the person to sign in |
| `node tools/recorder/record.mjs inspect --site <name> --out .runs/inspect` | Inventory of clickable elements (incl. iframes), page text, screenshots |
| `node tools/recorder/record.mjs demos/<dir>/<demo>.json --rehearse` | Run a plan without recording; per-step screenshot + text |
| `node tools/recorder/record.mjs demos/<dir>/<demo>.json` | Record it to `recordings/<dir>/<demo>.mp4` |
| `node tools/recorder/record.mjs all demos [--rehearse]` | Every plan, one at a time, with a pass/fail table |
| `node tools/recorder/record.mjs capture demos/<dir>/<demo>.json --site <name>` | **Human step**: the person performs the flow; steps are written to the plan |

Reference docs (read when needed): `docs/plan-format.md` (every action, target and option) and
`docs/recipes.md` (signed-in sites, redaction, pop-ups, chat assistants, failures). Plans are validated by
`tools/recorder/plan.schema.json`; keep them valid.

## Before you start

- **Dependencies:** if `tools/recorder/node_modules` is missing, run `npm ci --no-audit --no-fund` in
  `tools/recorder` (the "Install recorder" task).
- **Chrome 153+** is required. If the recorder says none was found, tell the person: install Chrome
  Beta/Canary/Dev or Chrome for Testing, or set `CHROME_PATH`. Don't try to download browsers yourself.
- **Network:** if a page fails to load with a network error, report the exact error and check the connection
  (VPN/proxy?). For an HTTPS error such as `ERR_HTTP2_PROTOCOL_ERROR`, inspect the same site once with
  `--headful`; if it works, set `"headful": true` in its profile and rehearse the full flow. Visible Chrome
  requires a desktop session and is not a guaranteed fix. See `docs/recipes.md` → "HTTPS connection
  troubleshooting". Don't try other URLs or bypass site protections.

## Workflow

### 1. Understand the request

You need: which site, what the viewer should see happen, and whether it's signed out or signed in. Look in
`sites/` for an existing profile (and read its `notes`, which record what was learned about the site before).
Ask only for what's essential and missing: a URL for a new site, or "signed in or signed out?" when it matters
and isn't clear. Defaults: 1920×1080, 60fps, pace `normal` ("slow / easy to follow" → `relaxed`, "quick" →
`brisk`), no captions unless asked for or the demo is clearly for an audience (then 3–7 words per beat).

If the description says to **type** something into a chat or search box, submit it and show the result,
unless it's explicitly only about typing (autocomplete, validation). Say in your summary that you did.

### 2. Site profile

New site: `init-site <name> <url>` (add `--signed-in` if needed), then fill in `SET-ME` values (ask the person
for URLs you don't know). For signed-in demos, the person must sign in once: run
`login --site <name>-signed-in` and tell them exactly what to do: "A Chrome window opened. Sign in with your
test account, complete any MFA, then close the window." Wait for the command to finish. You can't complete
sign-ins, MFA or CAPTCHAs yourself, and must not try to get around them.

### 3. Inspect

`inspect --site <name> --out .runs/inspect`, then read `.runs/inspect/elements.json` (role, accessible name,
placeholder, suggested CSS, `inViewport`; `frames[]` lists iframes with a ready-made `frameSelector` and their own
elements) and `.runs/inspect/page.txt`. Look at `page.png` too if you can view images. To inspect a state
deeper in the flow (e.g. a panel that opens on click), make a temporary JSON in `.runs/` that `extends` the site
profile and adds the opening click to `setup`, and inspect with `--plan <that file>`.

Write what you learned (element names, iframe selectors, pop-ups) into the site profile's `notes`, so the next
demo needn't rediscover it.

### 4. Write the plan

Create `demos/<site>/<demo-name>.json` with `"extends": "../../sites/<profile>.json"`, a `"description"` (the
person's request, verbatim), and `"steps"`. Give each step a `note` quoting the part of the request it does.

- **Targets: use what a user sees.** `{"role": "button", "name": "Add to cart"}`, `{"label": "Email"}`,
  `{"placeholder": "Search"}`, `{"text": "Pricing"}`, with names taken from `elements.json`. Fall back to
  `css` (ids, `data-testid`). Add `"frame": "<frameSelector>"` for elements inside an iframe; `within` scopes
  to a container.
- **One intention ≈ one step.** A search is one `type` with `submit: true`. Off-screen targets scroll into view
  automatically; add `scroll` only when scrolling is part of the story.
- **Let results land.** After anything the viewer should notice, `waitForStable` (streamed/async content) or
  `waitFor`, then `pauseAfter` of 1500–3000 ms. Cutting away before the payoff is the most common flaw.
- **Chat answers:** after a `type` with `submit: true` (or a Send click), use
  `{"action": "waitForStable", "around": <the same target as the type step>, "minMs": 3000}`. It finds the
  answer near the question box by itself, rides out "thinking" pauses and loading indicators, and works on
  pages full of other moving content. Raise `minMs` for slow assistants. Never wait on `{"css": "body"}` of a
  busy page, and never type the question twice.
- **Setup vs steps.** Pop-up dismissal and other prep belong in the site profile's `setup` (runs before
  recording, `optional: true` for things that may not appear). Never put credentials in `steps`.
- **Sensitive data:** for signed-in demos, make sure the profile's `redact` covers account numbers, balances,
  names and similar. Add selectors you find; ask if unsure.

### 5. Rehearse until it passes

`demos/…json --rehearse`. Exit code 0 means every step ran. Then **verify, don't assume**: read each
`.runs/<dir>/<demo>/steps/NN-<action>.txt` (the visible text of the page and iframes after that step; a
`waitForStable` with `around` puts the text it followed first, under WATCHED AREA, and any warning is in
`report.json` as `waited.warning`) and
check the flow does what was asked: the right item was opened, the answer appeared, and so on. Look at the
matching `.png` files if you can view images.

On failure: read `.runs/<dir>/<demo>/failure.txt` and `report.json` (`steps[].error`, and `pageAtFailure`,
which lists what *was* clickable, with names). Fix the plan and rehearse again. `docs/recipes.md` → "When a
step fails" lists typical causes. If you can't find a reliable target after a few attempts, suggest the person
capture that part by demonstration instead.

### 6. Record and verify

`demos/…json` (no flags). Then read `.runs/<dir>/<demo>/report.json`: `video.width/height/fps` (expect ~60fps;
50+ is fine on machines without a GPU) and each step's `.txt` snapshot. Dynamic content (search results, AI
answers) can differ from the rehearsal: check the recorded run's text snapshots say what they should (complete,
on-topic, no error message, nothing unredacted). If not, record again. If ffmpeg is installed, `contact-sheet.png`
shows one frame per step.

### 7. Report back

Give the person: the video path (`recordings/…mp4`), duration/resolution/fps from the report, one line per beat
of what the video shows, and anything you interpreted or worked around (e.g. "the question was submitted so the
answer shows", "dismissed a cookie banner in setup", "added `.balance` to redact"). Mention they can re-run it
any time with **Demo: Record current plan**, or tweak the plan by hand.

## Batches and maintenance

- Several demos: one plan each, rehearse each, then `all demos` to record them sequentially (never in parallel).
- "Re-record everything": `all demos --rehearse` first; fix failures; then `all demos`.
- Editing an existing demo: change its plan, rehearse, record. Keep `description` in sync with what it now does.
