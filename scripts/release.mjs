import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const checksumName = "SHA256SUMS";
const notesName = "release-notes.md";

export async function releaseVersion(version, tag) {
  const { default: semver } = await import("semver");
  assert(typeof version === "string" && semver.valid(version) === version,
    "Use a canonical SemVer version without build metadata in package.json");
  if (tag !== undefined) assert.equal(tag, `v${version}`, "The release tag must match package.json");
  return version;
}

function changesSection(version, changes, repository, serverUrl = "https://github.com") {
  assert(typeof changes === "string", "Release changes are required");
  const [base, ...lines] = changes.trim().split(/\r?\n/);
  const items = lines.filter(line => line.trim());
  assert(items.length > 0 && items.every(line => /^-\s+\S/.test(line)),
    "Release changes must contain a non-empty bullet list");

  let introduction = "This is the first public release.";
  if (base !== "first") {
    assert(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(base) && base !== `v${version}`,
      "Specify a previous release tag or first on the first line of the release changes");
    introduction = `Changes since \`${base}\`. [Compare ${base} and v${version}](${serverUrl}/${repository}/compare/${base}...v${version}).`;
  }
  return ["### What's changed", "", introduction, "", ...items].join("\n");
}

export function expectedPackageGroups(version, signed) {
  const groups = new Map();
  for (const [os, extensions] of Object.entries({ windows: ["exe"], linux: ["deb", "rpm"], macos: [signed ? "pkg" : "zip"] })) {
    for (const arch of ["x64", "arm64"]) {
      const id = `ai-taskboard-${version}-${os}-${arch}`;
      groups.set(id, extensions.map((extension) => `${id}.${extension}`));
    }
  }
  return groups;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function stageRelease(version, signed, artifactRoot, output, { sha, runUrl, changes, repository, serverUrl }) {
  const section = changes === undefined ? [] : [changesSection(version, changes, repository, serverUrl), ""];
  const groups = expectedPackageGroups(version, signed);
  assert.deepEqual((await readdir(artifactRoot)).sort(), [...groups.keys()].sort(), "Incomplete or unexpected matrix artifacts");
  await mkdir(output);
  const manifest = [];
  for (const [group, names] of groups) {
    const packageDir = join(artifactRoot, group);
    assert.deepEqual((await readdir(packageDir)).sort(), names, `Unexpected files in ${group}`);
    for (const name of names) {
      const source = join(packageDir, name);
      const file = await stat(source);
      assert(file.isFile() && file.size > 0, `Invalid package ${name}`);
      await copyFile(source, join(output, name));
      manifest.push(`${await sha256(join(output, name))}  ${name}`);
    }
  }
  await writeFile(join(output, checksumName), manifest.join("\n") + "\n");
  await writeFile(join(output, notesName), [
    `<!-- ai-taskboard-release:${sha} -->`,
    `## AI Taskboard ${version}`,
    "",
    ...section,
    `Built from [${sha}](${runUrl}) on native x64 and ARM64 runners.`,
    "",
    "Choose the matching architecture (x64 for Intel/AMD, arm64 for ARM or Apple Silicon):",
    "",
    "- Windows: run the NSIS installer (.exe).",
    signed ? "- macOS: open the signed and notarized installer (.pkg)." : "- macOS: unpack the application archive (.zip).",
    "- Linux: install the .deb on Debian/Ubuntu or the .rpm on an RPM-based distribution.",
    "",
    "Replace `package-file` with the downloaded filename and compare the result with its entry in SHA256SUMS.",
    "",
    "On Linux:",
    "",
    "```sh",
    'sha256sum "package-file"',
    "```",
    "",
    "On macOS:",
    "",
    "```sh",
    'shasum -a 256 "package-file"',
    "```",
    "",
    "In Windows PowerShell:",
    "",
    "```powershell",
    'Get-FileHash -LiteralPath "package-file" -Algorithm SHA256',
    "```",
    "",
    signed ? "" : "The Windows installer is unsigned. The macOS application is ad-hoc signed and has no notarization.",
    "",
  ].join("\n"));
}

function parseManifest(content, expected) {
  const hashes = new Map();
  for (const line of content.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert(match && !hashes.has(match[2]), "Malformed SHA256SUMS");
    hashes.set(match[2], match[1]);
  }
  assert.deepEqual([...hashes.keys()].sort(), [...expected].sort(), "Unexpected package inventory in SHA256SUMS");
  return hashes;
}

async function verifyCandidate(directory, names) {
  assert.deepEqual((await readdir(directory)).sort(), [...names, checksumName, notesName].sort(), "Unexpected release candidate inventory");
  const content = await readFile(join(directory, checksumName), "utf8");
  const hashes = parseManifest(content, names);
  for (const [name, digest] of hashes) assert.equal(await sha256(join(directory, name)), digest, `Checksum mismatch: ${name}`);
  hashes.set(checksumName, createHash("sha256").update(content).digest("hex"));
  return hashes;
}

function hasDigest(asset, digest) {
  return asset?.state === "uploaded" && asset.digest === `sha256:${digest}`;
}

function verifyRemoteAssets(assets, hashes) {
  assert.deepEqual(assets.map(({ name }) => name).sort(), [...hashes.keys()].sort(), "Unexpected GitHub Release asset inventory");
  for (const asset of assets) assert(hasDigest(asset, hashes.get(asset.name)), `GitHub checksum mismatch: ${asset.name}`);
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export async function publishRelease({ repository, version, signed, sha, directory, changes, serverUrl },
  github = gh, resolveTag = resolveRemoteTag) {
  const tag = `v${version}`;
  const prerelease = version.includes("-");
  const names = [...expectedPackageGroups(version, signed).values()].flat();
  const hashes = await verifyCandidate(directory, names);
  const notes = await readFile(join(directory, notesName), "utf8");
  const marker = `<!-- ai-taskboard-release:${sha} -->`;
  const requiredSection = changesSection(version, changes, repository, serverUrl);
  const hasChanges = (body) => body?.replaceAll("\r\n", "\n").includes(`\n${requiredSection}\n\n`);
  assert(notes.startsWith(marker + "\n"), "Release candidate source commit mismatch");
  assert(hasChanges(notes), "Release candidate is missing the prepared changes");
  assert.equal(resolveTag(tag), sha, "Remote tag does not point to the build commit");

  const releases = `repos/${repository}/releases`;
  const list = () => JSON.parse(github("api", "--paginate", "--slurp", `${releases}?per_page=100`))
    .flat().filter((entry) => entry.tag_name === tag);
  let matching = list();
  assert(matching.length <= 1, `Multiple GitHub Releases use tag ${tag}`);
  if (!matching.length) {
    const args = ["release", "create", tag, "--repo", repository, "--verify-tag", "--draft",
      "--title", `AI Taskboard ${version}`, "--notes-file", join(directory, notesName)];
    if (prerelease) args.push("--prerelease", "--latest=false");
    github(...args);
    matching = list();
    assert.equal(matching.length, 1, "Expected a single GitHub Release draft");
  }

  const [release] = matching;
  assert(release.body?.includes(marker), "This GitHub Release belongs to a different build or release process");
  assert(hasChanges(release.body), "GitHub Release is missing the prepared changes");
  assert.equal(release.prerelease, prerelease, "GitHub Release has a different prerelease flag");
  const endpoint = `${releases}/${release.id}`;
  if (!release.draft) {
    const manifestAsset = release.assets.find((asset) => asset.name === checksumName);
    assert(manifestAsset, "Published release has no SHA256SUMS asset");
    const manifest = github("api", "-H", "Accept: application/octet-stream", `${releases}/assets/${manifestAsset.id}`);
    const publishedHashes = parseManifest(manifest, names);
    publishedHashes.set(checksumName, createHash("sha256").update(manifest).digest("hex"));
    verifyRemoteAssets(release.assets, publishedHashes);
    return release.html_url;
  }

  assert(release.assets.every((asset) => hashes.has(asset.name)), "The draft contains unexpected assets");
  const uploads = [];
  for (const [name, hash] of hashes) {
    if (!hasDigest(release.assets.find((asset) => asset.name === name), hash)) uploads.push(join(directory, name));
  }
  if (uploads.length) github("release", "upload", tag, "--repo", repository, "--clobber", ...uploads);
  const draft = JSON.parse(github("api", endpoint));
  assert(draft.draft && draft.tag_name === tag && draft.prerelease === prerelease &&
    draft.body?.includes(marker) && hasChanges(draft.body),
    "Release changed during draft verification");
  verifyRemoteAssets(draft.assets, hashes);
  assert.equal(resolveTag(tag), sha, "Remote tag changed while uploading assets");
  const published = JSON.parse(github("api", "-X", "PATCH", endpoint, "-F", "draft=false",
    "-f", `make_latest=${prerelease ? "false" : "legacy"}`));
  assert.equal(published.draft, false);
  return published.html_url;
}

function resolveRemoteTag(tag) {
  const ref = `refs/tags/${tag}`;
  const output = execFileSync("git", ["ls-remote", "origin", ref, ref + "^{}"], { encoding: "utf8" });
  const refs = new Map(output.trimEnd().split("\n").map((line) => {
    const [sha, name] = line.split("\t");
    return [name, sha];
  }));
  return refs.get(ref + "^{}") ?? refs.get(ref);
}

function checkedOutCommit() {
  return execFileSync("git", ["rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
}

async function main() {
  const [command, directory, output] = process.argv.slice(2);
  const { GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_OUTPUT, GITHUB_SERVER_URL,
    GITHUB_REPOSITORY, GITHUB_RUN_ID, SIGNED_REHEARSAL, DEFAULT_BRANCH, RELEASE_VERSION, SIGNED_BUILD } = process.env;
  const tagPush = GITHUB_EVENT_NAME === "push" && GITHUB_REF_TYPE === "tag";
  if (command === "version") {
    const signedDispatch = GITHUB_EVENT_NAME === "workflow_dispatch" && SIGNED_REHEARSAL === "true";
    if (tagPush) assert(GITHUB_REF_NAME, "Expected a tag name");
    if (signedDispatch) assert(GITHUB_REF_TYPE === "branch" && GITHUB_REF_NAME === DEFAULT_BRANCH, "Signed rehearsal requires the default branch");
    const { version } = JSON.parse(await readFile("package.json", "utf8"));
    await releaseVersion(version, tagPush ? GITHUB_REF_NAME : undefined);
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    assert.equal(lock.version, version, "package-lock.json version must match package.json");
    assert.equal(lock.packages?.[""]?.version, version, "Root package version in package-lock.json must match package.json");
    const alpha = /^\d+\.\d+\.\d+-alpha(?:\.|$)/.test(version);
    const signed = signedDispatch || (tagPush && !alpha);
    await appendFile(GITHUB_OUTPUT, `version=${version}\nsigned=${signed}\n`);
    return;
  }
  assert(SIGNED_BUILD === "true" || SIGNED_BUILD === "false", "Expected an explicit SIGNED_BUILD profile");
  const signed = SIGNED_BUILD === "true";
  if (command === "stage") {
    const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
    const changes = tagPush ? await readFile(`release-notes/${GITHUB_REF_NAME}.md`, "utf8") : undefined;
    await stageRelease(RELEASE_VERSION, signed, directory, output, {
      sha: checkedOutCommit(),
      runUrl,
      changes,
      repository: GITHUB_REPOSITORY,
      serverUrl: GITHUB_SERVER_URL,
    });
  } else if (command === "check") {
    const names = [...expectedPackageGroups(RELEASE_VERSION, signed).values()].flat();
    await verifyCandidate(directory, names);
    console.log(`Verified ${names.length} downloaded packages against SHA256SUMS`);
  } else {
    assert.equal(command, "publish");
    assert(tagPush && GITHUB_REF_NAME === `v${RELEASE_VERSION}`);
    console.log(await publishRelease({
      repository: GITHUB_REPOSITORY,
      version: RELEASE_VERSION,
      signed,
      sha: checkedOutCommit(),
      directory,
      changes: await readFile(`release-notes/${GITHUB_REF_NAME}.md`, "utf8"),
      serverUrl: GITHUB_SERVER_URL,
    }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
