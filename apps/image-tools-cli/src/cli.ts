#!/usr/bin/env bun
import { parseArguments } from "./arguments.ts";
import { isComplete, prepareImage } from "./prepare-image.ts";

const usage = `Usage:
  image-tools prepare <image-path> --artifacts-dir <directory> [--max-frames <count>] [--timeout-ms <milliseconds>] [--container-image <name@sha256:digest>]

--timeout-ms bounds each tool invocation, not the total run. A preparation that runs several
stages may therefore exceed it in aggregate.

The container image must already exist locally. This command never pulls or builds one.

Exit 0 means every applicable lane completed. Exit 2 preserves an unavailable, unsafe,
unsupported, failed, timed-out, or input-changed outcome in the JSON result. Exit 1 means the
arguments or the input path could not be used, and prints no JSON.`;

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage);
    process.exit(0);
  }
  const result = await prepareImage(args);
  console.log(JSON.stringify(result, null, 2));
  process.exit(isComplete(result) ? 0 : 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exit(1);
}
