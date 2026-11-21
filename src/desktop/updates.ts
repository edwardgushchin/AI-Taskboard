import { createRequire } from "node:module";

// Shared with the packaged app; independent of every open board and its remotes.
export const releaseRepository = "edwardgushchin/AI-Taskboard";
export const repositoryUrl = `https://github.com/${releaseRepository}`;
export const releasesUrl = `${repositoryUrl}/releases`;
const semver = createRequire(import.meta.url)("semver");

export async function checkForUpdates(currentVersion: string, fetcher: typeof fetch = fetch) {
  const current: string | null = semver.valid(currentVersion);
  if (!current) throw new Error("Invalid application version.");
  const includePrerelease = semver.prerelease(current) !== null;
  let latest: { version: string; tag: string; url: string; prerelease: boolean; notes: string } | null = null;
  const signal = AbortSignal.timeout(15_000);
  for (let page = 1; ; page++) {
    const response = await fetcher(`https://api.github.com/repos/${releaseRepository}/releases?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal,
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) throw new Error("Invalid releases response.");
    for (const release of releases) {
      if (!release || typeof release !== "object" || release.draft || typeof release.tag_name !== "string") continue;
      const version: string | null = semver.valid(release.tag_name);
      if (!version) continue;
      const prerelease = Boolean(release.prerelease) || semver.prerelease(version) !== null;
      if (prerelease && !includePrerelease) continue;
      if (!latest || semver.gt(version, latest.version)) {
        latest = {
          version, tag: release.tag_name, prerelease,
          url: `${releasesUrl}/tag/${encodeURIComponent(release.tag_name)}`,
          notes: typeof release.body === "string" ? release.body.trim() : "",
        };
      }
    }
    if (releases.length < 100) break;
  }
  return { currentVersion, sourceUrl: releasesUrl, status: latest && semver.gt(latest.version, current) ? "available" as const
    : latest ? "current" as const : "empty" as const, latest };
}
