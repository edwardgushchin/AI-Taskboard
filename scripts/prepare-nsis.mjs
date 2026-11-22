import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  const builder = dirname(require.resolve("app-builder-lib/package.json"));
  const path = join(builder, "templates", "nsis", "installer.nsi");
  const original = readFileSync(path, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const outPath = [
    "  SetOutPath $INSTDIR",
    "  ${LogSet} on",
  ].join(eol);
  const preInit = [
    "  !ifmacrodef preInit",
    "    !insertmacro preInit",
    "  !endif",
  ].join(eol);
  const late = [outPath, "", preInit].join(eol);
  // SetOutPath creates the directory supplied through /D=, even if preInit later quits.
  const early = ["  !define TASKBOARD_EARLY_PREINIT", preInit, "", outPath].join(eol);

  if (!original.includes(early)) {
    if (original.split(late).length !== 2) {
      throw new Error("Review preInit placement in the electron-builder NSIS template.");
    }
    writeFileSync(path, original.replace(late, early));
  }
}
