#!/usr/bin/env bun
import { parseArguments } from "./arguments.ts";
import { isComplete, prepareVideo } from "./prepare-video.ts";

const usage = `Usage:
  video-tools prepare <video-path> [--artifacts-dir <directory>] [--frame-count <count>] [--max-frames <count>] [--timeout-ms <milliseconds>] [--container-image <name@sha256:digest>]

When --artifacts-dir is omitted, the command creates an isolated temporary directory and reports
its location in the JSON result. Temporary derivatives are retained for the caller to inspect.

--timeout-ms bounds each tool invocation, not the total run. A preparation that runs several
stages may therefore exceed it in aggregate.

The container image must already exist locally. This command never pulls or builds one.

Exit 0 means every applicable lane completed. Exit 2 preserves an unavailable, unsupported,
failed, timed-out, or input-changed outcome in the JSON result. Exit 1 means the arguments or
the input path could not be used, and prints no JSON.`;

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage);
    process.exit(0);
  }
  const result = await prepareVideo(args);
  console.log(JSON.stringify(result, null, 2));
  process.exit(isComplete(result) ? 0 : 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exit(1);
}
