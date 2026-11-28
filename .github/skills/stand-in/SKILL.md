---
name: stand-in
description: Record website demos manually or from a plain-English description, and replay editable JSON plans.
---

# Stand-in

Use the same recorder and plan format as the person. The bundled
[recorder](../../../tools/recorder/record.mjs) and [plan reference](../../../docs/plan-format.md) are
relative to this skill file, not to the person's workspace. Resolve the recorder's absolute path and run
`node "<absolute recorder path>" ...` with the person's chosen output folder as the working directory.
The installed extension includes its dependencies; do not install packages into its directory. In a source
checkout, if dependencies are missing, run `npm ci` in `tools/recorder`. Node.js 22+ and Chrome 153+
are required. Do not write custom browser scripts or edit recorder internals when making a demo.

## Choose the workflow

- If the person describes what they want shown and asks you to do it, use **Assistant-directed recording**.
- If they want to operate the site themselves, use **Manual recording**.
- Ask for the URL or essential actions if missing. Do not ask them to choose a workflow if their request
  already makes it clear.
- Before making a demo of a site for the first time, suggest the person record a short one by hand
  first, unless they already have. Some sites show security checks to browsers controlled by a program,
  look different on a second visit, or need a sign-in, and a quick manual recording shows that before
  you plan steps around it. If they'd rather go ahead, do.

## Assistant-directed recording

1. Turn the requested actions into a standalone plan at a new, non-colliding path under `demos/`. Use
   `{"url": "<website URL>", "steps": [...]}`; see the plan reference and
   [schema](../../../tools/recorder/plan.schema.json). Do not require a site profile or a prior manual capture for a public
   site. Preserve existing plans and videos.
2. Use available read-only browser inspection to discover visible labels, roles, links and iframe
   selectors when needed. The inspection browser may not share the recorder's saved session. Do not submit
   forms or perform state-changing actions merely to inspect the site. If inspection is unavailable, use
   the person's supplied details, report uncertainty, and fix a failed target when evidence is available.
3. Use documented actions and user-facing targets such as `role`/`name`, `label` or `placeholder`.
   Include the requested input and submission, and waits for results the person wants shown. Use
   `waitForStable` when content streams or loads asynchronously; don't claim it proves the content is
   correct. For a chat answer, use `{"action": "waitForStable", "around": <the question box's target>}`
   after the submitting step: it finds and follows the answer near the box (see "Waiting for chat answers"
   in the plan reference). Add captions or highlights only if requested. Do not invent credentials or put them in a plan.
4. Record directly with `node "<absolute recorder path>" replay <plan.json>`. This runs the actions in
   Chrome and saves a new MP4; no manual capture or rehearsal is needed for a straightforward request.
   The command reports the output path. Use `--rehearse` only if requested or needed to resolve a failure;
   rehearsals perform the actions too. Do not repeat state-changing actions without approval.
5. For a signed-in site, reuse a saved Stand-in session only if appropriate: set `profileDir` relative to
   the plan (for example `../.sessions/stand-in` for a plan directly in `demos/`). If sign-in is needed,
   the person must complete it using the manual recording workflow; never sign in or solve MFA for them.
   A session may expire or not be accepted by the site. Before **each** signed-in replay or rehearsal,
   explain the actions, get explicit approval, and only then pass `--confirm-signed-in`.
6. Confirm the command succeeded and the reported video exists and is nonempty. The replay's output
   lists every step as it runs, so you can confirm each one ran; that proves the steps ran, not that the
   video looks the way the person wants. Don't claim to have reviewed the video. Report what you
   verified, give the full video and plan paths, and ask the person to watch the video and say what to
   change. The plan can be edited and replayed later.

## Manual recording

1. Use the **Stand-in: Record Website** command, or run `node "<absolute recorder path>" <url>` in the
   chosen output folder.
2. The person prepares the page and signs in if needed. Tell them to click the page and press
   **Shift twice**, quickly, to start, then Shift twice again to stop and save. If that
   does nothing, they can press Enter in the recorder's terminal instead, once to start and once to stop
   (only when the command runs in an interactive terminal they can type into). Wait for the
   command to finish; do not sign in, solve MFA, or bypass site protections for them.
3. Report the MP4 path from **Your video is ready** and the JSON path from **Replay plan**. The
   MP4 is converted to H.264 so it plays everywhere; if the terminal says it kept the AV1 video, pass that
   on. The video captures everything visible in the
   tab; plans and the saved browser session may also contain sensitive information. Advise review before
   sharing, and use of video editing software for cleanup.
4. If asked to replay, review the plan with the person first. Use
   `node "<absolute recorder path>" replay <plan.json>` to produce a new video; rehearse with
   `--rehearse` only if requested or needed. Before each replay or rehearsal using a saved session,
   get explicit approval and only then pass `--confirm-signed-in`. Plans may be edited with captions or
   highlights; see the linked plan reference. Replays revisit the site and may fail if its state has changed. A failed
   replay names the failing step and the reason; fix that step (target, `timeout`, or `"optional": true`)
   rather than retrying blindly. The partial video is saved with `-incomplete` in its name.

For either workflow, the video captures everything visible in the tab; plans and browser sessions may
also contain sensitive information. Advise review before sharing and use of video editing software for
cleanup. Report network, site and replay failures rather than bypassing protections or claiming success.

## Changing an existing plan

People most often ask to change five things: the start, the timing, captions, the cursor and clicks,
and the video's size. Do these by editing the plan in `demos/`, not by recording again. Read the whole
plan first. Keep its existing steps, targets, `url` and `profileDir`, and change only what was asked.
When the person names no plan, use the newest one in `demos/` and say which you chose. Replaying makes
a new video and keeps the old one.

**1. The start and the end.** Top-level `leadInMs` is how long the first page shows before the first
step (default 3000). `tailMs` is how long the video runs on after the last step (default 1500).
"Start more slowly" means a larger `leadInMs`; "it ends too abruptly" means a larger `tailMs`.

**2. Timing between actions.**
- Top-level `pauseAfter` (ms) sets the pause after every step, captions and highlights included. Without
  it, each kind of step has its own short pause (about half a second after a click). A step's own
  `pauseAfter` wins over the top-level one.
- `pace` (`relaxed`, `normal`, `brisk`) scales everything, cursor movement and all pauses included.
  Use it for "slower" or "faster" overall; use `pauseAfter` for "longer gaps between steps" when the
  movement itself is fine.
- To linger at one point, insert `{"action": "wait", "ms": 2000}` after that step. Recorded plans
  already have `wait` steps with a `note` where the person paused: change their `ms` to lengthen or
  shorten those pauses; don't delete them unless asked.

**3. Captions and highlights.**
- A caption is a step of its own: `{"action": "caption", "text": "Search for a fund"}`. It appears when
  the replay reaches it and stays on screen, across page changes, until the next caption step.
  `{"action": "caption", "text": null}` removes it, for example before the end.
- Put a caption just before the first step of the action it describes. If a `hover` step leads into a
  click (pointing at a menu, then clicking an item in it), put the caption before the `hover`. Don't
  caption `wait` or `scroll` steps, or optional clicks that close pop-ups; the caption before them stays
  up anyway. "A caption for each step" means one per meaningful action, not per line of JSON.
- Keep captions short, one line of a few words, in the person's language. Write the text from what the
  step does (its target's name), and ask if the purpose isn't clear.
- Top-level `captionSize` (default 34, at 1080p) makes all captions bigger or smaller.
- A highlight draws a box around something: `{"action": "highlight", "target": <target>, "ms": 1500}`
  (default 1400 ms). Use the same kind of target as the plan's other steps; copy one if it already
  targets the thing.

**4. The cursor and clicks.** Top-level `cursorColor` (fill, as CSS; default white with a dark outline),
`cursorSize` (pixels, default 28), `accent` (color of the click ring and highlights; default
`#f5b400`), `clickEffect: false` (no click ring) and `cursor: false` (no cursor or click ring at all).

**5. The size of the video.** Top-level `viewport` (`{"width": 1920, "height": 1080}` by default) sets
the video size, and `zoom` (such as `1.25`) enlarges the page so small text is readable. Both change the
page's layout. A narrower viewport or a larger zoom can turn a site's menu into a "hamburger" button
and hide what a step clicks, so rehearse with approval, or warn the person, after changing them.

Anything not covered here is in the plan reference. Before replaying, check that the plan still parses
as JSON (for example with `node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" <plan>`).
Tell the person what you changed, and where in the plan. Editing a plan that uses a saved session
doesn't change the rule above: explain the actions, get approval, and only then pass
`--confirm-signed-in`. After the replay, confirm from its output that every step ran, including each
caption and highlight. Then ask the person to watch the video and judge whether it looks right; don't
claim to have checked that yourself.

## When something doesn't work

Stand-in handles many site quirks, but a site it hasn't met can still do something it doesn't handle. When
a recording, a plan or a replay goes wrong, find out what happened before changing anything: read the
recorder's message (a failed replay names the step and the reason), the plan step, and the page or video
if you can see them. Then tell the person which of these it is:

- **The site.** It blocks automated browsers or shows a bot check; it changed since the recording (content
  that rotates, a page that looks different to a returning visitor, another language or region); or the
  network failed. Say so, and don't bypass protections.
- **The plan.** The site renamed a target, the target uses a name the site makes up on each visit (a `css`
  or `testId` with random letters and digits in it), a step needs a longer `timeout`, or a click that
  doesn't matter should be `"optional": true`. Fix the step using the plan reference, and rehearse only
  with approval.
- **Stand-in itself.** It recorded the wrong thing or missed a step (such as pointing at a menu that the
  plan leaves out), the shortcut didn't respond, it hung or crashed, it saved a broken video, or replay
  acted on the wrong element. Don't work around it with your own browser scripts or by editing the
  recorder.

For a problem with Stand-in itself, say plainly that it looks like a gap in Stand-in, and write a short
report the person can send to its maintainers as an issue at https://github.com/beekmarks/stand-in/issues:

- what they were doing: the site's address and the steps, in plain words;
- what they expected, and what happened instead;
- the recorder's message, word for word, and the plan steps involved;
- the Stand-in version (in the `package.json` next to the recorder), the operating system, and Chrome's
  version;
- whether it happens again on a second try, and with a fresh session (a new `profileDir`).

Leave out sign-in details, account numbers and other personal information, and ask before including the
video or the plan file. Then help the person carry on: an edited plan, an optional step, or recording that
part themselves.
