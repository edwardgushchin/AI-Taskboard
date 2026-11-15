import assert from "node:assert/strict";
import { test } from "node:test";
import { checkForUpdates, releaseRepository, releasesUrl } from "../src/desktop/updates.ts";

const release = (tag_name: string, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });
const source = (releases: unknown): typeof fetch => async () => Response.json(releases);

test("updates use the fixed application source and numeric SemVer precedence", async () => {
  assert.equal(releaseRepository, "edwardgushchin/AI-Taskboard");
  assert.equal(releasesUrl, "https://github.com/edwardgushchin/AI-Taskboard/releases");
  let requested = "";
  const result = await checkForUpdates("0.9.0", async (url, options) => {
    requested = String(url);
    assert.ok(options?.signal);
    return Response.json([release("v0.10.0"), release("v0.9.1"), release("v0.8.0")]);
  });
  assert.equal(requested, `https://api.github.com/repos/${releaseRepository}/releases?per_page=100&page=1`);
  assert.equal(result.currentVersion, "0.9.0");
  assert.equal(result.sourceUrl, releasesUrl);
  assert.equal(result.status, "available");
  assert.equal(result.latest?.version, "0.10.0");
  assert.equal(result.latest?.url, `${releasesUrl}/tag/v0.10.0`);
});

test("empty releases, same/older versions and build metadata do not offer an update", async () => {
  assert.equal((await checkForUpdates("0.1.0", source([]))).status, "empty");
  for (const version of ["0.1.0", "0.0.9", "0.1.0+other-build"]) {
    assert.equal((await checkForUpdates("0.1.0+installed", source([release(version)]))).status, "current");
  }
});

test("stable installs exclude previews, drafts and invalid tags", async () => {
  const releases = [release("v1.0.0-beta.10", { prerelease: true }), release("v2.0.0-rc.1"),
    release("v3.0.0", { draft: true }), release("latest"), release("01.0.0"), null];
  assert.equal((await checkForUpdates("0.1.0", source(releases))).status, "empty");
  const result = await checkForUpdates("0.1.0", source([...releases, release("0.2.0")]));
  assert.equal(result.latest?.version, "0.2.0");
});

test("prerelease installs compare numeric identifiers and can move to stable", async () => {
  const result = await checkForUpdates("1.0.0-beta.2", source([
    release("1.0.0-beta.9", { prerelease: true }), release("1.0.0-beta.10", { prerelease: true }),
  ]));
  assert.equal(result.status, "available");
  assert.equal(result.latest?.version, "1.0.0-beta.10");
  assert.equal(result.latest?.prerelease, true);
  assert.equal((await checkForUpdates("1.0.0-rc.1", source([release("1.0.0")]))).status, "available");
  assert.equal((await checkForUpdates("1.0.0-beta.10", source([release("1.0.0-beta.2")]))).status, "current");
});

test("all release pages are considered instead of publication order", async () => {
  const urls: string[] = [];
  const result = await checkForUpdates("1.0.0", async url => {
    urls.push(String(url));
    return Response.json(urls.length === 1 ? Array.from({ length: 100 }, () => release("1.0.0")) : [release("2.0.0")]);
  });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /page=2$/);
  assert.equal(result.latest?.version, "2.0.0");
});

test("network, timeout, HTTP and malformed responses fail and a fresh check can retry", async () => {
  for (const status of [403, 404, 429, 500]) {
    await assert.rejects(checkForUpdates("0.1.0", async () => new Response("", { status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(checkForUpdates("0.1.0", source({ error: "bad response" })), /Invalid releases/);
  await assert.rejects(checkForUpdates("0.1.0", async () => new Response("invalid json")), SyntaxError);
  await assert.rejects(checkForUpdates("invalid", source([])), /Invalid application version/);
  for (const error of [new TypeError("Offline"), new DOMException("Timed out", "TimeoutError")]) {
    await assert.rejects(checkForUpdates("0.1.0", async () => { throw error; }), error);
    assert.equal((await checkForUpdates("0.1.0", source([release("0.2.0")]))).status, "available");
  }
});
