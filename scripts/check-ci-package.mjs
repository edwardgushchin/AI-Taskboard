import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, globSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync,
  readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [arch, directory, profileOption] = process.argv.slice(2);
assert.ok(profileOption === undefined || profileOption === "--release");
const signedRelease = profileOption === "--release";
assert.match(arch ?? "", /^(x64|arm64)$/);
assert.equal(process.arch, arch);
const windows = process.platform === "win32";
const mac = process.platform === "darwin";
const os = windows ? "windows" : mac ? "macos" : "linux";
const output = resolve(directory ?? "ci-results");
const { version } = JSON.parse(readFileSync("package.json"));
const name = `ai-taskboard-${version}-${os}-${arch}`;
const release = resolve("release");
const unpacked = readdirSync(release).filter(entry => mac
  ? ["mac", "mac-arm64"].includes(entry)
  : new RegExp(`^${windows ? "win" : "linux"}(-arm64)?-unpacked$`).test(entry));
assert.equal(unpacked.length, 1, `Expected one unpacked application, got: ${unpacked}`);
const bundle = mac ? join(release, unpacked[0], "AI Taskboard.app", "Contents") : join(release, unpacked[0]);
const resources = join(bundle, mac ? "Resources" : "resources");
const desktop = join(bundle, mac ? "MacOS/AI Taskboard" : windows ? "AI Taskboard.exe" : "ai-taskboard-desktop");
const cli = join(resources, "bin", windows ? "ai-taskboard.exe" : "ai-taskboard");
const builderRequire = createRequire(createRequire(import.meta.url).resolve("app-builder-lib"));
const { extractFile } = builderRequire("@electron/asar");

function checkAppVersion(resourcesPath) {
  const packaged = JSON.parse(extractFile(join(resourcesPath, "app.asar"), "package.json"));
  assert.equal(packaged.version, version, "Packaged Electron version must match package.json");
  return packaged.version;
}

function verifySignature(path) {
  const run = (tool, args, env = process.env) => execFileSync(tool, args, {
    env, encoding: "utf8", timeout: 60_000, windowsHide: true,
  });
  if (windows) {
    const status = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $env:AI_TASKBOARD_SIGNATURE_PATH).Status"],
    { ...process.env, AI_TASKBOARD_SIGNATURE_PATH: path }).trim();
    assert.equal(status, "Valid", "Windows installer Authenticode validation");
    return "Authenticode valid";
  }
  const status = run("pkgutil", ["--check-signature", path]);
  assert.match(status, /Developer ID Installer:/);
  run("xcrun", ["stapler", "validate", path]);
  return "Developer ID Installer signature and notarization ticket valid";
}

function binaryArchitecture(path) {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(64);
  try {
    assert.equal(readSync(fd, header, 0, header.length, 0), header.length);
    if (windows) {
      assert.equal(header.toString("ascii", 0, 2), "MZ");
      const pe = Buffer.alloc(6);
      assert.equal(readSync(fd, pe, 0, pe.length, header.readUInt32LE(60)), pe.length);
      assert.equal(pe.readUInt32LE(), 0x4550);
      return { x64: 0x8664, arm64: 0xaa64 }[arch] === pe.readUInt16LE(4) ? arch : `PE ${pe.readUInt16LE(4)}`;
    }
    if (mac) {
      assert.equal(header.readUInt32LE(), 0xfeedfacf);
      const cpu = header.readUInt32LE(4);
      return { x64: 0x01000007, arm64: 0x0100000c }[arch] === cpu ? arch : `Mach-O ${cpu}`;
    }
    assert.equal(header.readUInt32BE(), 0x7f454c46);
    assert.equal(header[4], 2); // ELF64
    assert.equal(header[5], 1); // little endian
    const machine = header.readUInt16LE(18);
    return { x64: 62, arm64: 183 }[arch] === machine ? arch : `ELF ${machine}`;
  } finally {
    closeSync(fd);
  }
}

function extractResources(packagePath, extension, destination) {
  if (extension !== "pkg") mkdirSync(destination);
  const extract = (tool, args) => execFileSync(tool, args, { stdio: "inherit", timeout: 180_000, windowsHide: true });
  if (extension === "exe") {
    // electron-builder's NSIS template stores one nested archive per architecture.
    const installed = join(process.env.ProgramFiles ?? "C:/Program Files", "7-Zip", "7z.exe");
    const sevenZip = existsSync(installed) ? installed : "7z";
    const archive = `$PLUGINSDIR/app-${arch === "x64" ? "64" : "arm64"}.7z`;
    extract(sevenZip, ["x", "-y", `-o${destination}`, packagePath, archive]);
    extract(sevenZip, ["x", "-y", `-o${destination}`, join(destination, archive),
      "resources/bin/ai-taskboard.exe", "resources/app.asar"]);
    return join(destination, "resources");
  }
  if (extension === "zip") {
    const entry = "AI Taskboard.app/Contents/Resources";
    extract("tar", ["-xf", packagePath, "-C", destination, `${entry}/bin/ai-taskboard`, `${entry}/app.asar`]);
    return join(destination, entry);
  }
  if (extension === "pkg") {
    extract("pkgutil", ["--expand-full", packagePath, destination]);
    const apps = globSync("**/AI Taskboard.app/Contents/Resources/app.asar", { cwd: destination });
    assert.equal(apps.length, 1, "Expected one packaged Electron application");
    return resolve(destination, apps[0], "..");
  }
  if (extension === "deb") extract("dpkg-deb", ["--extract", packagePath, destination]);
  else extract("bsdtar", ["-xf", packagePath, "-C", destination,
    "--include=*/resources/bin/ai-taskboard", "--include=*/resources/app.asar"]);
  return join(destination, "opt/AI Taskboard/resources");
}

function checkCliVersion(path, cwd) {
  const run = args => execFileSync(path, args, { cwd, encoding: "utf8", timeout: 20_000 }).trim();
  assert.equal(run(["--version"]), version);
  assert.deepEqual(JSON.parse(run(["--version", "--json"])), { ok: true, data: { version } });
}

async function devtools(url, method, params) {
  const socket = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Renderer response timed out")), 3000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
      socket.addEventListener("error", () => { clearTimeout(timeout); resolve(false); }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timeout); resolve(false); }, { once: true });
      socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== 1) return;
        clearTimeout(timeout);
        resolve(message.result);
      });
    });
  } finally {
    socket.close();
  }
}

mkdirSync(output, { recursive: true });
const report = { os, arch, version, checks: {} };
const profile = mkdtempSync(join(tmpdir(), "taskboard-ci-"));
let child;
let launchError;
let exited;
let browserSocket;
try {
  report.checks.desktopVersion = checkAppVersion(resources);
  report.checks.desktopArch = binaryArchitecture(desktop);
  report.checks.cliArch = binaryArchitecture(cli);
  console.log(JSON.stringify(report.checks));
  assert.equal(report.checks.desktopArch, arch);
  assert.equal(report.checks.cliArch, arch);

  const runCli = args => execFileSync(cli, args, { cwd: profile, encoding: "utf8", timeout: 20_000 }).trim();
  checkCliVersion(cli, profile);
  report.checks.cliVersion = version;
  const project = join(profile, "board");
  mkdirSync(project);
  assert.equal(JSON.parse(runCli(["--project", project, "--json", "init"])).ok, true);
  const board = JSON.parse(runCli(["--project", project, "--json", "list"]));
  assert.equal(board.ok, true);
  assert.deepEqual(board.data.tasks, []);
  report.checks.cliBoard = true;

  report.packages = [];
  for (const extension of windows ? ["exe"] : mac ? [signedRelease ? "pkg" : "zip"] : ["deb", "rpm"]) {
    const file = `${name}.${extension}`;
    report.checkingPackage = file;
    const path = join(release, file);
    const size = statSync(path).size;
    assert.ok(size > 0);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const evidence = { file, size, sha256: hash.digest("hex") };
    report.packages.push(evidence);
    const destination = join(profile, extension);
    if (signedRelease && (windows || mac)) evidence.signature = verifySignature(path);
    const packagedResources = extractResources(path, extension, destination);
    evidence.desktopVersion = checkAppVersion(packagedResources);
    if (signedRelease && mac) {
      execFileSync("codesign", ["--verify", "--deep", "--strict", resolve(packagedResources, "../..")],
        { timeout: 60_000 });
    }
    const extracted = join(packagedResources, "bin", windows ? "ai-taskboard.exe" : "ai-taskboard");
    evidence.cliArch = binaryArchitecture(extracted);
    assert.equal(evidence.cliArch, arch, `${file} contains the wrong CLI architecture`);
    checkCliVersion(extracted, profile);
    evidence.cliVersion = version;
    rmSync(destination, { recursive: true, maxRetries: 5, retryDelay: 200 });
  }
  delete report.checkingPackage;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (windows) env.APPDATA = env.LOCALAPPDATA = profile;
  if (!windows && !mac) env.XDG_CONFIG_HOME = env.XDG_CACHE_HOME = profile;
  if (mac) env.CFFIXED_USER_HOME = profile;
  child = spawn(desktop, [
    `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", "--enable-logging=stderr",
  ], { cwd: tmpdir(), env, detached: !windows, stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", error => { launchError = error; });
  exited = new Promise(done => child.once("close", done));

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, "Packaged application exited before showing its welcome page");
    assert.equal(child.signalCode, null, "Packaged application crashed before showing its welcome page");
    const portFile = join(profile, "DevToolsActivePort");
    if (existsSync(portFile)) {
      const [portLine, browserPath] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
      const port = Number.parseInt(portLine, 10);
      if (browserPath?.startsWith("/devtools/browser/")) browserSocket = `ws://127.0.0.1:${port}${browserPath}`;
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
        .then(response => response.json()).catch(() => []);
      const page = pages.find(target => target.type === "page" && target.url.startsWith("file:") && target.webSocketDebuggerUrl);
      const result = page && await devtools(page.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: "Boolean(window.taskboard && document.querySelector('#welcome')?.hidden === false)",
        returnByValue: true,
      });
      if (result?.result?.value === true) {
        report.checks.welcome = true;
        break;
      }
    }
    await delay(250);
  }
  assert.equal(report.checks.welcome, true, "Packaged welcome page and preload did not become ready");
  console.log("Packaged welcome page and preload are ready.");
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  let shutdownError;
  let cleanupError;
  try {
    if (browserSocket && child.exitCode === null && child.signalCode === null) {
      await devtools(browserSocket, "Browser.close").catch(() => {});
      await Promise.race([exited, delay(4000, undefined, { ref: false })]);
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      if (windows) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000 });
      else process.kill(-child.pid, "SIGKILL");
    }
    if (exited) {
      const closed = await Promise.race([exited.then(() => true), delay(10_000, false, { ref: false })]);
      if (!closed) throw new Error("Packaged Electron did not exit");
    }
  } catch (error) {
    shutdownError = error;
    report.shutdownError = error.message;
  }
  try {
    rmSync(profile, { recursive: true, maxRetries: 12, retryDelay: 200 });
    report.checks.profileRemoved = true;
  } catch (error) {
    cleanupError = error;
    report.cleanupError = error.message;
  } finally {
    writeFileSync(join(output, "package.json"), JSON.stringify(report, null, 2) + "\n");
  }
  // Keep the original smoke failure as the thrown error when shutdown or cleanup also fails.
  if (!Object.hasOwn(report, "error") && (shutdownError || cleanupError)) throw shutdownError ?? cleanupError;
}
