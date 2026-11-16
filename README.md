# AI Taskboard

An agent-native Kanban task board for software projects. The Electron app manages local cards, chats, and review. Agents use the board's tools, and Codex App Server runs the models. Git task work stays in a separate worktree until you accept it.

## Use the app

The first version targets Windows x64. Run `ai-taskboard-0.1.0-win-x64.exe`, then start AI Taskboard from the Start menu.

1. Open AI Taskboard and choose a project folder. Select **Create board** if the project has no board yet.
2. Sign in with your subscription using `codex login`. AI Taskboard detects the Codex executable automatically. To choose it yourself, use **Settings → Codex model provider → Choose executable…**.
3. Describe the change to the project manager in AI Taskboard. Review the draft on the board and approve it. Start or resume the executor from the card.
4. Review the submitted diff in the app. **Accept** creates or verifies the acceptance commit in the target branch.

Use **Settings → Appearance** to follow the system or select a built-in theme. The setting applies to every window.

The board lives in the project's `.tasks` folder. Git operations require Git 2.38 or newer.

## Develop and package

Use Node.js 24.12 or newer and Git 2.38 or newer. Run `npm ci`, `npm run check`, and `npm test`. Run `npm start` to open the app. For a direct CLI command, use `npm run taskboard -- --project "/path/to/project" list --json`.

Run `node scripts/check-board.mjs` to check board refreshes in a hidden Electron window using local fixture data. It verifies newest-first ordering, preview stability, data updates, filters, focus and scrolling. Add `--artifacts <directory>` to keep screenshots. The check removes its temporary profile and files when it exits.

In VS Code on Windows, open the repository folder and press **F5** to launch **AI Taskboard** from **Run and Debug**. Set breakpoints in `src/desktop/main.ts` to debug the Electron main process. The debug session uses its own profile in `dist/vscode-profile`.

To review a task, select **Проверить задачу** in **Run and Debug**, press **F5**, and choose the worktree directory shown on the task card before entering the task ID. Windows Elevated uses `.taskboard-worktrees`. The app opens its welcome page from the task's worktree and uses a separate profile for that task.

Run `npm run package` on Windows x64. The NSIS installer and unpacked application are written to `release/`. The package includes a standalone CLI with its own Node.js runtime.

Future Linux and macOS releases use platform-native packages. The Linux build uses `AI_TASKBOARD_PROJECT_URL` and `AI_TASKBOARD_MAINTAINER` for package metadata. The macOS distribution requires Developer ID identities and notarization credentials.

[Project design](docs/design.md)
