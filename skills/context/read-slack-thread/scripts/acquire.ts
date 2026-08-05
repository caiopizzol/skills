#!/usr/bin/env -S bun --no-env-file
import { acquireSlackFiles } from "./acquirer.ts";

const args = Bun.argv.slice(2);
const permalink = args.shift();
if (!permalink)
  fail(
    "Usage: acquire.ts <slack-permalink> --root-ts <timestamp> --objective <text> --file-id <id>... --artifacts-dir <path>",
  );

const fileIds: string[] = [];
let artifactsDirectory: string | undefined;
let objective: string | undefined;
let rootTs: string | undefined;
while (args.length > 0) {
  const flag = args.shift();
  const value = args.shift();
  if (!value) fail(`Missing value for ${flag ?? "argument"}`);
  if (flag === "--file-id") fileIds.push(value);
  else if (flag === "--artifacts-dir") artifactsDirectory = value;
  else if (flag === "--objective") objective = value;
  else if (flag === "--root-ts") rootTs = value;
  else fail(`Unknown argument: ${flag}`);
}
if (!artifactsDirectory) fail("Missing --artifacts-dir");
if (!objective) fail("Missing --objective");
if (!rootTs) fail("Missing --root-ts");
if (fileIds.length === 0) fail("Select at least one --file-id");
const token = Bun.env.SLACK_BOT_TOKEN;
if (!token) fail("SLACK_BOT_TOKEN is unavailable in the runtime");

const result = await acquireSlackFiles(permalink, fileIds, {
  token,
  objective,
  rootTs,
  artifactsDirectory,
});
console.log(`Manifest: ${result.manifestPath}`);
console.log(
  `Files: ${result.files.filter((file) => file.status === "retrieved").length}/${result.files.length}`,
);
console.log(`Gaps: ${result.gaps.length}`);
if (result.gaps.length > 0) process.exitCode = 2;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
