# Recipes

Practical patterns for common demo situations. Every recipe uses only the recorder's commands and plan
files, so it works the same whether a person or an AI agent follows it.

## HTTPS connection troubleshooting

A public HTTPS site can load in a normal browser but fail in the recorder's default headless Chrome.
For example, a site may return `net::ERR_HTTP2_PROTOCOL_ERROR` in headless Chrome while the same URL
loads in visible Chrome. That error alone does not identify the cause or mean that the site is down.

1. Check the URL and the exact error in the terminal or `.runs/inspect/report.json`. Confirm the site
   opens in your regular browser and check whether your network, VPN or proxy is required.
2. From the workspace root, inspect the **same site** with visible Chrome:

   ```bash
   node tools/recorder/record.mjs inspect --site my-site --out .runs/inspect --headful
   ```

   Replace `my-site` with your profile name. This requires a desktop session and opens a Chrome window.
   Check the resulting `page.png` and `elements.json` to confirm the intended page loaded.
3. If this succeeds where the default inspection fails, add `"headful": true` to `sites/my-site.json`.
   Plans extending that profile will then launch visible Chrome for rehearsal and recording, including
   the VS Code tasks. If using `connect` to attach to an existing Chrome, that browser's mode is unchanged.
   Rehearse the full flow before recording: a successful homepage load does not guarantee that later
   pages will load.
4. If both modes fail, or the site requires network access you do not have, investigate the connection
   with your network administrator or the site operator. The recorder uses `HTTPS_PROXY` (or
   `https_proxy`) and `NO_PROXY` (or `no_proxy`) when set; proxy credentials may be sensitive.

Visible Chrome is a diagnostic and configuration option, not a guaranteed fix. Do not disable HTTPS
certificate checks to work around a connection failure, or attempt to bypass CAPTCHAs or bot protection.

## Signed-in sites (SSO, MFA)

Sign-in is done **once, by a person**, and reused:

1. `record.mjs init-site my-site https://my-site.example --signed-in` creates `sites/my-site.json` and
   `sites/my-site-signed-in.json`. In the second, set `url` (where to start once signed in) and, if different,
   `loginUrl`.
2. `record.mjs login --site my-site-signed-in` opens a visible Chrome on the sign-in page. Sign in with a
   **test/demo account**, complete MFA, tick "remember this device" if offered, then close the window. The
   session is kept in `.sessions/my-site/`.
3. Demos that `extends` `my-site-signed-in.json` start signed in. If a run lands on the sign-in page, the
   session expired: repeat step 2.

Alternatives: if the site has a plain test login without MFA, put the sign-in in the profile's `setup` (it
runs before recording); see `sites/sample-signed-in.json`. If headless runs get challenged, start Chrome
yourself with `--remote-debugging-port=9222 --user-data-dir=<a dedicated folder>`, sign in there, and add
`--connect http://127.0.0.1:9222` to commands. Never put real credentials in files that get shared.

`.sessions/` holds live session cookies: it is git-ignored. Never share or commit it.

## Hiding sensitive data

List CSS selectors under `redact` in the (signed-in) site profile. Matching elements are blurred from the
first frame, inside iframes too, and their values are replaced with `[redacted]` in the text snapshots,
inspect output and reports. Find selectors with `inspect` (`.runs/inspect/elements.json` and `page.png`) or
Chrome DevTools (right-click an element → Copy → Copy selector). Prefer stable hooks (`[data-testid=…]`,
ids, semantic classes) over long generated paths. Check every recorded frame for content that appeared
mid-demo (e.g. a table inside a chat answer) and might need another selector.

## Cookie banners, surveys and other pop-ups

Dismiss them in the site profile's `setup` with `"optional": true` and a short `timeout`, so it doesn't fail
when they don't appear:

```json
{"action": "click", "target": {"role": "button", "name": "Accept all"}, "optional": true, "timeout": 3000}
```

Or make them invisible with `"hide": ["#survey-intercept"]`.

## Chat assistants and other streamed answers

**If you capture the demo, this is handled for you.** Type the question, press Enter (or click Send), and wait
for the whole answer before you do anything else. Capture then adds a step that waits for the answer around
the box you typed into, including any "thinking" pause before it starts:

```json
{"action": "type", "target": {"placeholder": "Ask a question"}, "text": "How do I open an account?", "submit": true},
{"action": "waitForStable", "around": {"placeholder": "Ask a question"}, "minMs": 3000, "pauseAfter": 2500}
```

`minMs` comes from how long you waited while capturing, so the recording never moves on sooner than about
half that time. After a rehearsal, the step's text file (`.runs/…/steps/NN-waitForStable.txt`) starts with a
**WATCHED AREA** section showing the text the step followed: check that the whole answer is there.

**Writing the plan by hand,** you can also point at the answer itself when you know where it appears:

```json
{"action": "click", "target": {"role": "link", "name": "Assistant"}},
{"action": "type", "target": {"frame": "#assistant-frame", "placeholder": "Ask a question"}, "text": "How do I open an account?", "submit": true},
{"action": "waitForStable", "target": {"frame": "#assistant-frame", "css": ".answer"}, "pauseAfter": 3000}
```

- **Find the panel:** run `inspect` with the assistant open (add the click that opens it to a copy of the
  site profile's `setup`), then look under `frames` in `elements.json` for its `frameSelector`, input and
  buttons. Record what you learn in the site profile's `notes`.
- **Wait for the answer**, not a fixed delay: `waitForStable` with `around` set to the question box needs no
  knowledge of the page. On the newest reply (`target`, last match used) it holds until that stops changing.
  `pauseAfter` then gives viewers 2–3 s to read it (longer for long answers). Avoid `{"css": "body"}` on
  busy pages: banners and carousels elsewhere keep it changing.
- **Slow "thinking" before the answer:** raise `minMs`, or `changeMs` if the answer takes more than 20 s to
  start.
- **Answers vary between runs** (and test backends can be slow). After recording, check that the answer is
  on-topic, complete and error-free: read `.runs/…/steps/NN-waitForStable.txt` or look at the contact sheet.
  If it's off, record again.
- **Legibility:** a small panel on a big page needs `"zoom": 1.25`–`1.5` in the site profile.

## Making text readable

The video is 1920×1080 by default. Desktop sites look small at that size; `"zoom": 1.25`–`1.5` renders a
narrower layout at full sharpness. Rehearse and check the layout still looks right.

## Typing a question vs. asking it

If a description says "type X into the box" in a chat/search context, the result is usually the point:
add `"submit": true` and wait for the answer. Only type without submitting if the demo is about the input
itself (autocomplete, validation).

## Multi-page flows

Recording continues across page loads. Links that open a new tab are loaded into the recorded tab. After a
step that navigates, the next step automatically waits for the new page. Add a `waitFor` with `url` or a
`target` when the page loads content late.

## When a step fails

Rehearse (`--rehearse`). The terminal names the failing step; `.runs/<demo>/failure.png` and `failure.txt`
show the page, and `report.json` → `pageAtFailure` lists everything clickable (including inside iframes) with
names you can use as targets. Typical fixes: the visible text differs from the accessible name (use what
`pageAtFailure` says), the element is in an iframe (add `frame`), a pop-up covers it (dismiss in `setup`),
or it only appears after hovering (add a `hover` step first). Re-capturing by demonstration is often quickest.

## A batch of demos

One plan per feature under `demos/<site>/`. Rehearse all, then record all (`record.mjs all demos`), which
runs them one at a time, since parallel recordings compete for CPU and drop frames, and prints a pass/fail
table.

## Converting the video to H.264 or other formats

Recordings are saved as **AV1** MP4, because that is the only format Chrome's built-in recorder produces.
AV1 plays in Chrome, Edge, Firefox and VLC, and on most video sites. It may **not** play in QuickTime,
Safari, PowerPoint, Keynote, older Macs, some Windows setups, or some video editors. Converting is
optional and happens after recording; the recorder itself never needs a converter.

Always keep the original AV1 file. Each command below writes a **new** file next to it.

### Without the command line: HandBrake

[HandBrake](https://handbrake.fr/) is a free, open-source converter for Mac, Windows and Linux.

1. Open the recording in HandBrake.
2. Choose a preset such as **General → Fast 1080p30**. To keep 60 fps, set **Video → Framerate** to
   **Same as source**, with **Constant Framerate**.
3. Leave **Video Encoder** on **H.264 (x264)**. For sharper small text, lower **Constant Quality (RF)**
   to about 18.
4. Choose where to save the file and click **Start**.

### With ffmpeg

Install [ffmpeg](https://ffmpeg.org/download.html): `brew install ffmpeg` on Mac,
`winget install Gyan.FFmpeg` on Windows, or `sudo apt install ffmpeg` on Debian/Ubuntu. Check that
your build can read AV1 by running `ffmpeg -hide_banner -decoders | grep -i av1` (on Windows use
`findstr /i av1` instead of `grep`). The list should include `libdav1d` or `av1`.

**H.264 MP4: plays almost everywhere (QuickTime, PowerPoint, Keynote, Slack, Teams):**

```bash
ffmpeg -i demo.mp4 -c:v libx264 -pix_fmt yuv420p -crf 18 -preset veryfast \
  -c:a aac -movflags +faststart demo.h264.mp4
```

- `-pix_fmt yuv420p` is required for QuickTime and PowerPoint.
- `-crf 18` keeps small UI text sharp. Higher numbers give smaller, softer files; 23 is ffmpeg's default.
- `-movflags +faststart` lets the video start playing before it has fully downloaded.
- Expect the file to be roughly 2–3 times the size of the AV1 original.

**Smaller H.264 at 30 fps** (for email or upload limits):

```bash
ffmpeg -i demo.mp4 -r 30 -c:v libx264 -pix_fmt yuv420p -crf 23 -preset veryfast \
  -c:a aac -movflags +faststart demo.small.mp4
```

**WebM (VP9)** for web pages that prefer it:

```bash
ffmpeg -i demo.mp4 -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -c:a libopus demo.webm
```

**Animated GIF** for a short clip in a README or chat message (no audio; keep it under ~15 seconds):

```bash
ffmpeg -i demo.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" demo.gif
```

**Convert every recording at once** to H.264. Files that have already been converted are skipped.

Mac/Linux:

```bash
find recordings -name '*.mp4' ! -name '*.h264.mp4' ! -name '*.partial.mp4' -exec sh -c \
  'ffmpeg -n -i "$1" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset veryfast -c:a aac -movflags +faststart "${1%.mp4}.h264.mp4"' _ {} \;
```

Windows (PowerShell):

```powershell
Get-ChildItem recordings -Recurse -Filter *.mp4 |
  Where-Object { $_.Name -notlike '*.h264.mp4' -and $_.Name -notlike '*.partial.mp4' } |
  ForEach-Object { ffmpeg -n -i $_.FullName -c:v libx264 -pix_fmt yuv420p -crf 18 -preset veryfast `
    -c:a aac -movflags +faststart ($_.FullName -replace '\.mp4$', '.h264.mp4') }
```

Converted files stay inside `recordings/`, which Git ignores. Watch the converted video before sharing
it, just as you would the original.
