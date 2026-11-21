import { Arch, Platform, build } from "electron-builder";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = {};
const ci = process.argv.includes("--ci");
const release = process.argv.includes("--release");
if (ci && release) throw new Error("Choose either --ci or --release.");
const platform = Platform.current();
const platformName = { win32: "windows", linux: "linux", darwin: "macos" }[process.platform];
if (ci || release) {
  config.artifactName = `ai-taskboard-\${version}-${platformName}-${process.arch}.\${ext}`;
}
if (ci && process.platform === "win32") config.win = { signExecutable: false };
if (ci && process.platform === "darwin") {
  config.mac = { identity: "-", hardenedRuntime: false, notarize: false };
}
if (release && process.platform !== "linux") {
  const signingInputs = ["CSC_LINK", "CSC_KEY_PASSWORD"];
  if (process.platform === "darwin") {
    signingInputs.push("CSC_INSTALLER_LINK", "CSC_INSTALLER_KEY_PASSWORD",
      "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID");
    config.mac = { notarize: true };
  }
  const missing = signingInputs.filter(name => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing release signing inputs: ${missing.join(", ")}`);
  config.forceCodeSigning = true;
}
const stage = join(root, "dist", "installer");
mkdirSync(stage, { recursive: true });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
config.extraMetadata = {
  taskboardBuild: { commit, date: new Date().toISOString() },
};

if (process.platform === "linux") {
  const homepage = process.env.AI_TASKBOARD_PROJECT_URL;
  const maintainer = process.env.AI_TASKBOARD_MAINTAINER;
  if (!homepage || !/^https?:\/\//.test(homepage) || !maintainer) {
    throw new Error("Set AI_TASKBOARD_PROJECT_URL and AI_TASKBOARD_MAINTAINER for Linux package metadata.");
  }
  config.extraMetadata.homepage = homepage;
  config.linux = { maintainer };
  const require = createRequire(import.meta.url);
  const templates = join(dirname(require.resolve("app-builder-lib/package.json")), "templates", "linux");
  for (const [property, name] of [["afterInstall", "after-install"], ["afterRemove", "after-remove"]]) {
    const path = join(stage, name + ".sh");
    const standard = readFileSync(join(templates, name + ".tpl"), "utf8");
    const cli = readFileSync(join(root, "build", "linux-" + name + ".sh"), "utf8");
    writeFileSync(path, standard + "\n" + cli);
    config.deb = { ...config.deb, [property]: path };
    config.rpm = { ...config.rpm, [property]: path };
  }
}
if (process.platform === "darwin" && !ci) {
  const scripts = join(stage, "pkg-scripts");
  mkdirSync(scripts, { recursive: true });
  const postinstall = join(scripts, "postinstall");
  copyFileSync(join(root, "build", "mac-postinstall.sh"), postinstall);
  chmodSync(postinstall, 0o755);
  config.pkg = { scripts, allowAnywhere: false, allowCurrentUserHome: false };
}
const targets = ci || release
  ? platform.createTarget(ci && process.platform === "darwin" ? "zip" : null, Arch[process.arch])
  : undefined;
await build({ projectDir: root, config, targets, publish: "never" });
