import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { isRuntimeRecord, type RuntimeEntry } from "../src/desktop/board-runtime.ts";
import { ApplicationUpdates, manifestChecksum, prepareWindowsUpdate } from "../src/desktop/installation-updates.ts";
import { releasesUrl } from "../src/desktop/updates.ts";

const version = "0.1.1-alpha";
const candidate = { version, tag: `v${version}`, url: `${releasesUrl}/tag/v${version}`, prerelease: true, notes: "" };
const name = `ai-taskboard-${version}-windows-x64.exe`;
const bytes = Buffer.from("MZ test NSIS fixture");
const digest = createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
const updateDirectories = async () => (await readdir(tmpdir())).filter(name => name.startsWith("ai-taskboard-update-")).sort();

test("background checks refresh the offer and preserve the active package through confirmation", async context => {
  const current = "0.1.0-alpha";
  const newer = "0.1.2-alpha";
  let next = version;
  let offline = false;
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests++;
    if (offline) throw new TypeError("Offline");
    return Response.json([
      { tag_name: next, body: next === version ? "Selected notes" : "Other notes" },
    ]);
  });
  let downloads = 0;
  let discarded = 0;
  let started = 0;
  let downloadSignal: AbortSignal | undefined;
  const verified = Promise.withResolvers<void>();
  const service = new ApplicationUpdates({
    version: () => current,
    supported: () => true,
    busy: () => false,
    confirm: async () => true,
    prepare: async (release, signal, progress) => {
      assert.equal(release.version, version);
      downloads++;
      downloadSignal = signal;
      progress?.({ received: 1, total: 4 });
      signal.addEventListener("abort", () => verified.resolve(), { once: true });
      await verified.promise;
      return {
        start: async () => { started++; },
        cancel: async () => { discarded++; },
      };
    },
  });
  assert.equal((await Promise.all([service.check(true), service.check()])).every(reply => reply.ok), true);
  assert.equal(requests, 1);
  assert.equal(service.state.candidate?.notes, "Selected notes");
  const download = service.download(version);
  assert.equal(service.state.phase, "downloading");
  assert.deepEqual(service.state.progress, { received: 1, total: 4 });
  assert.equal(service.download(version), undefined);
  for (const offer of [newer, current]) {
    next = offer;
    assert.equal((await service.check(true)).ok, true);
    assert.equal(service.state.available?.version ?? null, offer === current ? null : offer);
    assert.equal(service.state.candidate?.version, version);
    assert.equal(service.state.phase, "downloading");
    assert.deepEqual(service.state.progress, { received: 1, total: 4 });
    assert.equal(downloadSignal?.aborted, false);
    assert.equal(service.download(newer), undefined);
  }
  verified.resolve();
  await download;
  assert.equal(downloads, 1);
  assert.equal(service.state.phase, "ready");
  assert.equal(service.installing, false);

  offline = true;
  assert.equal((await service.check(true)).ok, false);
  assert.equal(service.state.phase, "ready");
  offline = false;
  for (const offer of [newer, current]) {
    next = offer;
    assert.equal((await service.check(true)).ok, true);
    assert.equal(service.state.available?.version ?? null, offer === current ? null : offer);
    assert.equal(service.state.candidate?.version, version);
    assert.equal(service.state.candidate?.notes, "Selected notes");
    assert.equal(service.state.phase, "ready");
    assert.equal(downloadSignal?.aborted, false);
    assert.equal(service.confirmDownload(newer), false);
  }
  assert.equal(discarded, 0);
  assert.equal(started, 0);
  assert.equal(service.confirmDownload(version), true);
  assert.equal(service.state.phase, "installing");
  assert.ok(service.prepared);
  await service.prepared.start();
  assert.equal(started, 1);
});

test("a failed transfer can be retried for the same version and discarded to reveal the latest offer", async context => {
  const newer = "0.1.2-alpha";
  let next = version;
  let discarded = false;
  const attempts: string[] = [];
  context.mock.method(globalThis, "fetch", async () => Response.json([{ tag_name: next }]));
  const service = new ApplicationUpdates({
    version: () => "0.1.0-alpha",
    supported: () => true,
    busy: () => false,
    confirm: async () => true,
    prepare: async release => {
      attempts.push(release.version);
      if (attempts.length === 1) throw new Error("Network error");
      return {
        start: async () => { assert.fail("Discarding the package must not start the installer"); },
        cancel: async () => { discarded = true; },
      };
    },
  });
  await service.check(true);
  await service.download(version);
  assert.equal(service.state.phase, "error");
  next = newer;
  await service.check(true);
  assert.equal(service.state.available?.version, newer);
  assert.equal(service.state.candidate?.version, version);
  assert.equal(service.download(newer), undefined);
  await service.download(version);
  assert.deepEqual(attempts, [version, version]);
  assert.equal(service.state.phase, "ready");
  await service.discardDownload();
  assert.equal(discarded, true);
  assert.equal(service.state.phase, "available");
  assert.equal(service.state.candidate?.version, newer);
});

test("a busy installer keeps its cleanup handle without allowing installation or another download", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json([{ tag_name: candidate.tag }]));
  const firstRemoval = Promise.withResolvers<void>();
  let removals = 0;
  const service = new ApplicationUpdates({
    version: () => "0.1.0-alpha",
    supported: () => true,
    busy: () => false,
    confirm: async () => true,
    prepare: async () => ({
      start: async () => { assert.fail("The installer must not run after cleanup starts"); },
      cancel: async () => {
        removals++;
        if (removals === 1) await firstRemoval.promise;
      },
    }),
  });
  await service.check();
  await service.download(version);
  const removal = service.discardDownload();
  const sameRemoval = service.discardDownload();
  assert.equal(removal, sameRemoval);
  assert.equal(service.state.phase, "discarding");
  assert.equal(service.confirmDownload(version), false);
  firstRemoval.reject(new Error("EBUSY: installer is locked"));
  await assert.rejects(removal, /EBUSY/);
  assert.equal(removals, 1);
  assert.equal(service.state.phase, "cleanup-error");
  assert.equal(service.state.candidate?.version, version);
  assert.match(service.state.error ?? "", /EBUSY/);
  assert.equal(service.confirmDownload(version), false);
  assert.equal(service.download(version), undefined);
  assert.equal((await service.install(version, signal())).ok, false);
  await service.discardDownload();
  assert.equal(removals, 2);
  assert.equal(service.state.phase, "available");
});

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

test("download reports a total only for a valid decimal Content-Length", async context => {
  for (const [header, total] of [[String(bytes.length), bytes.length], ["1e3", undefined], ["12abc", undefined]] as const) {
    context.mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("SHA256SUMS")) return new Response(`${digest}  ${name}\n`);
      return new Response(bytes, { headers: { "Content-Length": header } });
    });
    const values: Array<{ received: number; total?: number }> = [];
    const prepared = await prepareWindowsUpdate(candidate, signal(), {
      arch: "x64",
      executable: "C:\\App\\AI Taskboard.exe",
      profile: "C:\\Profile",
      args: [],
      relaunch: () => {},
      progress: value => values.push(value),
    });
    try {
      assert.deepEqual(values[0], { received: 0, total });
      assert.deepEqual(values.at(-1), { received: bytes.length, total });
    } finally {
      await prepared.cancel();
    }
  }
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

test("shutdown ignores passive records and only the installing manager's own leases", () => {
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
    { id: "release", owner: 0, kind: "executor-release", releasedAt: Date.now() },
    { id: "retry", owner: 0, kind: "review-retry", task: "T-0002" },
  ];
  const operations = new Set([operation]);
  const sandbox = {
    process,
    projectOperations: new Map([["board", operations]]),
    updateOwner: operation as object | undefined,
    updateProject: "board",
    subscriptions: new Map([["board", {}]]),
    agentSlots: { entries: () => entries },
    isRuntimeRecord,
  };
  const busy: () => boolean = runInNewContext(source.slice(start, end) + "\nupdateBusy", sandbox);
  assert.equal(busy(), false);
  entries.push({ id: "goal", owner: process.pid, kind: "task", task: "manager:context" });
  assert.equal(busy(), true);
  entries.pop();
  operations.add({});
  assert.equal(busy(), true);
  operations.clear();
  const activeEntries: RuntimeEntry[] = [
    { id: "executor", owner: process.pid, kind: "slot", task: "T-0001", role: "executor" },
    { id: "reviewer", owner: process.pid, kind: "slot", task: "review:T-0002", role: "reviewer" },
    { id: "writer", owner: process.pid, kind: "task", task: "T-0003" },
  ];
  for (const entry of activeEntries) {
    entries.push(entry);
    assert.equal(busy(), true, entry.id);
    entries.pop();
    assert.equal(busy(), false, entry.id);
  }
  entries.push({ id: "foreign", owner: -1, kind: "provider", parent: "context" });
  assert.equal(busy(), true);
  entries.pop();
  entries.push({ id: "orphan", owner: process.pid, kind: "turn", parent: "missing" });
  assert.equal(busy(), true);
  entries.pop();
  sandbox.updateOwner = undefined;
  assert.equal(busy(), true);
  entries.splice(0, 3);
  assert.equal(busy(), false);
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

test("quit can retry a locked package and handles vetoes of a confirmed installation", async context => {
  const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  const start = source.indexOf('  app.on("before-quit"');
  const end = source.indexOf('  app.on("window-all-closed"', start);
  assert.ok(start >= 0 && end > start);

  context.mock.method(globalThis, "fetch", async () => Response.json([{ tag_name: candidate.tag }]));
  const scenarios = [
    "locked installer", "window closing", "confirmation declined", "busy", "busy after close confirmation",
    "session failed", "launch failed", "success",
  ];
  for (const scenario of scenarios) {
    let cleaned = 0;
    let launched = 0;
    let quits = 0;
    let confirmCalls = 0;
    const messages: string[] = [];
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
          if (scenario === "locked installer" && cleaned === 1) throw new Error("EBUSY");
        },
      }),
    });
    await applicationUpdates.check();
    if (scenario === "locked installer") {
      await applicationUpdates.download(version);
    } else {
      assert.equal((await applicationUpdates.install(version, signal())).ok, true);
    }
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
      quitPending: false,
      updateBusy: () => scenario === "busy" || (scenario === "busy after close confirmation" && confirmCalls > 0),
      confirmProjectClose: async () => {
        confirmCalls++;
        return scenario !== "confirmation declined";
      },
      saveSession: () => scenario !== "session failed",
      t: (key: string, { reason }: { reason: string }) => key + ": " + reason,
      dialog: {
        showMessageBox: async ({ message }: { message: string }) => { messages.push(message); },
      },
    });
    assert.ok(beforeQuit);
    beforeQuit();
    await new Promise(resolve => setImmediate(resolve));

    if (scenario === "locked installer") {
      assert.equal(quits, 0);
      assert.equal(cleaned, 1);
      assert.equal(applicationUpdates.state.phase, "cleanup-error");
      assert.deepEqual(messages, ["updates.cleanup_failed: Error: EBUSY"]);
      beforeQuit();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(quits, 1);
      assert.equal(cleaned, 2);
      assert.equal(launched, 0);
      assert.equal(applicationUpdates.state.phase, "available");
      continue;
    }
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
