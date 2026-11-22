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
6. Confirm the command succeeded and the reported video exists and is nonempty. Review the video or
   resulting page when a suitable tool is available. A successful command alone proves the steps ran, not
   that the desired content appeared. Report what was verified, any limitations, and the video and plan
   paths. The plan can be edited and replayed later.

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
