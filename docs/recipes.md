# Troubleshooting

For the complete first-time setup and recording steps, see [Get started](../README.md).

## I can't find “Stand-in: Record Website”

Make sure you installed the `.vsix` file using **Extensions: Install from VSIX** and reloaded VS Code
if prompted. Open the Command Palette and search for **Stand-in: Record Website**. If it still doesn't
appear, check that the extension is enabled in the Extensions view and that VS Code is version 1.109
or newer.

## VS Code can't find Node.js, or says the version is too old

The extension normally uses the Node.js built into VS Code, so this only happens with a VS Code from
before early 2026, or with the skill or command line. Update VS Code, or install
[Node.js](https://nodejs.org/en/download) 22 or newer. Fully quit and reopen VS Code, then try the
command again. If it still cannot find the correct version, make sure
your Node installation is available on your system's PATH; you may need help from your IT administrator.
The error in the terminal can identify the version Stand-in found.

## Chrome isn't found

Stand-in requires Google Chrome 153 or newer. In Chrome, open **Help > About Google Chrome** to check
the version and look for updates. [Install or update Chrome](https://www.google.com/chrome/), or install
a recent Chrome Beta, Dev, Canary, or Chrome for Testing. Then try again. A different browser, such as
Safari or Firefox, won't work. If Chrome is installed in an unusual location, an advanced user can set
the `CHROME_PATH` environment variable to the Chrome executable.

## The site doesn't open or won't let me sign in

Check the full website address, your internet connection, and whether your VPN or proxy is needed.
Some sites block automated browsers or require additional security checks. Complete any sign-in or
security checks yourself; do not bypass site protections. A saved session may also expire or be rejected
by the website.

## Pressing Shift twice doesn't start or stop recording

Click inside the recorded website tab, then press **Shift** twice, quickly: two taps within about half
a second, with nothing else in between. While recording, the tab's title starts with a red dot and a
timer (● 0:42); the terminal also says **Recording this tab**. Press Shift twice again and wait for
**Your video is ready**. (The original shortcut, **Control+Shift+9**, also still works.)

Stand-in keeps the demo in the tab it opened: links that would open a new tab open there instead. If a
site opens a pop-up window (a sign-in window, say), finish there and click back in the original tab;
pressing Shift twice only works in the recorded tab.
If an embedded part of the page doesn't respond, click the main page and try again.

A link to another app (an email address, a phone number or a text message) makes Chrome ask whether to
open that app; until you answer, the page can't hear Shift. Answer the prompt, then try again.

If it still does nothing, use the terminal instead: click in the Stand-in terminal in VS Code
and press **Enter** to start (Chrome comes to the front), then click back in the terminal and press
**Enter** again to stop and save.

## I can't find my video or plan

Choose **Show in Folder** in the "Your video is ready" message. Or open **View > Terminal** in VS Code and
look for the paths after **Replay plan** and **Your video is ready**.
They're normally in the **recordings** and **demos** folders inside the workspace folder or the folder
you chose. If the terminal reports an error, don't assume both files were saved: a video may have been
saved even if the plan could not be saved.

If the tab or Chrome was closed, or you pressed Ctrl+C, before stopping, the video up to that moment is
still saved and the terminal says so. Only a recording stopped within its first few seconds can be too
short to save.

## My video is shorter than my recording

That's on purpose: pauses where nothing on screen changed are shortened to at most 3 seconds, and the
time before your first action and after your last is trimmed. The terminal shows the before and after
length. Anything that moves is kept, so to hold a moment longer, keep the pointer moving, or replay the
plan and raise the `ms` of its `wait` step. Replays keep their timing exactly.

## The video won't play

Stand-in saves standard H.264 MP4 videos, which play almost everywhere. If the terminal said it **kept
the original AV1 video**, it couldn't convert this one (for example, a Chrome without an H.264 encoder).
AV1 plays in Chrome, Edge, Firefox, VLC and Macs with Apple silicon M3 or newer, but not in QuickTime on
Intel Macs or some editors. Drag the file into a Chrome window to watch it, or convert it with a tool such
as HandBrake.

## Replay asks for confirmation or fails

Replay runs the plan's actions on the website again; it is not a video player. Those actions can change
real data, because replay uses your saved browser session. A plan you recorded replays without asking.
When it's new to Stand-in or has changed since (edited, or from someone else), the terminal asks once:
review the JSON plan, then type **y** and press Enter only if you approve.

If a page, selector, or signed-in session has changed, replay may fail. The terminal says which step
failed and why, and saves the video up to that point with `-incomplete` in its name. Sign in during a new
recording if the session expired, or edit that step in the plan: change its `target`, give it a longer
`timeout`, or add `"optional": true` so replay skips it when it is missing. To check the steps quickly
without making a video, run the replay from the command line with `--rehearse`. Some preparation done before
the original recording may also need to be repeated. Your original MP4 is not modified by replay.

If the step clicks a link in a menu that opens when you point at a nav item, replay opens the menu itself.
If it can't find the nav item, add a step just before it that points at the item, for example
`{"action": "hover", "target": {"role": "link", "name": "Planning & Advice"}}`.

## Replay fails on a site that worked when I recorded it

The site probably changed between visits, or noticed that a program is controlling the browser:

- **It showed a security check** ("Just a moment…", "Verify you are human", a slider or "Press & Hold").
  Look at the end of the `-incomplete` video. A replay can't pass these checks, and Stand-in doesn't
  try. Wait a while and replay again, or record again by hand.
- **It looked different the second time.** Replay reuses your browser session, so the site sees a
  returning visitor. It may show another home page, or keep a language or region you chose during the
  recording. Change the step to something on the page it shows now, or record again.
- **What you clicked was gone.** Headlines, reviews, offers and ads change from visit to visit. Edit
  the step to click something lasting, such as a menu or a section link, or mark it `"optional": true`.
- **It wanted you to sign in.** Sign in during a new recording so the session is saved, then replay.

Before asking an assistant to make a demo of a new site, record a short one by hand. You'll see
quickly whether the site works with Stand-in at all.

## I recorded sensitive information

Stand-in has no automatic redaction. Review the entire MP4 and use video editing software to remove
anything you don't want to share. Review the JSON plan too, and keep the `.sessions` folder private:
it can contain sign-in cookies. These files are not automatically excluded from every repository.
