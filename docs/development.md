# Development and packaging

[English overview](../README.md) · [Обзор на русском](../README.ru.md)


Use Node.js 24.12 or newer and Git 2.38 or newer. Install dependencies and check the source:

```sh
npm ci
npm run check
npm test
```

Open the app:

```sh
npm start
```

Read a board through the source CLI (replace the project path):

```sh
npm run taskboard -- --project "/path/to/project" list --json
```

Check board refreshes in a hidden Electron window using local fixture data:

```sh
node scripts/check-board.mjs
```

The check verifies newest-first ordering, preview stability, data updates, filters, focus and scrolling. Add `--artifacts <directory>` to keep screenshots. It removes its temporary profile and files when it exits.

In VS Code on Windows, open the repository folder and press **F5** to launch **AI Taskboard** from **Run and Debug**. Set breakpoints in `src/desktop/main.ts` to debug the Electron main process. The debug session uses its own profile in `dist/vscode-profile`.

To review a task, select **Проверить задачу** in **Run and Debug**, press **F5**, and choose the worktree directory shown on the task card before entering the task ID. Task worktrees use `.worktrees`. The app opens its welcome page from the task's worktree and uses a separate profile for that task.

Build on Windows x64:

```sh
npm run package
```

The NSIS installer and unpacked application are written to `release/`. The command builds the standalone CLI with its Node.js runtime before packaging the app. It does not publish a GitHub release.

The Linux build uses `AI_TASKBOARD_PROJECT_URL` and `AI_TASKBOARD_MAINTAINER` for package metadata. The signed macOS PKG profile requires Developer ID identities and notarization credentials.

Native CI uses Node.js 24.14.0 and builds NSIS on Windows, DEB and RPM on Linux, and an ad-hoc signed ZIP on macOS. Each platform runs on both native x64 and ARM64. The CI profile is available through `npm run package -- --ci`. See the [CI matrix and local verification commands (Russian)](how-to/development.md#поставка) and [per-commit CI results](https://github.com/edwardgushchin/AI-Taskboard/actions/workflows/ci.yml).

[Project design](explanation/architecture.md)
