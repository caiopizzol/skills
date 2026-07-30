// Runs one script across every workspace package that defines it, in dependency-friendly order
// (packages before apps). Hand-maintained `&&` chains in package.json drifted every time a package
// was added, and a package silently missing from the chain is a package CI never checks.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const script = process.argv[2];
if (!script) {
  console.error("Usage: bun scripts/run-workspaces.ts <script-name>");
  process.exit(2);
}
const scriptName: string = script;

const root = resolve(import.meta.dirname, "..");
const targets = [...collect("packages"), ...collect("apps")];
if (targets.length === 0) {
  console.error(`No workspace package defines a "${scriptName}" script.`);
  process.exit(1);
}

for (const target of targets) {
  const result = Bun.spawnSync(["bun", "run", "--cwd", target, scriptName], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`\n${scriptName} failed in ${target}`);
    process.exit(result.exitCode ?? 1);
  }
}

function collect(group: string): string[] {
  const directory = join(root, group);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => statSync(join(directory, name)).isDirectory())
    .filter((name) => hasScript(join(directory, name)))
    .sort()
    .map((name) => `${group}/${name}`);
}

function hasScript(packageDirectory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return typeof manifest.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}
