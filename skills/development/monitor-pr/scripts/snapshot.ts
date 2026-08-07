#!/usr/bin/env -S bun --no-env-file

// Produce one normalized observation; monitor-pr owns the repeated wait loop.

import { observeGitHubPullRequest } from "./observer.ts";

const [url, ...arguments_] = Bun.argv.slice(2);
let timeoutMs: number | undefined;
while (arguments_.length > 0) {
  const flag = arguments_.shift();
  const value = arguments_.shift();
  if (flag !== "--timeout-ms" || !value) fail("Unknown or incomplete argument");
  timeoutMs = Number(value);
}
if (!url) fail("Usage: snapshot.ts <github-pr-url> [--timeout-ms <milliseconds>]");

const result = await observeGitHubPullRequest(url, { timeoutMs });
console.log(JSON.stringify(result, null, 2));
process.exit(result.outcome === "ok" ? 0 : result.outcome === "unsupported-input" ? 2 : 1);

function fail(message: string): never {
  console.log(JSON.stringify({ outcome: "unsupported-input", error: message }, null, 2));
  process.exit(2);
}
