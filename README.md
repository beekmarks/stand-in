# Stand-in

Record a website demo with one shortcut, then **replay it later as a polished video**. Press
Control+Shift+9, do your demo, and press it again: Stand-in saves an MP4 and an editable replay plan
of what you did. Replay that plan whenever you need the video again, after the site changes or with
captions, highlights and a smooth cursor added, and it waits for streamed AI assistant answers to
finish before moving on.

![A replay of the bundled sample plan: a caption, a highlighted link, a question typed into a chat assistant, and the replay waiting for the streamed answer](docs/demo.gif)

*A replay of the bundled sample plan, [`demos/sample/assistant-tour.json`](demos/sample/assistant-tour.json),
on a fictional website (shown at 1.5× speed).*

## Choose how to use Stand-in

1. **VS Code extension:** Record yourself using a menu command. This is the simplest option without
   an assistant. Follow the [setup below](#1-set-up-once).
2. **Copilot skill:** Ask an assistant to record your requested actions or start a manual recording.
   The extension includes the skill, or you can
   [install the standalone skill](docs/company-pilot-guide.md#option-2-use-the-copilot-skill-without-the-extension)
   without the extension. The standalone skill's discovery in VS Code has not yet been verified.
3. **Command line:** Run the recorder directly from a source checkout. See
   [command-line instructions](#command-line-from-source).

All options require Node.js and Chrome. The skill also requires a compatible Copilot setup.
The rest of the first-time guide below uses the VS Code extension.

**The shortcut is Control+Shift+9:** press it once to start and again to stop. On a Mac, use
**Control**, not Command. It only works while the website in Chrome has focus; if nothing happens,
click in the Stand-in terminal in VS Code and press **Enter** instead (once to start, once to stop).

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

If the shortcut does nothing (usually because Chrome isn't focused), click in the Stand-in terminal and
press **Enter** to start, then **Enter** again to stop. Chrome comes to the front when you do.

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

**Demoing a chat assistant?** Ask your question, press Enter or click Send, and wait for the whole answer
before doing anything else. The plan then waits for the answer on replay, however long it takes, instead
of for a fixed time; it rides out "thinking" pauses and ignores changes elsewhere on the page. See
[Waiting for chat answers](docs/plan-format.md#waiting-for-chat-answers).

### Try the sample replay

The repository includes a sample plan for a fictional website, so you can try replay without recording
anything or signing in. Download the repository (**Code > Download ZIP** on GitHub) and unzip it. In
VS Code, choose **Stand-in: Replay Plan** and select `demos/sample/assistant-tour.json`. The new video
appears in **recordings** in the folder you chose.

## Optional: ask an assistant

If you use GitHub Copilot in VS Code, you can ask an assistant to make the demo for you. For example:

> Use Stand-in to open https://www.wikipedia.org, search for space exploration, and show the result.

The bundled Stand-in skill can create an editable plan and record it. Skill availability depends on your
Copilot setup and active agent. The assistant should not sign in for you, and a signed-in replay still
needs your approval.

You can also use Stand-in as a **standalone Copilot skill**, without the extension. See the
[skill installation guide](docs/company-pilot-guide.md#option-2-use-the-copilot-skill-without-the-extension).
The standalone skill includes its recorder dependencies, but still requires Node.js and Chrome.

## Command line from source

For users comfortable with a terminal, install Node.js 24.11+ and Chrome 153+, then run these
commands from a Stand-in source checkout:

```sh
npm ci --prefix tools/recorder
node tools/recorder/record.mjs https://www.wikipedia.org
```

Prepare the page, then use **Control+Shift+9** to start and stop. Wait for the terminal to report
the saved video and plan; they are placed in `recordings/` and `demos/` under the current folder.
To replay a reviewed plan, run:

```sh
node tools/recorder/record.mjs replay demos/your-plan.json
```

Replay can change real data and may ask for confirmation, as described above.

## Related projects

Stand-in builds on Chrome's native tab recorder through Paul Irish's
[chrome-capture](https://github.com/paulirish/chrome-capture), with browser control from Playwright.
Other tools cover similar ground and may suit you better:
[Chrome DevTools Recorder](https://developer.chrome.com/docs/devtools/recorder) and Playwright `codegen`
also turn clicks into replayable steps; [RunThru](https://github.com/marktolson/runthru) and
[humanjs](https://github.com/totigm/humanjs) capture flows by demonstration; and
[webreel](https://webreel.dev/) and Playwright's screencast API produce polished scripted videos.
Screen recorders such as Loom are simpler when you only need one take and never plan to re-record.

## Need help?

See [Troubleshooting](docs/recipes.md) for missing commands, Node or Chrome errors, shortcut problems,
and replay issues. Share the [company pilot guide](docs/company-pilot-guide.md) with colleagues who
want to try Stand-in. The [plan reference](docs/plan-format.md) covers advanced JSON editing.

## Build the extension from source

For developers: install Node.js 24.11+, run `npm install`, then run `npm run package` in the repository.
This creates a VSIX that can be installed as described above. The existing workspace tasks remain
available to contributors working in this source checkout.

To build the standalone skill ZIP instead, run `npm run package:skill`. The ZIP appears in `dist/`;
share it with the skill installation instructions. Build it after `npm install`, and rebuild it when
the skill, recorder, or plan reference changes.
