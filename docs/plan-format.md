# Replay plan format

Stand-in writes a JSON plan in the `demos` folder for each video in `recordings`. Edit it to change a
later **browser replay**; it does not modify the original video. A generated plan looks like:

```json
{
  "url": "https://example.com/",
  "viewport": {"width": 1440, "height": 810},
  "fps": 60,
  "profileDir": "../.sessions/stand-in",
  "steps": [
    {"action": "click", "target": {"role": "link", "name": "Products"}},
    {"action": "caption", "text": "Explore products"},
    {"action": "highlight", "target": {"text": "Featured"}, "ms": 1500},
    {"action": "caption", "text": null}
  ]
}
```

`url` is the actual page at the start of capture. `profileDir` is relative to the plan and contains
the browser session; do not share it. A replay using a session asks for approval. `audio` enables tab
audio for replay. `--output` chooses a new replay video path.

## Settings

All are optional, and go at the top of the plan beside `url`.

| Setting | What it changes | Default |
| --- | --- | --- |
| `leadInMs` | How long the first page shows before the first step, in ms | `3000` |
| `tailMs` | How long the video runs on after the last step, in ms | `1500` |
| `pauseAfter` | Pause after every step, in ms; a step's own `pauseAfter` wins | about 500, by kind of step |
| `pace` | Speed of the whole replay, cursor and pauses included: `relaxed`, `normal` or `brisk` | `normal` |
| `captionSize` | Caption text size in pixels at 1080p | `34` |
| `cursor` | Show the cursor; `false` also hides click effects | `true` |
| `cursorColor` | Cursor fill color, as CSS | `#ffffff` |
| `cursorSize` | Cursor size in pixels | `28` |
| `accent` | Color of the click ring and highlights, as CSS | `#f5b400` |
| `clickEffect` | Show a ring where the replay clicks | `true` |
| `viewport` | Video size, `{"width": …, "height": …}` | 1920×1080 |
| `zoom` | Enlarge the page, such as `1.25`, so small text is readable | `1` |
| `fps` | Frames per second | `60` |
| `timeout` | How long each step waits for its target, in ms | `10000` |

## Targets

Targets can be CSS strings or objects such as `{"role":"button","name":"Save"}`,
`{"label":"Search"}`, `{"placeholder":"Search"}`, `{"text":"Products"}`,
`{"testId":"save"}`, or `{"css":"#save"}`. Use `frame` for an iframe selector (an array for nested
iframes), `within` for a containing target, and `nth` for a zero-based match.

A `name` matches part of the element's name, ignoring case, and an exact match wins when there are
several. Numbers in a name match any number, so `"English 7,261,000+ articles"` still works when the
count changes. With `nth`, the whole name must match. CSS and role targets also find elements inside
web components (open shadow DOM).

Recording picks the most readable target it can: a label, placeholder or role and name, then a unique
test id, then a form `name`, then CSS. When several elements share a role and name (such as "Read
more" on every card), it adds `nth`. A long name, such as a headline, is shortened to its first few
words. A link also gets `href`, where it goes as written in the page: on replay, when several links share
a name, the one with the same `href` is used, and when no link has the name any more, the link with the
same `href` is. Ids that a site generates afresh on each visit (such as React's `_R_5l7d_`) are never
used.

Replay waits for any visible match, so a hidden copy of an element (in a mobile menu, say) doesn't hold
it up. A link or button in a menu that's on screen but marked hidden from screen readers (`aria-hidden`)
is still found.

## Actions

| Action | Fields |
| --- | --- |
| `click` | `target`, optional `double`, `button`, `at` |
| `type` | `target`, `text`, optional `clear`, `submit`, `delay` |
| `press` | `key`, e.g. `Enter` |
| `scroll` | `by`, `pages`, `to`, or `target`; optional `duration` |
| `drag` | `target`, `to`, optional `duration` |
| `select` | `target`, `label` and/or `value` (tries `label`, then `value`) |
| `check`, `uncheck`, `hover` | `target`; `hover` also accepts `ms` |
| `move` | `x`, `y`, optional `duration` |
| `wait` | `ms` |
| `waitFor` | `target`, `url`, or load `state` |
| `waitForStable` | `target` or `around`, optional `quietMs`, `maxMs`, `minMs`, `changeMs` |
| `caption` | `text`; use `null` to hide |
| `highlight` | `target`, optional `ms` |
| `goto` | `url` |
| `evaluate` | `js` (runs JavaScript on the site; review carefully) |

Any step can specify `pauseAfter`, `timeout`, or `optional: true`. Optional steps that can't be done are
skipped with a note in the terminal. Recording marks clicks that close a pop-up, cookie notice or banner
as `"optional": true, "timeout": 3000`, since sites often don't show them again. When you click a link in a
menu that opened because you pointed at a nav item, recording adds an optional `hover` step for that nav
item first. Resting the pointer on something that opens a menu or shows a tip, without clicking, becomes a
`hover` step with `"ms": 1000`, so the replay holds it there for a second.
On replay, if a step's target is hidden in a closed menu, Stand-in points at (or clicks) the item that
opens it, so older plans without the `hover` step still work. Password input is not captured;
replace `SET-ME` placeholders only after reviewing the plan and the sensitivity of the value. Captured
actions are approximate: review selectors, waits, navigation and session state before replay. The
[JSON schema](../tools/recorder/plan.schema.json) provides editor completion.

### Waiting for chat answers

When you submit a question in a text field (press Enter, or click a button such as Send right after
typing) and then wait for the answer, the captured plan gets a `waitForStable` step whose `around` is the
question box, so replay waits for the answer however long it takes. If the page went to a new address
after you submitted, as with a search, the pause stays a fixed `wait`. Other pauses of more than a
couple of seconds become one-second `wait` steps, so the replay moves briskly; their `note` says how
long you actually paused, and you can raise `ms` to keep more. In a hand-written plan, the step looks like this:

```json
{"action": "type", "target": {"placeholder": "Ask a question"}, "text": "How do I open an account?", "submit": true},
{"action": "waitForStable", "around": {"placeholder": "Ask a question"}, "pauseAfter": 3000}
```

It waits for the answer near the box to start appearing (up to `changeMs`, default 20000), then until it
has stopped changing for `quietMs` (default 2000) with no visible loading or typing indicator. `minMs`
sets a minimum wait for assistants that pause before answering; captured plans set it to about half the
time you waited. `pauseAfter` gives viewers time to read.
If no answer starts, or it never settles within `maxMs` (default 90000), the replay stops with an error
rather than recording an incomplete answer.
