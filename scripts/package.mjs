import { build } from "electron-builder";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = {};
const stage = join(root, "dist", "installer");
mkdirSync(stage, { recursive: true });

if (process.platform === "linux") {
  const homepage = process.env.AI_TASKBOARD_PROJECT_URL;
  const maintainer = process.env.AI_TASKBOARD_MAINTAINER;
  if (!homepage || !/^https?:\/\//.test(homepage) || !maintainer) {
    throw new Error("Set AI_TASKBOARD_PROJECT_URL and AI_TASKBOARD_MAINTAINER for Linux package metadata.");
  }
  config.extraMetadata = { homepage };
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
if (process.platform === "darwin") {
  const scripts = join(stage, "pkg-scripts");
  mkdirSync(scripts, { recursive: true });
  const postinstall = join(scripts, "postinstall");
  copyFileSync(join(root, "build", "mac-postinstall.sh"), postinstall);
  chmodSync(postinstall, 0o755);
  config.pkg = { scripts, allowAnywhere: false, allowCurrentUserHome: false };
}
await build({ projectDir: root, config, publish: "never" });
