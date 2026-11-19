import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { publishRelease, releaseVersion, stageRelease } from "../scripts/release.mjs";
import { checkForUpdates, releaseRepository, releasesUrl } from "../src/desktop/updates.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseScript = join(root, "scripts", "release.mjs");
const sha = "1234567890abcdef1234567890abcdef12345678";
const source = { sha, runUrl: "https://example.invalid/actions/runs/123" };
const stable = "0.1.0";
const alpha = "0.1.0-alpha";
const preview = "0.1.1-beta.2"; // Only a controlled Releases API fixture.
const hash = content => createHash("sha256").update(content).digest("hex");

function fixture(t, version, signed) {
  const scratch = mkdtempSync(join(tmpdir(), "ai-taskboard-release-test-"));
  t.after(() => rmSync(scratch, { recursive: true }));
  const artifacts = join(scratch, "matrix");
  const output = join(scratch, "candidate");
  const downloaded = join(scratch, "downloaded");
  const parts = [
    ["windows-x64", ["exe"]], ["windows-arm64", ["exe"]],
    ["linux-x64", ["deb", "rpm"]], ["linux-arm64", ["deb", "rpm"]],
    ["macos-x64", [signed ? "pkg" : "zip"]], ["macos-arm64", [signed ? "pkg" : "zip"]],
  ];
  const names = [];
  for (const [platform, formats] of parts) {
    const name = "ai-taskboard-" + version + "-" + platform;
    const dir = join(artifacts, name);
    mkdirSync(dir, { recursive: true });
    for (const format of formats) {
      const file = name + "." + format;
      names.push(file);
      writeFileSync(join(dir, file), "Fixture bytes for " + file + "\n");
    }
  }
  return { artifacts, output, downloaded, names, stage: () => stageRelease(version, signed, artifacts, output, source) };
}

function checkDownloaded(version, signed, path) {
  const result = spawnSync(process.execPath, ["scripts/release.mjs", "check", path], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, RELEASE_VERSION: version, SIGNED_BUILD: String(signed) },
  });
  assert.ifError(result.error);
  return result;
}

function selectTagProfile(directory, version, tag = `v${version}`) {
  const output = join(directory, "github-output");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [releaseScript, "version"], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: tag,
      GITHUB_OUTPUT: output,
    },
  });
  assert.ifError(result.error);
  return { result, outputs: readFileSync(output, "utf8") };
}

function controlledGitHub({ interruptUpload = false } = {}) {
  const releases = [];
  const attached = new Map();
  const writes = [];
  let nextAsset = 1;
  const endpoint = "repos/" + releaseRepository + "/releases";
  const api = (...args) => {
    if (args[0] === "release") {
      const [, operation, tag] = args;
      writes.push(operation);
      if (operation === "create") {
        assert.ok(args.includes("--draft"));
        assert.ok(args.includes("--verify-tag"));
        if (args.includes("--prerelease")) {
          assert.ok(args.includes("--latest=false"));
        }
        assert.equal(releases.length, 0);
        releases.push({
          id: 1, tag_name: tag, draft: true, prerelease: args.includes("--prerelease"),
          html_url: releasesUrl + "/tag/" + tag, assets: [],
          body: readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"),
        });
        return "";
      }
      assert.equal(operation, "upload");
      assert.equal(releases[0].draft, true);
      for (const path of args.slice(args.indexOf("--clobber") + 1)) {
        const name = basename(path);
        const bytes = readFileSync(path);
        const id = nextAsset++;
        attached.set(id, bytes);
        releases[0].assets = releases[0].assets.filter(asset => asset.name !== name);
        releases[0].assets.push({ id, name, state: "uploaded", digest: "sha256:" + hash(bytes) });
        if (interruptUpload) {
          interruptUpload = false;
          throw new Error("Controlled upload interruption");
        }
      }
      return "";
    }
    assert.equal(args[0], "api");
    if (args[1] === "--paginate") {
      assert.deepEqual(args.slice(2), ["--slurp", endpoint + "?per_page=100"]);
      return JSON.stringify([[], releases]);
    }
    if (args[1] === "-H") {
      assert.equal(args[2], "Accept: application/octet-stream");
      return attached.get(Number(args[3].split("/").at(-1))).toString("utf8");
    }
    if (args[1] === "-X") {
      assert.deepEqual(args.slice(2), ["PATCH", endpoint + "/1", "-F", "draft=false", "-f",
        "make_latest=" + (releases[0].prerelease ? "false" : "legacy")]);
      assert.equal(releases[0].assets.length, 9);
      releases[0].draft = false;
      writes.push("publish");
    } else {
      assert.equal(args[1], endpoint + "/1");
    }
    return JSON.stringify(releases[0]);
  };
  return { api, releases, writes };
}

test("release version accepts exact stable and prerelease tags", async () => {
  assert.equal(await releaseVersion(stable, "v" + stable), stable);
  assert.equal(await releaseVersion(preview, "v" + preview), preview);
  await assert.rejects(releaseVersion(stable, "v" + preview), /release tag must match/);
  await assert.rejects(releaseVersion("0.1.0+ci", "v0.1.0+ci"), /canonical SemVer/);
});

test("release CLI keeps branch pushes unsigned and reserves signed dispatch for the default branch", t => {
  const scratch = mkdtempSync(join(tmpdir(), "ai-taskboard-release-profile-"));
  t.after(() => rmSync(scratch, { recursive: true }));
  const output = join(scratch, "github-output");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  for (const [event, refType, refName, requestSigning, expectedSigning] of [
    ["push", "branch", "release-rehearsal/T-0101", "true", false],
    ["workflow_dispatch", "branch", "release-rehearsal/T-0101", "false", false],
    ["workflow_dispatch", "branch", "main", "true", true],
    ["workflow_dispatch", "branch", "release-rehearsal/T-0101", "true", null],
  ]) {
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, ["scripts/release.mjs", "version"], {
      cwd: root, encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF_TYPE: refType,
        GITHUB_REF_NAME: refName,
        GITHUB_OUTPUT: output,
        DEFAULT_BRANCH: "main",
        SIGNED_REHEARSAL: requestSigning,
      },
    });
    assert.ifError(result.error);
    if (expectedSigning === null) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Signed rehearsal requires the default branch/);
      assert.equal(readFileSync(output, "utf8"), "");
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), "version=" + version + "\nsigned=" + expectedSigning + "\n");
    }
  }
});

test("tag profile uses the first SemVer prerelease identifier and requires an exact version match", t => {
  const scratch = mkdtempSync(join(tmpdir(), "ai-taskboard-release-profile-"));
  t.after(() => rmSync(scratch, { recursive: true }));
  for (const [version, signed] of [
    [stable, true],
    [alpha, false],
    ["0.1.0-alpha.2", false],
    ["0.1.0-alpha-other", true],
    ["0.1.0-beta.alpha", true],
  ]) {
    const { result, outputs } = selectTagProfile(scratch, version);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(outputs, `version=${version}\nsigned=${signed}\n`);
  }
  const { result, outputs } = selectTagProfile(scratch, stable, `v${alpha}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release tag must match/);
  assert.equal(outputs, "");
});

for (const signed of [false, true]) {
  test((signed ? "distribution" : "CI") + " candidate hashes every package and rejects a corrupt download", async t => {
    const build = fixture(t, stable, signed);
    await build.stage();
    cpSync(build.output, build.downloaded, { recursive: true });
    const manifest = readFileSync(join(build.downloaded, "SHA256SUMS"), "utf8");
    assert.equal(manifest, build.names.map(name =>
      hash("Fixture bytes for " + name + "\n") + "  " + name + "\n").join(""));
    assert.match(readFileSync(join(build.downloaded, "release-notes.md"), "utf8"),
      signed ? /signed and notarized installer/ : /ad-hoc signed and has no notarization/);
    const valid = checkDownloaded(stable, signed, build.downloaded);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Verified 8 downloaded packages/);
    writeFileSync(join(build.downloaded, build.names[0]), "Corrupted fixture");
    const corrupt = checkDownloaded(stable, signed, build.downloaded);
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /Checksum mismatch/);
    if (process.env.AI_TASKBOARD_TEST_REPORT === "1") t.diagnostic("\n" + manifest);
  });
}

test("missing architecture or package blocks the release candidate", async t => {
  for (const [version, signed] of [[alpha, false], [stable, true]]) {
    const build = fixture(t, version, signed);
    rmSync(join(build.artifacts, `ai-taskboard-${version}-linux-arm64`), { recursive: true });
    await assert.rejects(build.stage(), /Incomplete or unexpected matrix artifacts/);
    const incomplete = fixture(t, version, signed);
    const group = `ai-taskboard-${version}-linux-x64`;
    rmSync(join(incomplete.artifacts, group, group + ".rpm"));
    await assert.rejects(incomplete.stage(), /Unexpected files in/);
  }
});

test("alpha tag profile stages eight packages and publishes only after GitHub asset verification", async t => {
  const scratch = mkdtempSync(join(tmpdir(), "ai-taskboard-release-alpha-"));
  t.after(() => rmSync(scratch, { recursive: true }));
  const { result, outputs } = selectTagProfile(scratch, alpha);
  assert.equal(result.status, 0, result.stderr);
  const profile = new URLSearchParams(outputs.trim().replaceAll("\n", "&"));
  const version = profile.get("version");
  const signed = profile.get("signed") === "true";
  const build = fixture(t, alpha, false);
  const stage = spawnSync(process.execPath, [releaseScript, "stage", build.artifacts, build.output], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, RELEASE_VERSION: version, SIGNED_BUILD: profile.get("signed") },
  });
  assert.ifError(stage.error);
  assert.equal(stage.status, 0, stage.stderr);
  cpSync(build.output, build.downloaded, { recursive: true });
  const check = checkDownloaded(version, signed, build.downloaded);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Verified 8 downloaded packages/);

  const commit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }).trim();
  const args = { repository: releaseRepository, version, signed, sha: commit, directory: build.downloaded };
  const github = controlledGitHub();
  const macZip = `ai-taskboard-${alpha}-macos-arm64.zip`;
  const windowsExe = `ai-taskboard-${alpha}-windows-x64.exe`;
  writeFileSync(join(build.downloaded, windowsExe), "Corrupted download");
  await assert.rejects(publishRelease(args, github.api, () => commit), /Checksum mismatch: .*windows-x64\.exe/);
  assert.deepEqual(github.writes, []);
  cpSync(join(build.output, windowsExe), join(build.downloaded, windowsExe));

  const readCorruptDraft = (...request) => {
    const response = github.api(...request);
    if (request[0] !== "api" || request[1] !== `repos/${releaseRepository}/releases/1`) {
      return response;
    }
    const draft = JSON.parse(response);
    draft.assets.find(asset => asset.name === macZip).digest = "sha256:" + hash("Corrupted remote ZIP");
    return JSON.stringify(draft);
  };
  await assert.rejects(publishRelease(args, readCorruptDraft, () => commit), /GitHub checksum mismatch: .*macos-arm64\.zip/);
  assert.deepEqual(github.writes, ["create", "upload"]);
  assert.equal(github.releases[0].draft, true);
  assert.equal(github.releases[0].prerelease, true);
  assert.equal(await publishRelease(args, github.api, () => commit), releasesUrl + "/tag/v" + alpha);
  assert.deepEqual(github.writes, ["create", "upload", "publish"]);
  assert.deepEqual(github.releases[0].assets.map(asset => asset.name).sort(), [...build.names, "SHA256SUMS"].sort());
  assert.equal(await publishRelease(args, github.api, () => commit), releasesUrl + "/tag/v" + alpha);
  assert.deepEqual(github.writes, ["create", "upload", "publish"]);
});

test("upload failure leaves a draft and retry publishes one complete stable release", async t => {
  const build = fixture(t, stable, true);
  await build.stage();
  const github = controlledGitHub({ interruptUpload: true });
  const publish = () => publishRelease({ repository: releaseRepository, version: stable, signed: true, sha, directory: build.output },
    github.api, () => sha);
  await assert.rejects(publish(), /Controlled upload interruption/);
  assert.equal(github.releases[0].draft, true);
  assert.equal(github.releases[0].assets.length, 1);
  const fetcher = async () => Response.json(github.releases);
  assert.equal((await checkForUpdates("0.0.9", fetcher)).status, "empty");
  const existing = github.releases[0].assets[0];
  assert.equal(await publish(), releasesUrl + "/tag/v" + stable);
  assert.equal(github.releases.length, 1);
  assert.equal(github.releases[0].draft, false);
  assert.equal(github.releases[0].prerelease, false);
  assert.equal(github.releases[0].assets.find(asset => asset.name === existing.name).id, existing.id);
  assert.deepEqual(github.releases[0].assets.map(asset => asset.name).sort(), [...build.names, "SHA256SUMS"].sort());
  const update = await checkForUpdates("0.0.9", fetcher);
  assert.equal(update.status, "available");
  assert.deepEqual(update.latest, { version: stable, url: releasesUrl + "/tag/v" + stable, prerelease: false });

  const rebuilt = fixture(t, stable, true);
  const reSignedGroup = basename(existing.name, extname(existing.name));
  writeFileSync(join(rebuilt.artifacts, reSignedGroup, existing.name), "Different signing timestamp");
  await rebuilt.stage();
  const repeat = () => publishRelease({ repository: releaseRepository, version: stable, signed: true, sha, directory: rebuilt.output },
    github.api, () => sha);
  assert.equal(await repeat(), releasesUrl + "/tag/v" + stable);
  assert.equal(github.releases[0].assets.find(asset => asset.name === existing.name).digest, existing.digest);
  existing.digest = "sha256:" + hash("Unexpected remote content");
  await assert.rejects(repeat(), /GitHub checksum mismatch/);
  assert.deepEqual(github.writes, ["create", "upload", "upload", "publish"]);
});

test("prerelease response from the publication model is visible only to preview installations", async t => {
  const build = fixture(t, preview, true);
  await build.stage();
  const github = controlledGitHub();
  const args = { repository: releaseRepository, version: preview, signed: true, sha, directory: build.output };
  await assert.rejects(publishRelease(args, github.api, () => "other"), /Remote tag does not point/);
  assert.deepEqual(github.writes, []);
  const url = await publishRelease(args, github.api, () => sha);
  assert.equal(github.releases[0].prerelease, true);
  const fetcher = async request => {
    assert.equal(request, "https://api.github.com/repos/" + releaseRepository + "/releases?per_page=100&page=1");
    return Response.json([...github.releases, { tag_name: "v99.0.0", draft: true, prerelease: false }]);
  };
  assert.equal((await checkForUpdates(stable, fetcher)).status, "empty");
  const update = await checkForUpdates("0.1.1-beta.1", fetcher);
  assert.equal(update.status, "available");
  assert.deepEqual(update.latest, { version: preview, url, prerelease: true });
});
