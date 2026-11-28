# Try Stand-in: a website demo video in one take

Stand-in turns what you do on a website into a video you can share. Press Shift twice, show the site,
press Shift twice again, and a few seconds later you have a finished MP4. You don't need to write code or edit
video.

## What you'll get

- **A finished video**, a standard MP4 that plays in QuickTime, Windows, PowerPoint, Teams and Slack.
  It's named after the site and the time, such as `wikipedia.org-2026-11-22-14-05.mp4`, and VS Code
  offers to open it.
- **No dead air.** Long pauses where nothing on screen changes are shortened to at most 3 seconds, so
  you can stop and think while recording.
- **No lost takes.** The video is saved while you record. If Chrome closes or crashes early, you still
  get everything up to that moment.
- **A record of your steps, so you can make the video again.** Stand-in also saves a list of the
  clicks and typing in your demo (in the **demos** folder). Later, it can repeat those steps and record a
  fresh video, for example after the website changes, or with captions added. See
  [Make the video again](#optional-make-the-video-again).

## Set up once

You need:

1. **VS Code 1.109 or newer.** [Download VS Code](https://code.visualstudio.com/).
2. **Google Chrome 153 or newer.** [Download Chrome](https://www.google.com/chrome/).
3. **The Stand-in `.vsix` file** from your team.

In VS Code, open the Command Palette (**Cmd+Shift+P** on a Mac, **Ctrl+Shift+P** on Windows), choose
**Extensions: Install from VSIX**, and select the file. That's everything: the extension uses the
Node.js built into VS Code. If your company manages software installations, ask your IT team for help.

## Make your first video

1. Open the Command Palette and choose **Stand-in: Record Website**.
2. Enter a website address, such as `wikipedia.org`, and press Enter.
3. When Chrome opens, get the page ready. If your demo needs you to sign in, do it now; Stand-in
   remembers the sign-in for next time.
4. Press **Shift twice**, quickly. The tab's title now shows a red dot and a timer (● 0:01): you're
   recording. Do your demo.
5. Press **Shift twice** again. Chrome closes; a few seconds later VS Code says **Your video is
   ready**. Choose **Open Video**.

Shift on its own doesn't type anything, so it won't get in the way of your demo. If pressing Shift
twice does nothing, click in the Stand-in terminal in VS Code and press **Enter** instead:
once to start, once to stop. (To see the terminal, choose **View > Terminal**.)

Stand-in doesn't ask where to save. Videos go into the folder open in VS Code or, if none is, into
**Movies/Stand-in** in your home folder (**Videos/Stand-in** on Windows). **Show in Folder** in the
"Your video is ready" message takes you there.

## What to expect

- Everything happens in the one tab Stand-in opened. Links and buttons that would open a new tab open
  in that tab instead, so they're in the video. The address bar, browser dialogs and sound aren't
  recorded, and neither are pop-up windows such as a sign-in window.
- The video is ready a few seconds after you stop, roughly a quarter of the recording's length. The
  terminal shows how long it is and how much the pauses were shortened.
- If something goes wrong, Stand-in says what happened and what to do in one sentence. When the fix is
  installing or updating Chrome, the message has a button for it.

## Before you share

- The video shows everything that was visible in the tab. Stand-in doesn't hide account details or
  other sensitive information, so watch it first and use video editing software to remove anything
  that shouldn't be shared.
- The replay plan in **demos** can contain website addresses and text you typed (password fields are
  left out).
- The hidden **.sessions** folder holds your sign-in cookies. Keep it private.
- Check your company's rules before storing or sharing videos, plans or session data.

## Optional: make the video again

Replay visits the site again, repeats what you did, and records a new video. This is useful after the
site changes, or after you add captions to the plan. Your first video isn't changed.

1. Choose **Open Replay Plan** in the "Your video is ready" message.
2. Choose **Stand-in: Replay Plan**. The open plan replays straight away.
3. Replay can make real changes on signed-in sites. A plan you recorded replays without asking, even
   after you edit it. If the plan came from someone else, the terminal asks once: type **y** and press
   Enter only if you approve its actions.

If a step can't be done because the site changed, Stand-in stops, says which step and why, and keeps
the video up to that point.

## Optional: ask an assistant

If GitHub Copilot is available in your VS Code setup, you can describe the demo instead of performing
it. For example: “Use Stand-in to open Wikipedia, search for space exploration, and show the result.”
You'll still need to sign in yourself and approve any signed-in replay.

Try the site by hand first. Some sites show security checks to browsers controlled by a program, or a
different page on a second visit, and a quick recording of your own shows whether that happens before
you ask an assistant. See [Sites that push back](https://github.com/beekmarks/stand-in#sites-that-push-back).

## Option 2: use the Copilot skill without the extension

**Pilot note:** Discovery of the standalone skill in VS Code has not yet been verified.

You need VS Code with GitHub Copilot and agent skills available, [Node.js](https://nodejs.org/en/download)
22 or newer, Chrome 153 or newer, and the Stand-in skill ZIP from your team. After installing Node.js,
fully quit and reopen VS Code.

1. Extract the ZIP. It contains this guide and a folder named `stand-in` with `SKILL.md` and
   supporting files.
2. Copy the entire `stand-in` folder into your personal `.copilot/skills` folder. This makes the
   skill available across your workspaces. Create the `skills` folder if needed:
   - Mac: in Finder, choose **Go > Go to Folder**, enter `~/.copilot`, then open or create `skills`.
   - Windows: in File Explorer, enter `%USERPROFILE%\.copilot` in the address bar, then open or
     create `skills`.
   - Linux: open or create `~/.copilot/skills`.
   If `.copilot` does not exist yet, create it in your home folder first.
3. If a `stand-in` folder is already there, back it up or remove it before copying the new one; do
   not merge versions. The final path should be `.copilot/skills/stand-in/SKILL.md`.
4. Open a folder in VS Code for your videos. Start a new Copilot chat in a session that supports
   skills. Type `/` and check for `stand-in`, or open **Chat: Open Customizations** and look under
   **Skills**. If it is missing, check the folder path and your company's Copilot settings.
5. Ask: **“Use Stand-in to record a demo of https://www.wikipedia.org. Search for space exploration
   and show the result.”** Review and approve any requested tool actions.

To drive the website yourself instead, say **“Use Stand-in to let me record a demo of
https://www.wikipedia.org manually.”** The assistant will start the recorder and tell you to press
Shift twice to start and stop, and should report where it saved the video and replay plan. With the skill alone, ask
Copilot to replay a plan instead of using the Command Palette.

The skill includes the recorder's dependencies; the extension's Command Palette commands are not
available with the skill alone. Skill availability depends on the active agent and your company's
Copilot settings.

## Need help?

See [Troubleshooting](recipes.md), or contact the person who gave you Stand-in. For the command line,
see [Other ways to use Stand-in](https://github.com/beekmarks/stand-in#other-ways-to-use-stand-in).
