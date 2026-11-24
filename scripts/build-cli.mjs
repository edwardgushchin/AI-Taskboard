import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "dist", "cli");
const executable = join(directory, process.platform === "win32" ? "ai-taskboard.exe" : "ai-taskboard");
const script = join(directory, "cli.cjs");
const config = join(directory, "sea.json");
const blob = join(directory, "sea.blob");
const nativeBuild = execFileSync(process.execPath, ["--help"], { encoding: "utf8" }).includes("--build-sea");
const mac = process.platform === "darwin";

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
}

mkdirSync(directory, { recursive: true });
cpSync(join(root, "src", "experts"), join(directory, "experts"), { recursive: true });
// Ship the terms alongside the standalone executable, including its Node runtime.
for (const name of ["LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
  copyFileSync(join(root, name), join(directory, name));
}
const nodeLicenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
const nodeLicense = await fetch(nodeLicenseUrl, { signal: AbortSignal.timeout(30000) });
if (!nodeLicense.ok) throw new Error(`Cannot read Node.js license: ${nodeLicense.status} ${nodeLicenseUrl}`);
const bundledLicenses = [
  ["fflate", "LICENSE"],
  ["semver", "LICENSE"],
  ["markdown-it", "LICENSE"],
  ["entities", "LICENSE"],
  ["linkify-it", "LICENSE"],
  ["mdurl", "LICENSE"],
  ["punycode.js", "LICENSE-MIT.txt"],
  ["uc.micro", "LICENSE.txt"],
];
writeFileSync(join(directory, "THIRD-PARTY-NOTICES.txt"),
  `Node.js ${process.versions.node} and bundled components\n${nodeLicenseUrl}\n\n${await nodeLicense.text()}\n\n` +
  bundledLicenses.map(([name, license]) =>
    `${name}\n\n${readFileSync(join(root, "node_modules", name, license), "utf8")}`).join("\n\n"));

await build({
  entryPoints: [join(root, "src", "cli", "main.ts")],
  outfile: script, platform: "node", target: "node24", format: "cjs", bundle: true, logLevel: "info",
});
writeFileSync(config, JSON.stringify({
  main: script,
  output: nativeBuild ? executable : blob,
  disableExperimentalSEAWarning: true,
  execArgv: ["--disable-warning=ExperimentalWarning"],
}));
if (nativeBuild) {
  run(process.execPath, ["--build-sea", config]);
} else {
  run(process.execPath, ["--experimental-sea-config", config]);
  copyFileSync(process.execPath, executable);
  if (mac) run("codesign", ["--remove-signature", executable]);
  run(process.execPath, [
    join(root, "node_modules", "postject", "dist", "cli.js"), executable, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(mac ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);
}
if (process.platform !== "win32") chmodSync(executable, 0o755);
if (mac) run("codesign", ["--force", "--sign", "-", executable]);
run(executable, ["--version", "--json"]);
