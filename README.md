# AI Taskboard

An agent-native Kanban task board for software projects. The Electron app and Codex share one local board and one CLI. Task work stays in a separate Git worktree until you accept it.

## Use the app

The first version targets Windows x64. Run `ai-taskboard-0.1.0-win-x64.exe`, then start AI Taskboard from the Start menu.

1. Open AI Taskboard and choose a project folder. Select **Create board** if the project has no board yet.
2. Open **Settings → Codex integration → Connect Codex**. Open a new local Codex chat for the project after the app confirms installation.
3. Select **Create task** and describe the change. Codex fills in the draft fields and AI Taskboard opens the saved draft. Review and approve it, then ask Codex in the project chat to work on its task number. A second chat can resume the same task and worktree.
4. Review the submitted diff in the app. **Accept** creates or verifies the acceptance commit in the target branch.

Use **Settings → Appearance** to follow the system or select a built-in theme. The setting applies to every window.

The board lives in the project's `.tasks` folder. Git operations require Git 2.38 or newer. Codex may ask for approval to run `start`, `preview`, or `submit` because Git writes to the protected `.git` directory. Use the approval request for the specific Taskboard command. [Protected paths in Codex](https://learn.chatgpt.com/docs/agent-approvals-security#protected-paths-in-writable-roots)

## Develop and package

Use Node.js 24.12 or newer and Git 2.38 or newer. Run `npm ci`, `npm run check`, and `npm test`. Run `npm start` to open the app. For a direct CLI command, use `npm run taskboard -- --project "/path/to/project" list --json`.

In VS Code on Windows, open the repository folder and press **F5** to launch **AI Taskboard** from **Run and Debug**. Set breakpoints in `src/desktop/main.ts` to debug the Electron main process. The debug session uses its own profile in `dist/vscode-profile`.

Run `npm run package` on Windows x64. The NSIS installer and unpacked application are written to `release/`. The package includes a standalone CLI with its own Node.js runtime.

Future Linux and macOS releases use platform-native packages. The Linux build uses `AI_TASKBOARD_PROJECT_URL` and `AI_TASKBOARD_MAINTAINER` for package metadata. The macOS distribution requires Developer ID identities and notarization credentials.

[Project design](docs/design.md)
