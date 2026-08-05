#!/usr/bin/env -S bun --no-env-file

import { resolve } from "node:path";
import { collectGitHubResource } from "./collector.ts";

const [url, ...arguments_] = Bun.argv.slice(2);
let artifactsDirectory: string | undefined;
let expectedKind: "issue" | "pull_request" | undefined;
while (arguments_.length > 0) {
  const flag = arguments_.shift();
  const value = arguments_.shift();
  if (!value) fail(`Missing value for ${flag ?? "argument"}`);
  if (flag === "--artifacts-dir") artifactsDirectory = value;
  else if (flag === "--kind" && (value === "issue" || value === "pull-request"))
    expectedKind = value === "issue" ? "issue" : "pull_request";
  else fail(`Unknown argument: ${flag}`);
}
if (!url || !artifactsDirectory || !expectedKind)
  fail(
    "Usage: collect.ts <github-issue-or-pr-url> --kind <issue|pull-request> --artifacts-dir <directory>",
  );

try {
  const result = await collectGitHubResource(url, {
    expectedKind,
    artifactsDirectory: resolve(artifactsDirectory),
  });
  console.log(
    `GitHub resource: ${result.repository.owner}/${result.repository.name}#${result.resource.number}`,
  );
  console.log(`Account: ${result.authenticatedAccount}`);
  console.log(`Run directory: ${result.runDirectory}`);
  console.log(
    `Attachments: ${result.attachments.filter((entry) => entry.status === "retrieved").length}/${result.attachments.length}`,
  );
  console.log(`External references: ${result.externalReferences.length}`);
  console.log(`Gaps: ${result.gaps.length}`);
  process.exit(result.gaps.length === 0 ? 0 : 3);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
