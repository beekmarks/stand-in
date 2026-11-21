# Troubleshooting

For the complete first-time setup and recording steps, see [Get started](../README.md).

## I can't find “Stand-in: Record Website”

Make sure you installed the `.vsix` file using **Extensions: Install from VSIX** and reloaded VS Code
if prompted. Open the Command Palette and search for **Stand-in: Record Website**. If it still doesn't
appear, check that the extension is enabled in the Extensions view and that VS Code is version 1.109
or newer.

## VS Code can't find Node.js, or says the version is too old

Install an LTS version of [Node.js](https://nodejs.org/en/download) that is at least 24.11. Fully quit
and reopen VS Code, then try the command again. If it still cannot find the correct version, make sure
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

## The shortcut doesn't start or stop recording

Click inside the recorded website tab and press **Control+Shift+9**. On a Mac, use **Control**, not
Command. Check the VS Code terminal for the current status: wait for **Recording this tab** before you
start your demo. Press the shortcut again and wait for **Your video is ready**.

Only the tab Stand-in opened is recorded. If the site opened another tab, the terminal says so; the
shortcut doesn't work there. Switch back to the original tab (or close the new one) first.
If an embedded part of the page doesn't respond to the shortcut, click the main page and try again.

If the shortcut still does nothing, use the terminal instead: click in the Stand-in terminal in VS Code
and press **Enter** to start (Chrome comes to the front), then click back in the terminal and press
**Enter** again to stop and save.

## I can't find my video or plan

Choose **Show in Folder** in the "Your video is ready" message. Or open **View > Terminal** in VS Code and
look for the paths after **Saved the replay plan** and **Your video is ready**.
They're normally in the **recordings** and **demos** folders inside the workspace folder or the folder
you chose. If the terminal reports an error, don't assume both files were saved: a video may have been
saved even if the plan could not be saved.

Closing the recorded tab before stopping loses the video. Start a new recording if this happened.

## The video won't play

Stand-in saves standard H.264 MP4 videos, which play almost everywhere. If the terminal said it **kept
the original AV1 video**, it couldn't convert this one (for example, a Chrome without an H.264 encoder).
AV1 plays in Chrome, Edge, Firefox, VLC and Macs with Apple silicon M3 or newer, but not in QuickTime on
Intel Macs or some editors. Drag the file into a Chrome window to watch it, or convert it with a tool such
as HandBrake.

## Replay asks for confirmation or fails

Replay runs the plan's actions on the website again; it is not a video player. Those actions can change
real data. Review the JSON plan, then type **y** and press Enter in the terminal only if you approve.
Stand-in recordings use a saved browser session, so confirmation is required even for a signed-out
recording.

If a page, selector, or signed-in session has changed, replay may fail. The terminal says which step
failed and why, and saves the video up to that point with `-incomplete` in its name. Sign in during a new
recording if the session expired, or edit that step in the plan: change its `target`, give it a longer
`timeout`, or add `"optional": true` so replay skips it when it is missing. To check the steps quickly
without making a video, run the replay from the command line with `--rehearse`. Some preparation done before
the original recording may also need to be repeated. Your original MP4 is not modified by replay.

## I recorded sensitive information

Stand-in has no automatic redaction. Review the entire MP4 and use video editing software to remove
anything you don't want to share. Review the JSON plan too, and keep the `.sessions` folder private:
it can contain sign-in cookies. These files are not automatically excluded from every repository.
