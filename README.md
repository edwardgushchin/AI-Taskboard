# AI Taskboard

An agent-native Kanban task board for software projects. The Electron app and Codex share one local board and one CLI. Task work stays in a separate Git worktree until you accept it.

## Use the app

On Linux, install the local package with `sudo apt install ./ai-taskboard-0.1.0-linux-amd64.deb` or `sudo dnf install ./ai-taskboard-0.1.0-linux-x86_64.rpm` so the package manager can resolve desktop dependencies.

1. Open AI Taskboard and choose a project folder. Select **Create board** if the project has no board yet.
2. Open **Settings → Codex integration → Connect Codex**. Open a new local Codex chat for the project after the app confirms installation.
3. Ask Codex to create a task. Approve it in AI Taskboard, then ask Codex to work on its task number. A second chat can resume the same task and worktree.
4. Review the submitted diff in the app. **Accept** creates or verifies the acceptance commit in the target branch.

Use **Settings → Appearance** to follow the system or select a built-in theme. The setting applies to every window.

The board lives in the project's `.tasks` folder. Git operations require Git 2.38 or newer. Codex may ask for approval to run `start`, `preview`, or `submit` because Git writes to the protected `.git` directory. Use the approval request for the specific Taskboard command. [Protected paths in Codex](https://learn.chatgpt.com/docs/agent-approvals-security#protected-paths-in-writable-roots)

## Develop and package

Use Node.js 24.12 or newer and Git 2.38 or newer. Run `npm ci`, `npm run check`, and `npm test`. Run `npm start` to open the app. For a direct CLI command, use `npm run taskboard -- --project "/path/to/project" list --json`.

Run `npm run package` on the OS and architecture you are building for. The installer and unpacked application are written to `release/`. The package includes a standalone CLI with its own Node.js runtime.

- Windows produces an NSIS installer.
- Linux produces `.deb` and `.rpm` packages. Set `AI_TASKBOARD_PROJECT_URL` to the project URL and `AI_TASKBOARD_MAINTAINER` to the package maintainer name and email.
- macOS produces a `.pkg`. Configure the Developer ID identities and notarization credentials for distribution.

[Project design](docs/design.md)
