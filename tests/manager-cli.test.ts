import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git, invokeGit } from "../src/cli/git.ts";
import { managerCliContext, probeManagerCli } from "../src/desktop/manager-cli.ts";

test("manager replaces only verified shell tools and invalidates cached Git configuration", async t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-manager-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = join(root, "plain");
  const linked = join(root, "linked");
  git(root, ["init", "-b", "main", project]);
  git(project, ["config", "maintenance.auto", "false"]);
  git(project, ["config", "filter.audit.clean", "this-command-must-not-run"]);
  git(project, ["config", "filter.audit.required", "true"]);
  git(project, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
  git(project, ["remote", "add", "origin", "https://github.com/test-owner/test-repo.git"]);
  git(project, ["worktree", "add", "-b", "linked", linked]);
  for (const path of [project, linked]) {
    writeFileSync(join(path, "sample.txt"), "staged\n");
    git(path, ["add", "--", "sample.txt"]);
    writeFileSync(join(path, ".gitattributes"), "sample.txt filter=audit\n");
    writeFileSync(join(path, "sample.txt"), "modified\n");
  }
  const tools = ["project_git", "project_git_push", "task_review_diff", "milestones_list", "task_set_milestone", "github_set_milestone_due"]
    .map(name => ({ name, description: "", inputSchema: {} }));
  const calls: string[][] = [];
  const run = async (cwd: string, [file, ...args]: string[], env?: Record<string, string>) => {
    calls.push([file, ...args]);
    if (file === "gh") {
      const identity = args.includes("user");
      if (!identity) assert.ok(args.includes("repos/test-owner/test-repo/milestones?state=all&per_page=100"));
      return { exitCode: 0, stdout: identity ? "User\n" : "[[],[]]" };
    }
    assert.equal(env?.GIT_NO_LAZY_FETCH, "1");
    const result = invokeGit(cwd, args, env);
    return { exitCode: result.code, stdout: result.stdout };
  };
  const native = await probeManagerCli(project, "elevated", tools, run);
  assert.ok(native.gitOptions?.includes("filter.audit.clean="));
  assert.equal(native.github, "test-owner/test-repo");
  const available = managerCliContext(tools, native);
  assert.deepEqual(available.tools.map(tool => tool.name), ["project_git_push", "task_review_diff", "task_set_milestone", "github_set_milestone_due"]);
  assert.match(available.instructions, /--no-ext-diff --no-textconv/);
  assert.match(available.instructions, /gh api --hostname github.com --paginate --slurp/);
  assert.ok(calls.some(command => command.includes("--cached")));
  const cachedCount = calls.length;
  assert.deepEqual(await probeManagerCli(project, "elevated", tools, run), native);
  assert.equal(calls.length, cachedCount);
  assert.ok((await probeManagerCli(linked, "elevated", tools, run)).gitOptions);
  assert.ok(calls.length > cachedCount);
  git(project, ["config", "filter.second.clean", "another-command-must-not-run"]);
  assert.ok((await probeManagerCli(project, "elevated", tools, run)).gitOptions?.includes("filter.second.clean="));

  let soughtMilestones = false;
  const fallback = await probeManagerCli(project, "mxc", tools, async (cwd, command, env) => {
    if (command[0] === "gh") {
      soughtMilestones ||= !command.includes("user");
      return { exitCode: 1, stdout: "" };
    }
    if (command.includes("status")) throw new Error("Git worktree unavailable");
    return run(cwd, command, env);
  });
  assert.equal(soughtMilestones, false);
  assert.deepEqual(managerCliContext(tools, fallback).tools, tools);
  assert.match(managerCliContext(tools, fallback).instructions, /Use project_git/);
});
