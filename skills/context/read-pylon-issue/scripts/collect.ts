#!/usr/bin/env bun

import { resolve } from "node:path";
import { collectPylonIssue, resolvePylonApiUrl } from "./collector.ts";

const [locator, ...arguments_] = process.argv.slice(2);
const artifactsIndex = arguments_.indexOf("--artifacts-dir");
const artifactsDirectory = artifactsIndex >= 0 ? arguments_[artifactsIndex + 1] : undefined;

if (!locator || !artifactsDirectory || arguments_.length !== 2 || artifactsIndex !== 0) {
  console.error("Usage: bun collect.ts <pylon-issue-id-number-or-url> --artifacts-dir <directory>");
  process.exit(2);
}

const token = process.env.PYLON_API_TOKEN?.trim();
if (!token) {
  console.error("PYLON_API_TOKEN is required through the runtime environment");
  process.exit(2);
}

try {
  const result = await collectPylonIssue(locator, {
    apiUrl: resolvePylonApiUrl(process.env.PYLON_API_URL),
    artifactsDirectory: resolve(artifactsDirectory),
    token,
  });
  console.log(`Pylon issue: ${result.issueNumber}`);
  console.log(`Run directory: ${result.runDirectory}`);
  console.log(
    `Files: ${result.files.filter((file) => file.status === "retrieved").length}/${result.files.length}`,
  );
  console.log(`Gaps: ${result.gaps.length}`);
  process.exit(result.gaps.length === 0 ? 0 : 3);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
