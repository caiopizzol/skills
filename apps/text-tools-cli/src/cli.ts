#!/usr/bin/env bun
import { parseArguments } from "./arguments.ts";
import { inspectFile, isComplete } from "./inspect-file.ts";

const usage = `Usage:
  text-tools inspect <text-path> [--max-characters <count>]

Reads the file, hashes its bytes, decodes strict UTF-8 or BOM-declared UTF-16, identifies its
format, validates JSON and CSV structure, and retains exact head and tail character ranges under
the bound. It never uses the network and writes nothing.

Exit 0 means the file decoded, parsed, and was retained in full. Exit 2 preserves an undecodable,
structurally invalid, or bounded-partial outcome in the JSON result. Exit 1 means the arguments or
the input path could not be used, and prints no JSON.`;

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage);
    process.exit(0);
  }
  const result = await inspectFile(args);
  console.log(JSON.stringify(result, null, 2));
  process.exit(isComplete(result) ? 0 : 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exit(1);
}
