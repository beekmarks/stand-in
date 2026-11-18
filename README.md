# Stand-in

Record repeatable, polished demo videos of any website, **without writing code and without AI**.
Everything runs from menus in VS Code. You click through the flow once in Chrome; Stand-in saves it as an
editable **plan**, rehearses it, and records a 1920×1080 MP4 at a 60 fps target with a visible cursor,
human-paced typing, captions and highlights. It works on signed-in sites and waits for AI chat
assistants to finish streaming their answers.

If you'd rather describe a demo in plain words, Stand-in also ships an **optional AI agent skill** that
does the same work for you, using the same tasks and files.

![Stand-in recording the included sample site: asking an assistant about a 401(k), waiting for the streamed answer, following up with a chart, with captions and blurred balances](docs/demo.gif)

*Made with Stand-in from the included sample plan `demos/sample/401k-chart.json` (shown at 1.5× speed).*

> **Status: early prototype.** Built in November 2026 and tested mainly on the included sample site and
> one public website. Expect rough edges, and please report them.

## Two ways to use it

**No AI, no code (the main way).** Stand-in was built so that anyone who can open VS Code can make a demo
video. Every step is a VS Code task you pick from the Command Palette:

| You run | What happens |
| --- | --- |
| **Demo: Capture new demo (do it yourself)** | Chrome opens; you click through the flow and close it. |
| **Demo: Rehearse current plan** | The flow is replayed and checked, with a screenshot for every step. |
| **Demo: Record current plan** | The finished MP4 is saved in `recordings/`. |

No API keys, no AI subscription, no data sent to an AI service, and nothing to program. The only things
you edit by hand, if you want to, are small JSON settings such as a caption's text.

**With an AI agent (optional).** The included [agent skill](.github/skills/stand-in/SKILL.md) teaches an
AI coding agent to do the whole job from a description like *"show someone asking the assistant how to
open an account, then following the link in its answer."* The agent inspects the site, writes the plan,
rehearses it, fixes failing steps, records the video and checks the result.

The skill is restricted to the **same commands and files the VS Code tasks use**. It doesn't write its own
browser scripts. So anything an agent makes is an ordinary plan that a person can open, edit, rehearse
and re-record from the menus, with no AI involved. See [Let an AI agent do it](#optional-let-an-ai-agent-do-it).

## Is this the right tool?

**A good fit if you want to:**

- let people who don't write code, and don't use AI tools, produce demo videos from VS Code menus;
- re-record the same demo later (after a UI change, or for a new environment) without redoing it by hand;
- demo a website you don't control or can't run locally, behind a real sign-in and MFA;
- demo an AI assistant and wait for its streamed answer to *finish* before moving on;
- hand the whole job to an AI agent when you have one, and still get plans a person can maintain.

**Probably not the right tool if you:**

- need Firefox, Safari, or a browser older than Chrome 153;
- need videos that play everywhere with no conversion step (see [Limitations](#limitations));
- want automatic detection of personal data; redaction here is manual;
- want an interactive click-through demo rather than a video; tools such as Arcade or Supademo do that.

## How it works

| Stage | What you do | What you get |
| --- | --- | --- |
| **1. Capture** | Click through the flow yourself in Chrome. | A JSON plan in `demos/`, using readable targets such as "the button named *Submit*". |
| **2. Rehearse** | Run the plan without recording. | Per-step screenshots, text snapshots and a `report.json` in `.runs/`, plus `failure.png` if a step fails. |
| **3. Record** | Run the plan again. | An MP4 in `recordings/`, plus an optional contact sheet with one frame per step. |

Between stages you can edit the plan: add captions, highlights, pauses, or a wait for a streamed answer.
Settings shared by every demo of a site, such as zoom, sign-in, setup steps and redaction, live in a
**site profile** in `sites/`.

## What it builds on, and how it compares

None of the individual pieces are new, and several tools already combine a few of them. What
Stand-in adds is this particular combination, packaged for non-programmers recording demos of
signed-in sites and AI assistants.

- **Recording:** Chrome 153's native tab recorder (`Page.startScreenRecording`) via Paul Irish's
  [chrome-capture](https://github.com/paulirish/chrome-capture). Browser control: `playwright-core`.
- **Capture by demonstration** follows the same idea as
  [Chrome DevTools Recorder](https://developer.chrome.com/docs/devtools/recorder) and
  [@puppeteer/replay](https://github.com/puppeteer/replay), Playwright `codegen`, and
  [humanjs](https://github.com/totigm/humanjs). Those are strong options if you mainly need tests or a
  replayable flow.
- **Closest overall:** [RunThru](https://github.com/marktolson/runthru) also captures a flow as you
  click, keeps a browser profile so you sign in once, and waits for the page to settle (including
  `aria-busy` loading states) before each step. If you're choosing a tool, compare it with this one first.
- **Dry runs before recording:** [Retake](https://github.com/glebbogachev00/retake) validates every
  selector and wait without recording, much like Stand-in's rehearse stage.
- **Polished, scripted demo videos** are also offered by Playwright's own screencast API and by projects
  such as [webreel](https://webreel.dev/), [demowright](https://github.com/snomiao/demowright),
  [Demo-Forge](https://github.com/DixitRam/Demo-Forge) and [aidemo](https://github.com/tandryukha/aidemo).
  Commercial tools such as Guidde, Clueso and Supademo add automatic blurring and voice-over.

What Stand-in focuses on:

- **No code and no AI required:** the whole loop runs from VS Code tasks. Most tools above expect you
  to write scripts, or put an AI agent at the center;
- **an optional agent skill that stays inside that same interface**, so AI-made demos remain plain plans
  anyone can re-run;
- **`waitForStable`**, a declarative plan step for streamed chat answers: it waits until the newest
  answer stops changing, including inside an iframe, instead of using a fixed delay;
- **a separate rehearse stage** that writes reviewable artifacts for every step before any video is made;
- **one-time human sign-in**: you complete MFA yourself once, and the session is reused privately;
- **site profiles** that hold zoom, redaction, hidden pop-ups and setup steps for each site.

## Limitations

- **Chrome 153 or newer only.** The recording API is new and marked experimental in Chrome DevTools
  Protocol, and `chrome-capture` is a 0.x release.
- **Videos are AV1.** They play in Chrome, Edge and VLC. Playback in QuickTime, Safari, older Macs,
  PowerPoint and some Windows setups is unreliable. You can convert recordings to H.264 or other formats
  with free tools; see [Converting the video](docs/recipes.md#converting-the-video-to-h264-or-other-formats).
- **Redaction is manual and visual.** You list CSS selectors to blur. A wrong or outdated selector
  leaves data visible, so you must review every video.
- **Plans can break when a site changes.** Re-capture, or edit the target in the plan.
- **Use with care:** browser `alert`/`confirm` dialogs are accepted automatically, `evaluate` steps run
  JavaScript in the page, and `.sessions/` holds live sign-in cookies.

## Before you start

- Use a **test account** and test data. Don't type passwords while capturing; use the separate sign-in
  task below.
- Plans can contain what you typed. Screenshots, reports and videos can contain anything the site shows.
  Check the entire video before sharing it, and never share `.sessions/`.
- Follow the website's terms of use, and your organization's rules about recording and sharing its UI.
  Don't bypass CAPTCHAs or bot protection.

## One-time setup

1. Install [VS Code](https://code.visualstudio.com/), [Node.js](https://nodejs.org/) **24.11 or newer**,
   and [Chrome](https://www.google.com/chrome/) **153 or newer** (check under **About Google Chrome**).
   Chrome Beta, Dev, Canary or Chrome for Testing also work if they meet the version.
   *(The recorder supports Node 22.18+, but its `chrome-capture` dependency requires 24.11+.)*
2. In VS Code, choose **File → Open Folder** and open this folder.
3. Open the Command Palette (**Cmd+Shift+P** on Mac, **Ctrl+Shift+P** on Windows/Linux), choose
   **Tasks: Run Task**, then **Demo: Install recorder (one-time)**.

Every task below is run the same way: **Command Palette → Tasks: Run Task**. That's all you need; no AI
tools or programming are involved anywhere in the next sections.

## Make your first video (about 5 minutes)

This uses the included fictional *Harbor Financial* site. Nothing is sent to a real financial service.

**1. Capture.** Run **Demo: Capture new demo (do it yourself)**. Enter `sample/my-first-demo` as the
demo path and `sample` as the site. In the Chrome window that opens:

1. Click **Harbor Assistant** in the top navigation.
2. Type `How do I open an account?` and press **Enter**.
3. Wait for the full answer, pause a few seconds so viewers can read it, then close Chrome.

The plan is saved as `demos/sample/my-first-demo.json`. This is not the video yet.

**2. Rehearse.** Open that plan in VS Code and keep it as the active file (tasks named *current plan*
act on it). Run **Demo: Rehearse current plan** and wait for **Rehearsal passed**. Check the screenshots
in `.runs/sample/my-first-demo/steps/`.

**3. Record.** Run **Demo: Record current plan**. Watch `recordings/sample/my-first-demo.mp4` all the
way through.

To make the same video again later, open its plan and run **Record current plan**. Site content can
change between runs, so watch the new video each time.

### Optional: add a caption

A caption is a short lower-third text bar; it isn't narration or a subtitle file. Add this line directly
below `"steps": [` in the plan:

```json
{"action": "caption", "text": "Ask the assistant"},
```

It stays on screen until another caption replaces it, or until a `{"action": "caption", "text": null},`
step hides it. Keep the trailing commas. See the [sample 401(k) plan](demos/sample/401k-chart.json) and
the [plan format](docs/plan-format.md#actions) for more.

## Record your own website

1. **Add the site once:** run **Demo: New site profile**. Enter a short lowercase name (e.g. `my-site`),
   the start address, and whether sign-in is needed. Replace any `SET-ME` placeholders in the new file
   in `sites/`.
2. **Sign in, if needed:** run **Demo: Sign in to a site (one-time)** with a profile name such as
   `my-site-signed-in`. Sign in yourself, complete MFA, and close Chrome. Repeat when the session
   expires.
3. **Capture:** run **Demo: Capture new demo (do it yourself)** with a path like
   `my-site/my-first-demo` and your site name.
4. **Rehearse and record** as above. Videos are saved in `recordings/my-site/`.

To redo an existing demo, open its plan and run **Demo: Re-capture current plan**; the old plan is
kept as a backup.

## Demoing chat assistants

Streamed answers are the main use case Stand-in was built for. After sending a message, add a `waitForStable`
step that watches the answer:

```json
{"action": "waitForStable", "target": {"frame": "#assistant-frame", "css": ".answer"}, "pauseAfter": 3000}
```

It waits until the **newest** match stops changing (1.5 s of quiet by default, with a 90 s maximum) and
nothing inside it is marked `aria-busy`. `pauseAfter` then gives viewers time to read. Answers vary from
run to run, so check the text snapshot or the video every time. See
[Chat assistants](docs/recipes.md#chat-assistants-and-other-streamed-answers).

## Hide sensitive information

You must tell the recorder which page elements to blur. Nothing is detected automatically.

1. **Find each element.** In Chrome, right-click the item (a balance, an account number) → **Inspect**,
   then right-click the highlighted element → **Copy → Copy selector**.
2. **Add it to the site profile's `"redact"` list.** For example, from
   [`sites/sample-signed-in.json`](sites/sample-signed-in.json):

   ```json
   "redact": [".portfolio-total", ".acct-balance", ".acct-number"]
   ```

   Use only one `"redact"` list per file, and escape any double quotes in a selector as `\"`.
   To hide an element entirely instead (for example a survey pop-up), use `"hide"`.
3. **Rehearse and check every screenshot**, then **record and watch the whole video**. Look especially
   at later pages, pop-ups and assistant answers.

Blurring is visual masking only: it may not make text unreadable, and it does not remove data from
plans, URLs, terminal output or saved sessions. See
[Hiding sensitive data](docs/recipes.md#hiding-sensitive-data).

## Something went wrong?

| What you see | What to do |
| --- | --- |
| Chrome can't be found or is too old | Install Chrome 153+. With several Chromes installed, see the [plan format](docs/plan-format.md). |
| The site loads in your browser but not in the recorder | Check your connection and VPN. For an HTTPS error such as `ERR_HTTP2_PROTOCOL_ERROR`, try visible Chrome (below). |
| A rehearsal fails or goes to the wrong place | The terminal names the step. Check `failure.png` and `report.json` in `.runs/<site>/<demo>/`, then try **Re-capture current plan**. See [When a step fails](docs/recipes.md#when-a-step-fails). |
| An answer is cut off or differs between runs | Add or adjust a `waitForStable` step; see [Chat assistants](docs/recipes.md#chat-assistants-and-other-streamed-answers). |
| The MP4 won't play (QuickTime, PowerPoint, older Macs) | The video is AV1. Open it in Chrome, Edge or VLC, or convert it to H.264 with HandBrake or ffmpeg; see [Converting the video](docs/recipes.md#converting-the-video-to-h264-or-other-formats). |

**Visible Chrome:** in the site's file in `sites/`, add `"headful": true,` on a new line right after the
opening `{`, save, and rehearse again. It helps with some connection errors but isn't a guaranteed fix.
See [HTTPS troubleshooting](docs/recipes.md#https-connection-troubleshooting).

## Optional: let an AI agent do it

Everything above works without AI. If you use an AI coding agent, the included skill can save you the
clicking and the plan editing.

**What the skill does.** Given a plain-English description of the demo, the agent:

1. inspects the site to find the right buttons, fields and assistant panels (including iframes);
2. writes the plan in `demos/`, with captions, waits for streamed answers and redaction where needed;
3. rehearses it, reads the screenshots and fixes any failing step;
4. records the video and checks it against your description.

**What stays with you.** The agent can't sign in for you: when a site needs it, it asks you to run the
sign-in step and complete MFA yourself. It also hands capture-by-demonstration back to you when you'd
rather show the flow than describe it.

**Why the results stay maintainable.** The skill may only use the commands behind the VS Code tasks and
the documented plan format. It never writes custom Playwright or Puppeteer code or edits the recorder.
Every demo it produces is a normal plan you can open, tweak and re-record from the menus later, even on a
machine with no AI tools at all.

**How to use it.** The skill lives in [`.github/skills/stand-in/SKILL.md`](.github/skills/stand-in/SKILL.md),
where GitHub Copilot finds it: open Copilot Chat in **agent mode** and describe the demo you want. It's
written in the standard `SKILL.md` format, so other agents that support skills can use the same file
(for Claude Code, copy the folder to `.claude/skills/stand-in/`).

## Reference

- [Plan format](docs/plan-format.md): targets, actions and advanced options.
- [Recipes](docs/recipes.md): HTTPS, sign-in, redaction, pop-ups, chat assistants, converting videos,
  troubleshooting.
- Folders: `sites/` site profiles · `demos/<site>/` plans · `recordings/` videos (git-ignored) ·
  `.runs/` rehearsal artifacts · `.sessions/` private sign-in sessions (git-ignored) ·
  `examples/sample-site/` sample site · `tools/recorder/` recorder and plan schema · `.vscode/` tasks.

### Terminal equivalents

```bash
node tools/recorder/record.mjs init-site my-site https://my-site.example --signed-in
node tools/recorder/record.mjs login --site my-site-signed-in
node tools/recorder/record.mjs inspect --site my-site --out .runs/inspect
node tools/recorder/record.mjs capture demos/my-site/new-demo.json --site my-site
node tools/recorder/record.mjs demos/my-site/new-demo.json --rehearse
node tools/recorder/record.mjs demos/my-site/new-demo.json
node tools/recorder/record.mjs all demos
```

`all` runs every plan in order. ffmpeg is optional: if it's installed, recording also makes a contact sheet
with one frame per step, and you can use it to [convert videos](docs/recipes.md#converting-the-video-to-h264-or-other-formats).

## Feedback and license

This is an early project. Bug reports, failing sites and suggestions are welcome as GitHub issues.
Licensed under [MIT](LICENSE).
