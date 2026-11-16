# Plan format

This is the advanced reference for editing plans and site profiles. To make a video without writing a
plan by hand, start with [Make your first video](../README.md#make-your-first-video).

Two kinds of JSON file use this format:

- **Site profiles** (`sites/<name>.json`): everything shared by the demos of one website: start `url`,
  `zoom`, pop-ups to `hide`, `setup` steps, and for signed-in variants (`sites/<name>-signed-in.json`) the
  `profileDir` session, `loginUrl` and `redact` list. Create them with `record.mjs init-site <name> <url> [--signed-in]`.
- **Demo plans** (`demos/<folder>/<demo>.json`): `"extends": "../../sites/<name>.json"` plus the `steps`
  of one demo. They record to `recordings/<folder>/<demo>.mp4`.

A `url` without a scheme (e.g. `../examples/sample-site/home.html`) is a local file relative to the JSON file.

A standalone plan (no `extends`) works too. Only `url` and `steps` are required.

```json
{
  "url": "https://app.example.com/login",
  "viewport": {"width": 1920, "height": 1080},
  "fps": 60,
  "pace": "normal",
  "setup": [
    {"action": "click", "target": {"role": "button", "name": "Accept all"}, "optional": true, "timeout": 3000},
    {"action": "type", "target": {"label": "Email"}, "text": "demo@example.com"},
    {"action": "type", "target": {"label": "Password"}, "text": "hunter2", "submit": true},
    {"action": "waitFor", "url": "**/dashboard"}
  ],
  "steps": [
    {"action": "caption", "text": "Create a new project"},
    {"action": "click", "target": {"role": "button", "name": "New project"}},
    {"action": "type", "target": {"placeholder": "Project name"}, "text": "Q3 launch"},
    {"action": "click", "target": {"role": "button", "name": "Create"}},
    {"action": "waitFor", "target": {"text": "Q3 launch"}},
    {"action": "caption", "text": null}
  ]
}
```

## Top-level options

| Key | Default | Notes |
| --- | --- | --- |
| `extends` | none | Path (relative to this plan) of a site profile to inherit from. `setup`, `redact` and `hide` are concatenated (profile first); other keys in this plan override the profile. |
| `url` | (required) | First page. Loaded and settled **before** recording starts. |
| `steps` | `[]` | The recorded actions. |
| `setup` | `[]` | Steps run after load but **before** recording (login, cookie banners, seeding state). Same actions as `steps`. |
| `viewport` | `{1920,1080}` | Output video size equals the viewport size (the recorder captures CSS pixels; deviceScaleFactor has no effect). |
| `zoom` | `1` | CSS zoom on `<html>`. `1.5` at 1920×1080 gives a 1280-wide layout rendered sharply at 1080p: use 1.25–1.5 whenever a small panel (chat/assistant widget, side drawer) is the subject. Clicks and the cursor are zoom-aware, iframes included. Media queries still see 1920px, so check the layout in the rehearsal. |
| `fps` | `60` | Up to 120 only on a 120Hz Mac with `headful` (set automatically on macOS when fps > 60). |
| `audio` | `false` | Records tab audio (48kHz Opus). |
| `constantFrameRate` | `true` | Keeps a steady 60fps even while the page is still (via an invisible 2px animation). Chrome otherwise emits frames only on repaint, giving a variable-frame-rate file that some editors handle badly. |
| `pace` | `"normal"` | `"relaxed"` (×1.35), `"normal"`, `"brisk"` (×0.7). Scales cursor glides, typing and pauses. |
| `cursor` | `true` | Synthetic cursor + click ripple. Headless Chrome draws no cursor, so leave this on unless asked. |
| `accent` | `"#f5b400"` | Colour of click ripples and highlight rings. |
| `colorScheme` | (site default) | `"light"` or `"dark"`. |
| `locale` | (system) | e.g. `"en-US"`. |
| `profileDir` | none | Signed-in browser session folder (e.g. `../.sessions/my-site`), created by `record.mjs login --site <name>-signed-in`. Holds the cookies of a real sign-in, SSO/MFA included. Relative to the JSON file. |
| `loginUrl` | `url` | Signed-in site profiles: the page `login` opens for the one-time manual sign-in. |
| `connect` | none | CDP endpoint of a Chrome the person already launched and signed into, e.g. `"http://127.0.0.1:9222"`. The runner opens one tab, records it, and closes only that tab. (Same as `--connect`.) |
| `storageState` | none | Path to a Playwright storage-state JSON (cookies/localStorage) for already-logged-in sessions. |
| `redact` | `[]` | CSS selectors to blur (in every frame, from the very first frame). Items may also be `{"selector", "style"}` for a custom CSS declaration. |
| `hide` | `[]` | CSS selectors to make invisible (survey intercepts, feedback tabs, beta banners) without changing layout. |
| `blurPx` | `10` | Blur radius for `redact`. |
| `leadInMs` / `tailMs` | `800` / `1500` | Still time at the start and end of the video. |
| `timeout` | `10000` | Default per-step wait for a target to appear. |
| `headful` | `false` | Launch visible Chrome instead of headless; requires a desktop session. Does not change the mode of an existing browser when using `connect`. On macOS, automatically enabled when fps > 60 unless explicitly set. See [HTTPS troubleshooting](recipes.md#https-connection-troubleshooting). |
| `chrome`, `chromeArgs`, `ignoreHTTPSErrors`, `output` | | Rarely needed. |

## Targets

Every action that touches an element takes a `target`. Prefer user-facing locators: they match how the
user describes things and survive markup changes.

| Form | Example | Matches |
| --- | --- | --- |
| role + name | `{"role": "button", "name": "Sign in"}` | Accessible role and name (substring, case-insensitive; add `"exact": true` for exact). |
| text | `{"text": "Pricing"}` | Visible text. |
| label | `{"label": "Email address"}` | Form control by its `<label>`. |
| placeholder | `{"placeholder": "Search…"}` | Input placeholder. |
| testId | `{"testId": "submit-btn"}` | `data-testid`. |
| css | `{"css": "#search"}` | CSS selector. |
| string | `"nav >> text=Docs"` | Any raw Playwright selector. |

Inside an iframe: add `"frame": "<css of the iframe element>"` to any target form, e.g.
`{"frame": "#assistant-frame", "placeholder": "Ask a question"}`. For nested iframes give an array, outermost
first. `inspect` lists visible iframes with a ready-made `frameSelector` and their own element inventories.
Open shadow DOM needs nothing special: CSS and role/text locators pierce it automatically.

Modifiers: `"nth": 2` picks the 3rd match; `"within": {…another target…}` scopes the search (e.g. a button
inside a specific card). With several matches, the first *visible* one is used. Targets off-screen are
smooth-scrolled into view first, so you rarely need an explicit scroll before a click.

Common roles: `button`, `link`, `textbox`, `searchbox`, `checkbox`, `radio`, `combobox`, `tab`, `menuitem`,
`option`, `switch`, `heading`, `img`, `row`, `cell`, `dialog`.

## Actions

| Action | Fields | What the viewer sees |
| --- | --- | --- |
| `click` | `target`, `double?`, `button?` (`"right"`), `at?` (`[fx, fy]` fraction inside the box) | Cursor glides over, click ripple. |
| `type` | `target?`, `text`, `clear?`, `submit?` (press Enter after), `delay?` (ms/char, default 65) | Clicks the field (if `target`), then types with human rhythm. Omit `target` to type into whatever has focus. |
| `press` | `key` | Key or chord: `"Enter"`, `"Escape"`, `"Tab"`, `"ArrowDown"`, `"ControlOrMeta+K"`. |
| `hover` | `target`, `ms?` (dwell, default 700) | Cursor moves and rests, for hover menus and tooltips. |
| `move` | `x`, `y`, `duration?` | Cursor to a viewport point (e.g. park it out of the way). |
| `scroll` | `by?` (px, negative = up) or `pages?` (default 1 = 80% of viewport) or `to?` (target), `target?` (a scroll container), `duration?` (ms, default 900) | Eased smooth scroll. |
| `drag` | `target`, `to` (target or `{"x","y"}`), `duration?` | Press, glide, release. Works for pointer/mouse-event drag; HTML5 `draggable` DnD may need `evaluate`. |
| `select` | `target` (a `<select>`), `value` or `label` | Cursor goes to the control and the value changes. The native dropdown popup never appears in recordings (it's an OS widget). |
| `check` / `uncheck` | `target` | Clicks only if the state needs to change. |
| `wait` | `ms` | Hold still (let an animation or result sink in). |
| `waitFor` | `target` + `state?` (`visible`/`hidden`/`attached`), or `url` (glob), or `state` (`load`/`networkidle`) | Waits without moving. Use after actions that trigger async loading. |
| `waitForStable` | `target?` (the container/message to watch; the **last** match is used), `quietMs?` (default 1500), `maxMs?` (default 90000), `minLength?` | Holds still until the target's content stops changing for `quietMs` (and nothing inside is `aria-busy`). Use after sending a chat/assistant message so the streamed answer finishes before the next step. |
| `caption` | `text` (`null` hides) | Lower-third caption bar; stays until changed or hidden. Keep captions to 3–7 words naming the feature or step. |
| `highlight` | `target`, `ms?` (default 1400) | Ring + dim around an element, to call attention to it. |
| `goto` | `url` (absolute or relative) | Navigate within the recording. |
| `evaluate` | `js` (string) | Escape hatch: run JS in the page. |

Fields every step accepts:

- `pauseAfter`: ms to hold after the step. Defaults are tuned per action (click 650, type 500, scroll 450…), so set this only to linger on a result (e.g. `2000` after a search returns).
- `optional: true`: if the target never appears, skip the step instead of failing. Good for cookie banners and "what's new" popups.
- `timeout`: override the per-step wait.
- `note`: free text that appears in logs and the report, useful for mapping steps back to the feature description.

## Behaviour worth knowing

- Recording continues across navigations and full page loads. Links that open a new tab are loaded into the recorded tab instead.
- `alert`/`confirm` dialogs are auto-accepted (they never render in the video).
- After every step the runner waits for any page load to finish and fonts to be ready, then re-shows the cursor.
- If `HTTPS_PROXY` is set, Chrome uses it.
