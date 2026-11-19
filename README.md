<h1 align="center">AI Taskboard</h1>
<p align="center"><strong>A local task board for coding agents and the people reviewing their work.</strong></p>
<p align="center">English · <a href="README.ru.md">Русский</a></p>
<p align="center"><a href="#features">Features</a> · <a href="#workflow">Workflow</a> · <a href="#quick-start">Quick start</a> · <a href="#platforms">Platforms</a> · <a href="#documentation">Documentation</a> · <a href="#license">License</a></p>

![AI Taskboard showing demo tasks from draft through review and completion](docs/images/board.png)

*Real application renderer with public demo data. No model session or private conversation is shown.*

![Git status in the demo repository: feature/board-polish, zero incoming and three unpushed commits](docs/images/git-status.png)

*Git detail from the same window at 150% zoom: `feature/board-polish`, three local commits ahead of `origin`.*

AI Taskboard brings a Kanban board, agent chats and Git review into one Electron app. Describe a change to the project manager, approve a task, and let an executor work in a separate Git worktree. Review the result before it enters your target branch.

**Early development:** the first slice targets Windows x64. Public installers are not available yet; use the source quick start below. [Releases](https://github.com/edwardgushchin/AI-Taskboard/releases) will host installers when published.

<a id="features"></a>
## Features

- **Tasks that survive a chat.** Cards keep requirements, acceptance criteria, history, the latest result and the next step.
- **Manager, executor and reviewer.** Discuss the project, run tasks and inspect submissions in the same app. Review modes let a human, the project manager or a separate reviewer take part in review.
- **Isolated Git work.** Each Git task gets its own branch and worktree. Submission records a commit; acceptance integrates the reviewed result into the chosen target branch.
- **A local board shared with agents.** The app and agents use the same CLI and project `.tasks` storage. Non-Git tasks use an assigned directory and can submit artifacts without a commit.
- **Several projects in view.** Project tabs, separate windows, column filters, English and Russian UI, and built-in themes.

<a id="workflow"></a>
## From request to merged change

| Step | What happens |
| --- | --- |
| 1. Discuss | Tell the project manager what you want. A draft captures the problem and verifiable acceptance criteria. |
| 2. Approve and start | Approve the draft, then start the executor. For a Git task, the board assigns a branch and worktree. |
| 3. Execute | The agent changes files, runs checks and records progress. A blocker includes the condition needed to continue. |
| 4. Review | A submission includes a diff, checks and limitations. Return it with feedback when changes are needed. |
| 5. Accept | In human review mode, you accept the result. The board creates or verifies the acceptance commit in the target branch. Conflicts require resolution before acceptance. |

<a id="quick-start"></a>
## Quick start

### Requirements

- Windows x64 for the current development slice; see [platform status](#platform-status).
- Node.js **24.12+**, npm and Git **2.38+** for source development.
- A Codex executable and subscription sign-in for running agents. The app uses **Codex App Server**; no separate paid API key is required by the board. Subscription access and usage limits still apply.

### Run from source

```sh
git clone https://github.com/edwardgushchin/AI-Taskboard.git
cd AI-Taskboard
npm ci
npm start
```

Sign in with your subscription before running agents:

```sh
codex login
```

1. Open a project folder and choose **Create board** if it has no board yet. Select **Board for agents** for the workflow described here.
2. AI Taskboard detects Codex automatically. To select it manually, open **Settings → Codex model provider → Choose executable…**.
3. Describe a change to the manager, approve its draft, then start the executor from the card.
4. Inspect the submitted diff and checks. In human review mode, choose **Accept** when the result is ready.

Use **Settings → Appearance** to choose **Light**, **Dark**, or **System** for all windows. System follows OS appearance changes while the app is open, including scheduled changes. Palette changes fade briefly; reduced motion makes them immediate. Older presets become the standard light or dark theme. Source checks, CLI examples, VS Code debugging and packaging instructions are in the [development guide](docs/development.md).

### Install a packaged build

When a Windows installer is published, download the EXE for your architecture from [Releases](https://github.com/edwardgushchin/AI-Taskboard/releases), run it, then launch AI Taskboard from the Start menu. The package includes a standalone CLI and its Node.js runtime; source Node.js is not required for that package. Git and Codex remain external requirements for Git tasks and agents. Until then, build locally with the development guide.

<a id="platforms"></a>
## Platform status

Native CI builds and checks x64 and ARM64 packages for Windows, Linux, and macOS. See the [build and signing guide](docs/how-to/development.md#поставка), [CI results for each platform](https://github.com/edwardgushchin/AI-Taskboard/actions/workflows/ci.yml), and [formats for public downloads](docs/how-to/development.md#выпуск-на-github).

## Data and boundaries

Cards and board state live in the project's local **`.tasks`** directory, outside Git history. Back it up separately from source commits. Git worktrees isolate task changes, but acceptance still depends on the target branch and Git checks. Agent execution uses the configured provider's permissions and limits.

Codex is the current model provider. Claude Code, Cursor and other client integrations are planned.

<a id="license"></a>
## License and commercial permission

Copyright 2026 Eduard Gushchin. AI Taskboard is source-available under the
unchanged [PolyForm Noncommercial License 1.0.0](LICENSE). It is not OSI Open
Source: the license restricts commercial use, which [OSD section 6](https://opensource.org/osd)
does not allow.

The license permits noncommercial purposes, including personal research,
experimentation, study, entertainment and hobby use without anticipated
commercial application. It also permits use by charitable organizations,
educational institutions, public research organizations, public safety or
health organizations, environmental protection organizations and government
institutions, **regardless of their funding source or obligations resulting
from funding**. These exceptions are part of the license; this summary does
not narrow them. Statutory rights such as fair use are unaffected.

For commercial use outside those permitted purposes, request separate
permission from **Eduard Gushchin** at **[eduardgushchin@yandex.ru](mailto:eduardgushchin@yandex.ru)**
before using the software. Describe your organization, intended use and
distribution, if any. Permission, scope and any payment terms must be agreed
separately; sending a request grants no commercial permission.

When distributing copies or permitted modifications, include the license
text or its URL and the `Required Notice:` from [NOTICE](NOTICE). Third-party
components keep their own licenses and notices, including Codicons (CC-BY-4.0)
and Codex Worklog (MIT). No previously granted rights are revoked.

Installed desktop applications include these project terms in
`resources/licenses` (`Contents/Resources/licenses` on macOS). Vendor and
dependency licenses remain in `resources/app.asar`; Electron and Chromium
notices ship with the runtime. The CLI directory includes `LICENSE`, `NOTICE`,
this README and `THIRD-PARTY-NOTICES.txt`; distribute them with the executable.
CLI builds download the license for the exact build-time Node.js version
from the official Node.js repository and include it with the fflate license.

<a id="documentation"></a>
## Documentation and feedback

- [Documentation index](docs/README.md): guides and project notes.
- [Development and packaging](docs/development.md): checks, CLI, VS Code and installer builds.
- [Project design](docs/explanation/architecture.md) (Russian): workflow, storage, Git integration and review rules.
- [Releases](https://github.com/edwardgushchin/AI-Taskboard/releases): published packages when available.
- [GitHub Issues](https://github.com/edwardgushchin/AI-Taskboard/issues): bugs and feature requests. Include reproduction steps and remove private data from logs and screenshots.
