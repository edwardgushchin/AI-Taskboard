import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { RuntimeEntry } from "../src/desktop/board-runtime.ts";
import { ApplicationUpdates, manifestChecksum, prepareWindowsUpdate } from "../src/desktop/installation-updates.ts";
import { releasesUrl } from "../src/desktop/updates.ts";

const version = "0.1.1-alpha";
const candidate = { version, tag: `v${version}`, url: `${releasesUrl}/tag/v${version}`, prerelease: true };
const name = `ai-taskboard-${version}-windows-x64.exe`;
const bytes = Buffer.from("MZ test NSIS fixture");
const digest = createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
const updateDirectories = async () => (await readdir(tmpdir())).filter(name => name.startsWith("ai-taskboard-update-")).sort();

test("manifest requires one exact version/architecture entry and validates the full line", () => {
  assert.equal(manifestChecksum(`${digest.toUpperCase()}  ${name}\r\n`, name), digest);
  for (const manifest of ["", `${digest}  other.exe`, `${digest}  ../${name}`, `${digest}  ${name}\n${digest}  ${name}`,
    `${digest}junk  ${name}`, `${digest}  ${name}\njunk`, `${digest} *${name}`, ` ${digest}  ${name}`]) {
    assert.throws(() => manifestChecksum(manifest, name));
  }
});

test("download accepts only constructed official assets and cleans successful preparation on cancellation", async context => {
  const before = await updateDirectories();
  for (const arch of ["x64", "arm64"]) {
    const asset = `ai-taskboard-${version}-windows-${arch}.exe`;
    const urls: string[] = [];
    context.mock.method(globalThis, "fetch", async (url: string) => {
      urls.push(url);
      return url.endsWith("SHA256SUMS") ? new Response(`${digest}  ${asset}\n`) : new Response(bytes);
    });
    const prepared = await prepareWindowsUpdate(candidate, signal(), {
      arch, executable: "C:\\App with spaces\\AI Taskboard.exe", profile: "C:\\Profile with spaces", args: [], relaunch: () => {},
    });
    assert.deepEqual(urls, [`${releasesUrl}/download/v${version}/SHA256SUMS`, `${releasesUrl}/download/v${version}/${asset}`]);
    await prepared.cancel();
    context.mock.restoreAll();
  }
  assert.deepEqual(await updateDirectories(), before);
});

test("corrupt, wrong-architecture, network and cancellation failures never prepare an installer", async context => {
  const before = await updateDirectories();
  for (const mode of ["corrupt", "wrong-arch", "http", "network", "abort", "not-exe"]) {
    const controller = new AbortController();
    context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      if (mode === "network") {
        throw new TypeError("Offline");
      }
      if (mode === "http") {
        return new Response("", { status: 503 });
      }
      if (mode === "abort") {
        controller.abort();
        options.signal?.throwIfAborted();
      }
      const body = mode === "not-exe" ? Buffer.from("not executable") : bytes;
      const hash = createHash("sha256").update(body).digest("hex");
      if (url.endsWith("SHA256SUMS")) {
        return new Response(`${hash}  ${mode === "wrong-arch" ? name.replace("x64", "arm64") : name}\n`);
      }
      return new Response(mode === "corrupt" ? Buffer.from("MZ corrupted") : body);
    });
    await assert.rejects(prepareWindowsUpdate(candidate, controller.signal, {
      arch: "x64", executable: "C:\\App\\app.exe", profile: "C:\\Profile", args: [], relaunch: () => {},
    }));
    context.mock.restoreAll();
  }
  await assert.rejects(prepareWindowsUpdate(candidate, signal(), {
    arch: "ia32", executable: "", profile: "", args: [], relaunch: () => {},
  }), /architecture/);
  assert.deepEqual(await updateDirectories(), before);
});

test("manager binds exact found version, cancels, retries and prevents concurrent installations", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json([{ tag_name: candidate.tag }]));
  let allow = false;
  let busy = false;
  let preparations = 0;
  let cancellations = 0;
  let release: (() => void) | undefined;
  const service = new ApplicationUpdates({
    version: () => "0.1.0-alpha", supported: () => true, busy: () => busy,
    confirm: async () => allow,
    prepare: async () => {
      preparations++;
      if (release) {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      return {
        start: async () => {},
        cancel: async () => {
          cancellations++;
        },
      };
    },
  });
  const code = (result: Awaited<ReturnType<typeof service.install>>) => result.ok ? "ok" : result.error.code;
  assert.equal(code(await service.install(version, signal())), "UPDATE_CHECK_REQUIRED");
  assert.equal((await service.check()).ok, true);
  for (const invalid of ["v0.1.1-alpha", "0.1.1-alpha ", "0.1.2-alpha", "0.1.1-alpha;cmd", 1, null]) {
    assert.equal(code(await service.install(invalid, signal())), "UPDATE_CHECK_REQUIRED");
  }
  assert.equal(code(await service.install(version, signal())), "UPDATE_CANCELLED");
  assert.equal(preparations, 0);
  allow = true;
  busy = true;
  assert.equal(code(await service.install(version, signal())), "UPDATE_APP_BUSY");
  busy = false;
  release = () => {};
  const first = service.install(version, signal());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(code(await service.install(version, signal())), "UPDATE_IN_PROGRESS");
  release!();
  assert.equal(code(await first), "ok");
  assert.equal(preparations, 1);
  assert.equal(code(await service.install(version, signal())), "UPDATE_IN_PROGRESS");
  await service.cancel();
  assert.equal(cancellations, 1);
  assert.equal(service.installing, false);
});

test("busy-after-download is cleaned; failed checks revoke the remembered version", async context => {
  let offline = false;
  context.mock.method(globalThis, "fetch", async () => {
    if (offline) {
      throw new TypeError("Offline");
    }
    return Response.json([{ tag_name: candidate.tag }]);
  });
  let busy = false;
  let cancelled = 0;
  const service = new ApplicationUpdates({
    version: () => "0.1.0-alpha", supported: () => true, busy: () => busy, confirm: async () => true,
    prepare: async () => {
      busy = true;
      return {
        start: async () => {},
        cancel: async () => {
          cancelled++;
        },
      };
    },
  });
  await service.check();
  const result = await service.install(version, signal());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "UPDATE_APP_BUSY");
  }
  assert.equal(cancelled, 1);
  assert.equal(service.installing, false);
  busy = false;
  offline = true;
  assert.equal((await service.check()).ok, false);
  const retry = await service.install(version, signal());
  if (!retry.ok) {
    assert.equal(retry.error.code, "UPDATE_CHECK_REQUIRED");
  } else {
    assert.fail("A failed check must revoke the candidate");
  }
});

test("cancellation after preparation removes the package and permits a fresh attempt", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json([{ tag_name: candidate.tag }]));
  const controller = new AbortController();
  let abort = true;
  let cancelled = 0;
  const service = new ApplicationUpdates({
    version: () => "0.1.0-alpha", supported: () => true, busy: () => false, confirm: async () => true,
    prepare: async () => {
      if (abort) {
        controller.abort();
      }
      return {
        start: async () => {},
        cancel: async () => {
          cancelled++;
        },
      };
    },
  });
  await service.check();
  const result = await service.install(version, controller.signal);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "UPDATE_CANCELLED");
  }
  assert.equal(cancelled, 1);
  assert.equal(service.installing, false);
  abort = false;
  assert.equal((await service.install(version, signal())).ok, true);
  await service.cancel();
  assert.equal(cancelled, 2);
});

test("the actual shutdown busy check excludes only the current manager's context and descendant leases", () => {
  const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function updateBusy()");
  const end = source.indexOf("\nconst applicationUpdates", start);
  assert.ok(start >= 0 && end > start);
  const operation = {};
  const entries: RuntimeEntry[] = [
    { id: "context", owner: process.pid, kind: "task", task: "manager:dialogue" },
    { id: "provider", owner: process.pid, kind: "provider", parent: "context" },
    { id: "turn", owner: process.pid, kind: "turn", parent: "provider", role: "manager" },
    { id: "defaults", owner: 0, kind: "defaults" },
    { id: "queue", owner: 0, kind: "queue", task: "T-0001" },
  ];
  const operations = new Set([operation]);
  const sandbox = {
    process, projectOperations: new Map([["board", operations]]), updateOwner: operation as object | undefined, updateProject: "board",
    subscriptions: new Map([["board", {}]]), agentSlots: { entries: () => entries },
  };
  const busy: () => boolean = runInNewContext(source.slice(start, end) + "\nupdateBusy", sandbox);
  assert.equal(busy(), false);
  entries.push({ id: "goal", owner: process.pid, kind: "task", task: "manager:context" });
  assert.equal(busy(), true);
  entries.pop();
  operations.add({});
  assert.equal(busy(), true);
  operations.clear();
  entries.push({ id: "executor", owner: process.pid, kind: "slot", task: "T-0001", role: "executor" });
  assert.equal(busy(), true);
  entries.pop();
  entries.push({ id: "foreign", owner: -1, kind: "provider", parent: "context" });
  assert.equal(busy(), true);
  entries.pop();
  entries.push({ id: "orphan", owner: process.pid, kind: "turn", parent: "missing" });
  assert.equal(busy(), true);
  entries.pop();
  sandbox.updateOwner = undefined;
  assert.equal(busy(), true);
});

test("unsupported installations return the official manual path without downloading", async () => {
  const service = new ApplicationUpdates({
    version: () => "0.1.0-alpha", supported: () => false, busy: () => false,
    confirm: async () => { throw new Error("Must not prompt"); },
    prepare: async () => { throw new Error("Must not download"); },
  });
  const result = await service.install(version, signal());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "UPDATE_MANUAL_REQUIRED");
    assert.ok(result.error.message.includes(releasesUrl));
  }
});

test("a vetoed quit discards the prepared update, including an overlapping window close", async context => {
  const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("  let quitPending = false;");
  const end = source.indexOf('  app.on("window-all-closed"', start);
  assert.ok(start >= 0 && end > start);

  context.mock.method(globalThis, "fetch", async () => Response.json([{ tag_name: candidate.tag }]));
  for (const scenario of ["window closing", "confirmation declined", "busy", "session failed", "launch failed", "success"]) {
    let cleaned = 0;
    let launched = 0;
    let quits = 0;
    let confirmCalls = 0;
    const applicationUpdates = new ApplicationUpdates({
      version: () => "0.1.0-alpha",
      supported: () => true,
      busy: () => false,
      confirm: async () => true,
      prepare: async () => ({
        start: async () => {
          if (scenario === "launch failed") {
            throw new Error("Relaunch unavailable");
          }
          launched++;
        },
        cancel: async () => {
          cleaned++;
        },
      }),
    });
    await applicationUpdates.check();
    assert.equal((await applicationUpdates.install(version, signal())).ok, true);
    let beforeQuit: (() => void) | undefined;
    runInNewContext(source.slice(start, end), {
      app: {
        on(name: string, handler: (event: { preventDefault(): void }) => void) {
          assert.equal(name, "before-quit");
          beforeQuit = () => handler({ preventDefault() {} });
        },
        quit() {
          quits++;
        },
      },
      applicationUpdates,
      windowStates: new Map([[1, { closing: scenario === "window closing", tabs: [] }]]),
      quitting: false,
      updateBusy: () => scenario === "busy",
      confirmProjectClose: async () => {
        confirmCalls++;
        return scenario !== "confirmation declined";
      },
      saveSession: () => scenario !== "session failed",
      dialog: { showMessageBox: async () => {} },
    });
    assert.ok(beforeQuit);
    beforeQuit();
    await new Promise(resolve => setImmediate(resolve));

    if (scenario === "success") {
      assert.equal(quits, 1);
      assert.equal(launched, 1);
      assert.equal(cleaned, 0);
      continue;
    }
    assert.equal(quits, 0, scenario);
    assert.equal(launched, 0, scenario);
    assert.equal(cleaned, 1, scenario);
    assert.equal(applicationUpdates.prepared, undefined, scenario);
    assert.equal(applicationUpdates.installing, false, scenario);
    if (scenario === "window closing") {
      assert.equal(confirmCalls, 0);
    }
    assert.equal((await applicationUpdates.install(version, signal())).ok, true, scenario);
    await applicationUpdates.cancel();
  }
});
