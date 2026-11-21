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
the browser session; do not share it. A replay using a session asks for approval. `viewport`, `fps`,
`pace` (`relaxed`, `normal`, or `brisk`), `cursor`, `accent`, `zoom`, `leadInMs`, `tailMs` and `timeout`
are optional settings. `audio` enables tab audio for replay. `--output` chooses a new replay video path.

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
more" on every card), it adds `nth`.

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
as `"optional": true, "timeout": 3000`, since sites often don't show them again. Password input is not captured;
replace `SET-ME` placeholders only after reviewing the plan and the sensitivity of the value. Captured
actions are approximate: review selectors, waits, navigation and session state before replay. The
[JSON schema](../tools/recorder/plan.schema.json) provides editor completion.

### Waiting for chat answers

When you submit a question in a text field (press Enter, or click a button such as Send right after
typing) and then wait for the answer, the captured plan gets a `waitForStable` step whose `around` is the
question box, so replay waits for the answer however long it takes. If the page went to a new address
after you submitted, as with a search, the pause stays a fixed `wait`. Other pauses are fixed `wait`
steps too. In a hand-written plan, the step looks like this:

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
