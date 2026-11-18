import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { TaskboardError } from "./model.ts";

const execute = promisify(execFile);
const host = "github.com";

function githubExecutable(project: string) {
  const name = process.platform === "win32" ? "gh.exe" : "gh";
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory)) continue;
    try {
      const file = realpathSync(join(directory, name));
      // A project must not be able to replace the GitHub CLI used by the host process.
      const path = relative(project, file);
      if (path === ".." || path.startsWith(".." + sep) || isAbsolute(path)) {
        if (statSync(file).isFile()) return file;
      }
    } catch { /* This PATH entry does not provide gh. */ }
  }
  throw new TaskboardError("GITHUB_CLI_MISSING", "Install GitHub CLI (gh) on the host and make it available on PATH.");
}

function githubCli(project: string) {
  const file = githubExecutable(project);
  const cwd = homedir();
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
  if (env.GH_CONFIG_DIR) env.GH_CONFIG_DIR = resolve(cwd, env.GH_CONFIG_DIR);
  delete env.GH_DEBUG;
  delete env.GH_FORCE_TTY;
  const call = (args: string[]) => execute(file, args, {
    cwd, env, windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  });
  return { call, env };
}

export function githubApi(project: string) {
  return githubRequests(project).request;
}

export function githubRequests(project: string) {
  const { call, env } = githubCli(project);
  const identityEndpoint = "user";

  function request(endpoint: string, flags: string[] = [], failureCode = "GITHUB_READ_FAILED"): Promise<unknown> {
    return read(["api", "--hostname", host, ...flags, endpoint], JSON.parse, failureCode, endpoint === identityEndpoint);
  }

  async function read<T>(args: string[], parse: (stdout: string) => T, failureCode: string, identity = false): Promise<T> {
    try {
      const { stdout } = await call(args);
      return parse(stdout);
    } catch (error) {
      // Command output can contain account data and URLs. Return only known error categories.
      const failure = error as { code?: string; stdout?: string; stderr?: string; killed?: boolean };
      const message = (failure.stderr ?? "") + "\n" + (failure.stdout ?? "");
      const status = /\bHTTP (\d{3})\b/.exec(failure.stderr ?? "")?.[1];
      if (failure.code === "ENOENT") throw new TaskboardError("GITHUB_CLI_MISSING", "GitHub CLI (gh) is unavailable on the host.");
      if (status === "429" || /rate limit|secondary rate/i.test(message)) {
        throw new TaskboardError("GITHUB_RATE_LIMIT", "GitHub's API rate limit was reached. Retry after the rate limit resets.");
      }
      if (status === "401" || /gh auth login|authentication required|no.*authentication token/i.test(message)) {
        const override = env.GH_TOKEN ? "GH_TOKEN" : env.GITHUB_TOKEN ? "GITHUB_TOKEN" : undefined;
        if (override) {
          throw new TaskboardError("GITHUB_AUTH_OVERRIDE", override + " overrides the saved GitHub login and was rejected by GitHub.");
        }
        if (/credential (?:manager|storage)|keyring|keychain|logon session/i.test(message)) {
          throw new TaskboardError("GITHUB_AUTH_STORAGE", "GitHub CLI cannot read the host credential store for its saved login.");
        }
        const saved = await call(["auth", "status", "--hostname", host, "--active", "--json", "hosts", "--jq",
          '[.hosts["github.com"][]? | {configured: ((.login // "") != ""), tokenSource}]'])
          .then(({ stdout }) => JSON.parse(stdout)[0] as { configured?: boolean; tokenSource?: string } | undefined)
          .catch(() => undefined);
        const hasCredentialSource = Boolean(saved?.tokenSource && saved.tokenSource !== "default");
        if (saved?.configured && !hasCredentialSource) {
          throw new TaskboardError("GITHUB_AUTH_STORAGE", "GitHub CLI has a configured account but no accessible saved credential in the host profile.");
        }
        if (hasCredentialSource || (status === "401" && !saved && !/gh auth login/i.test(message))) {
          throw new TaskboardError("GITHUB_AUTH_REJECTED", "GitHub rejected the current host credential. Check whether the saved credential has expired or been revoked.");
        }
        throw new TaskboardError("GITHUB_AUTH_REQUIRED", env.GH_CONFIG_DIR
          ? "GitHub CLI has no usable login in the configured GH_CONFIG_DIR."
          : "GitHub CLI has no usable login in the host profile.");
      }
      if (status === "403" && /scope|resource not accessible|saml|single.sign.on|\bsso\b/i.test(message)) {
        throw new TaskboardError("GITHUB_AUTH_SCOPE", "GitHub denied the request because of credential permissions or organization authorization.");
      }
      if (status === "404" && !identity) {
        await request(identityEndpoint);
        throw new TaskboardError("GITHUB_RESOURCE_ACCESS", "The GitHub login works, but the requested resource is missing or is not accessible to that account.");
      }
      if (status === "403") throw new TaskboardError("GITHUB_RESOURCE_ACCESS", "GitHub denied access to the requested resource.");
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new TaskboardError(failureCode, "GitHub CLI returned more data than the board can read.");
      }
      throw new TaskboardError(failureCode, failure.killed
        ? "GitHub CLI did not finish in time."
        : "GitHub CLI could not complete the request. Check the host's connection to GitHub.");
    }
  }

  return {
    request,
    deleteMilestone: (endpoint: string) => read(
      ["api", "--hostname", host, "--method", "DELETE", "--include", endpoint],
      stdout => {
        if (!/^HTTP\/\S+ 204(?:\s|$)/.test(stdout)) throw new Error("Expected HTTP 204");
      }, "GITHUB_MILESTONE_DELETE_FAILED"),
    failedLog: (repository: string, runId: number) => read(
      ["run", "view", String(runId), "--repo", host + "/" + repository, "--log-failed"],
      stdout => stdout, "GITHUB_RUN_LOG_FAILED"),
  };
}
