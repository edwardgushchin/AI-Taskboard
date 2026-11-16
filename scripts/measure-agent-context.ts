// Reproduce the manager assembly from main.ts without launching Electron or a model.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as model from "../src/cli/model.ts";
import { taskFields } from "../src/desktop/chat-actions.ts";
import { russianWriting } from "../src/desktop/russian-writing.ts";
import { boardAgentInstructions } from "../src/desktop/board-agent-hooks.ts";
import { recordSettings, settingsContext } from "../src/cli/settings-notices.ts";
import { checkWaitInstructions } from "../src/desktop/check-wait.ts";
import { managerCliContext } from "../src/desktop/manager-cli.ts";
import { readOnlyGitOptions } from "../src/cli/repository.ts";
import { githubReadTool } from "../src/desktop/github-read.ts";

const baseline = process.argv[2] ?? "91ebf597d98532c9cf26da9e80e4828f019428cf";
const variant = process.argv[3] ?? "fallback";
if (!["fallback", "git", "git+gh"].includes(variant)) throw new Error("Use fallback, git, or git+gh.");
const availability = variant === "fallback" ? {} : {
  gitOptions: [...readOnlyGitOptions, "-c", "filter.lfs.clean=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false"],
  ...(variant === "git+gh" ? { github: "fixture-owner/fixture-repo" } : {}),
};
const read = (path: string, before: boolean) => before
  ? execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" })
  : readFileSync(new URL("../" + path, import.meta.url), "utf8");
const results = [];
for (const before of [true, false]) {
  const board = stripTypeScriptTypes(read("src/desktop/board-actions.ts", before)
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""));
  const main = read("src/desktop/main.ts", before);
  const ast = ts.createSourceFile("main.ts", main, ts.ScriptTarget.Latest, true);
  const goals = ast.statements.map(node => node.getText(ast))
    .filter(text => /^const goal(Chat|Work)Tools =/.test(text)).join("\n");
  const assembly = main.slice(main.indexOf("    const instructions = reviewIds ?"),
    main.indexOf("    const attachments = await prepareBoardAttachments", main.indexOf("    const instructions = reviewIds ?")));
  for (const reviewMode of ["human", "manager", "reviewer"] as const) {
    for (const role of ["dialogue", "goal", "automatic"] as const) {
      const settings = settingsContext(recordSettings({ reviewMode }));
      const measured = runInNewContext(board + "\n" + stripTypeScriptTypes(goals + assembly) +
        "\n({ instructions, tools: [...(reviewIds ? [] : boardTools), ...mcpTools] })", {
        ...model, taskFields, russianWriting, githubReadTool, reviewMode, managerReviews: reviewMode === "manager",
        reviewIds: role === "automatic" ? ["T-0001"] : undefined, goal: role === "goal",
      });
      const context = before || role === "automatic" ? undefined : managerCliContext(measured.tools, availability);
      const tools = context?.tools ?? measured.tools;
      const base = boardAgentInstructions("manager", measured.instructions + "\n" + settings,
        { dialogue: role === "dialogue" });
      const instructions = context?.instructions ? base + "\n\n" + context.instructions : base;
      results.push({ version: before ? baseline : "working-tree", role, reviewMode,
        schemas: tools.length + 1, // Worklog is appended by replyToBoard.
        characters: instructions.length, utf8Bytes: Buffer.byteLength(instructions),
        names: [...tools.map((tool: { name: string }) => tool.name), "worklog_record"] });
    }
  }
}
// Evaluate the independent reviewer's and executor's instruction expressions.
const chat = read("src/desktop/codex-chat.ts", false);
const reviewerStart = chat.indexOf('boardAgentInstructions("reviewer", [');
const reviewerEnd = chat.indexOf('].join(" "))', reviewerStart) + '].join(" "))'.length;
const reviewer = runInNewContext(chat.slice(reviewerStart, reviewerEnd), { boardAgentInstructions });
const run = read("src/desktop/codex-run.ts", false);
const runAst = ts.createSourceFile("codex-run.ts", run, ts.ScriptTarget.Latest, true);
const executorFunction = runAst.statements.find(node => /^function executorInstructions\(/.test(node.getText(runAst)))!.getText(runAst);
const executor = runInNewContext(stripTypeScriptTypes(executorFunction) + "\nexecutorInstructions()", {
  readFileSync, URL, instructions: new URL("../src/desktop/agent-instructions/", import.meta.url),
  boardAgentInstructions, checkWaitInstructions, bundled: false,
  entry: new URL("../src/cli/main.ts", import.meta.url).pathname,
  taskboardCliLaunch: () => [process.execPath, "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("../src/cli/main.ts", import.meta.url))],
});
for (const before of [true, false]) {
  const definitions = /openBoardMcp\(\[([^\]]+)\]/.exec(before ? read("src/desktop/codex-run.ts", true) : run);
  if (!definitions) throw new Error("Could not find the executor's MCP tools.");
  const executorSchemas = definitions[1]!.split(",").length;
  for (const [role, instructions, schemas] of [["reviewer", reviewer, 5], ["executor", executor, executorSchemas]] as const) {
    results.push({ version: before ? baseline : "working-tree", role, reviewMode: "n/a", schemas,
      characters: instructions.length, utf8Bytes: Buffer.byteLength(instructions), names: [] });
  }
}
console.log(JSON.stringify({ method: "UTF-16 code units and UTF-8 bytes; main.ts assembly + default settingsContext + boardAgentInstructions + verified-tool variant; no settings history; no token estimate; provider builtins/apps excluded", variant, results }, null, 2));
