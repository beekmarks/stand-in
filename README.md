# Stand-in

Make a video of a website in VS Code. Open the site, do your demo, and stop recording. Stand-in saves
an MP4 video and an optional editable replay plan.

**The shortcut is Control+Shift+9:** press it once to start and again to stop. On a Mac, use
**Control**, not Command.

## 1. Set up once

You need:

- **VS Code 1.109 or newer.** [Download VS Code](https://code.visualstudio.com/).
- **Node.js 24.11 or newer.** [Download Node.js](https://nodejs.org/en/download): choose an LTS
  installer for your computer and follow its instructions.
- **Google Chrome 153 or newer.** [Download Chrome](https://www.google.com/chrome/). Chrome Beta,
  Dev, Canary, and Chrome for Testing also work. Stand-in opens its own Chrome window; other browsers
  aren't supported.
- **The Stand-in extension file**, ending in `.vsix`. Get it from a [project release](https://github.com/beekmarks/stand-in/releases)
  or your project maintainer. If no release is available, a developer can build it using the instructions
  below.

After installing Node.js, **fully quit and reopen VS Code** so it can find the new version.

### Install the extension

1. In VS Code, open the Command Palette: **Cmd+Shift+P** on Mac, or **Ctrl+Shift+P** on Windows/Linux.
2. Type **Extensions: Install from VSIX** and select it.
3. Choose the Stand-in `.vsix` file. Follow any prompt to reload VS Code.

That's it. You do not need to install additional recorder packages or use a terminal to set up the extension.

## 2. Record your first video

1. Open a folder in VS Code where you'd like to save your video. Alternatively, Stand-in will ask you to
   choose one.
2. Open the Command Palette again and select **Stand-in: Record Website**.
3. Enter the complete website address, for example `https://www.wikipedia.org`, and press Enter. If asked,
   choose a folder for the files.
4. When Chrome opens, get the page ready. You can sign in before recording if you want to show a signed-in
   page. Complete any sign-in or security checks yourself.
5. Click inside the website, then press **Control+Shift+9**. Wait until the VS Code terminal says
   **Recording this tab**. Now perform your demo.
6. With the website focused, press **Control+Shift+9** again. Wait until the terminal reports both
   **Saved** and **Saved replay plan**. Do not close the recorded tab before saving.

If you don't see the terminal, select **View > Terminal** in VS Code.

## 3. Find and review your video

In the folder you opened or chose, look in **recordings** for the new `.mp4` file. Open it in your
usual video player and watch it before sharing. The terminal also shows its full location.

Stand-in also saves a `.json` file in **demos**. You can ignore it if you're happy with the video; it's
there if you want to [replay or add effects](#optional-replay-or-add-effects) later.

**Before sharing:** Stand-in records everything visible in the recorded tab, including account details
and other sensitive information. It does not automatically hide or blur anything. Use video editing
software to remove anything you don't want in the finished video.

The JSON plan can contain page addresses, element names, and typed text. Password fields are replaced
with placeholders, but other sensitive values may be saved. The hidden **.sessions** folder contains
browser session data, which can include sign-in cookies. Keep all three private; don't commit or share
them without checking. In another repository, they are not automatically excluded from version control.

### What gets recorded?

Stand-in records one website tab, across page changes in that tab. Browser buttons and the address bar,
other tabs, native dialogs, and audio are not recorded. Video size depends on the available window size.
If you close the recorded tab before stopping, the video cannot be saved.

## Optional: replay or add effects

Replay visits the website again and performs the actions in your JSON plan. It creates a **new** video;
it does not edit your original MP4. Sites and sessions can change, so replay may not reproduce the
original exactly.

1. Find the JSON file in **demos** and review its actions. You can edit it to add captions or highlights;
   see the [plan reference](docs/plan-format.md).
2. In VS Code, open the Command Palette and choose **Stand-in: Replay Plan**. Select the JSON file.
3. Replay can make real changes on a website. If the terminal asks for confirmation, type **y** and press
   Enter only if you approve running those actions. Recordings made by Stand-in use a saved browser session
   and therefore require this confirmation even if you were signed out.
4. Wait for the new video path in the terminal, then review the video before sharing.

Your saved session may expire. If it does, make a new recording and sign in before starting. Some websites
may not allow a session to be reused. Actions performed while preparing the original page are not in the
plan.

## Optional: ask an assistant

If you use GitHub Copilot in VS Code, you can ask an assistant to make the demo for you. For example:

> Use Stand-in to open https://www.wikipedia.org, search for space exploration, and show the result.

The bundled Stand-in skill can create an editable plan and record it. Skill availability depends on your
Copilot setup and active agent. The assistant should not sign in for you, and a signed-in replay still
needs your approval.

## Need help?

See [Troubleshooting](docs/recipes.md) for missing commands, Node or Chrome errors, shortcut problems,
and replay issues. Share the [company pilot guide](docs/company-pilot-guide.md) with colleagues who
want to try Stand-in. The [plan reference](docs/plan-format.md) covers advanced JSON editing.

## Build the extension from source

For developers: install Node.js 24.11+, run `npm install`, then run `npm run package` in the repository.
This creates a VSIX that can be installed as described above. The existing workspace tasks remain
available to contributors working in this source checkout.
