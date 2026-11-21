# Try Stand-in: record a website demo

Stand-in makes a video of what you do on a website. You can try it without writing code.

**Choose how to use Stand-in:**

1. **VS Code extension:** Use a menu command and record the demo yourself. This is the simplest
   option without an assistant; your team provides the `.vsix` file.
2. **Copilot skill:** Ask an assistant to record the actions or start a manual recording. The skill
   comes with the extension, or your team can provide the standalone skill ZIP. The standalone
   skill's discovery in VS Code has not yet been verified.
3. **Command line:** If you're comfortable with a terminal, see the
   [command-line instructions](https://github.com/beekmarks/stand-in#command-line-from-source).

You do not need both the extension and the standalone skill.

## Option 1: use the VS Code extension

### Set up once

You need these on your computer:

1. **VS Code 1.109 or newer.** [Download VS Code](https://code.visualstudio.com/).
2. **Node.js 24.11 or newer.** [Download Node.js](https://nodejs.org/en/download). Choose an LTS
   installer for your computer and follow the installation instructions.
3. **Google Chrome 153 or newer.** [Download Chrome](https://www.google.com/chrome/). Chrome Beta,
   Dev, Canary, and Chrome for Testing also work.
4. **The Stand-in `.vsix` file** from your team.

If your company manages software installations, ask your IT team for help with any of these.
After installing Node.js, fully quit and reopen VS Code.

### Install the extension

1. Open VS Code.
2. Open the Command Palette: press **Cmd+Shift+P** on a Mac, or **Ctrl+Shift+P** on Windows/Linux.
3. Type **Extensions: Install from VSIX** and select it.
4. Choose the Stand-in `.vsix` file your team provided. Reload VS Code if prompted.

## Option 2: use the Copilot skill without the extension

**Pilot note:** Discovery of the standalone skill in VS Code has not yet been verified.

You need VS Code with GitHub Copilot and agent skills available, Node.js 24.11 or newer, Chrome 153
or newer, and the Stand-in skill ZIP from your team. See the download links in the setup list above.
After installing Node.js, fully quit and reopen VS Code.

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
https://www.wikipedia.org manually.”** The assistant will start the recorder and explain the
shortcut. It should report where it saved the video and replay plan.

The skill includes the recorder dependencies, so you do not need to install additional recorder
packages. The extension's Command Palette commands are not available with the skill alone.
Skill availability depends on the active agent and your company's Copilot settings.

## Make your first video

These steps use the extension. For the skill, ask Copilot as described above.

1. In VS Code, open the folder where you want to save the video. If you don't open one, Stand-in will
   ask you to choose a folder.
2. Open the Command Palette and choose **Stand-in: Record Website**.
3. Enter a website address, such as `https://www.wikipedia.org`, and press Enter. Choose a folder if
   prompted.
4. When Chrome opens, get the page ready. If your demo needs you to sign in, you can do that now.
5. Click inside the website and press **Control+Shift+9**. On a Mac, use **Control**, not Command.
6. Wait until the VS Code terminal says **Recording this tab**. Then do the actions you want in your demo.
7. Click inside the website and press **Control+Shift+9** again. Wait until the terminal shows both
   **Saved** and **Saved replay plan** before closing the tab.

To see the terminal, choose **View > Terminal** in VS Code.

## Find your video

Open the folder you chose and look inside **recordings** for the new `.mp4` file. The terminal also
shows its full location. Open the video in your usual video player and watch it before sharing.

There will also be a `.json` file in the **demos** folder. You can ignore it unless you want to replay
the demo or add effects later.

## Before you share

- The video includes everything visible in the recorded tab. Stand-in does **not** automatically hide
  account details or other sensitive information. Use video editing software to remove anything that
  shouldn't be shared.
- The replay plan may contain website addresses and typed text. Password fields are replaced with
  placeholders, but other sensitive information may still be saved.
- The hidden **.sessions** folder may contain sign-in cookies. Keep it private. Check your company's
  rules before storing or sharing videos, plans, or session data.
- Browser controls, other tabs, native dialogs, and audio are not recorded. If you close the recorded
  tab before stopping, the video cannot be saved.

## Optional: replay a demo

Replay opens the website and performs the actions in your plan again, creating a new video. It does
not edit the original MP4, and it may not reproduce the original exactly if the website has changed.
With the standalone skill, ask Copilot to review and replay your plan instead of using the command below.

1. Review the `.json` file in **demos**.
2. Open the Command Palette, choose **Stand-in: Replay Plan**, and select the file.
3. The actions can change real data. If the terminal asks for confirmation, type **y** and press Enter
   only if you approve running them. Confirmation is required for Stand-in recordings even if you were
   signed out.
4. Wait for the new video path in the terminal and review the video.

## Optional: ask an assistant

If GitHub Copilot is available in your VS Code setup, you can ask it to make a demo using Stand-in.
For example: “Use Stand-in to open Wikipedia, search for space exploration, and show the result.”
The assistant can create a replay plan and record it; availability depends on your company's Copilot
setup. You'll still need to sign in yourself and approve any signed-in replay.

## Need help?

If a command isn't available or the shortcut doesn't work, contact the person who gave you Stand-in.
If VS Code reports an older Node version, fully quit and reopen it after installing Node.js.
