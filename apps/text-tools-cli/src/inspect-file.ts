import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectText, type TextInspectionResult } from "@caiopizzol/text-tools";
import type { InspectArguments } from "./arguments.ts";

export async function inspectFile(
  args: InspectArguments,
  options: { cwd?: string } = {},
): Promise<TextInspectionResult> {
  const cwd = options.cwd ?? process.cwd();
  const inputPath = resolve(cwd, args.inputPath);
  const stats = await stat(inputPath);
  if (!stats.isFile()) throw new Error(`input is not a regular file: ${inputPath}`);
  return inspectText({
    inputPath,
    bytes: await readFile(inputPath),
    cwd,
    ...(args.maximumCharacters === undefined ? {} : { maximumCharacters: args.maximumCharacters }),
  });
}

// Decoding is what makes the text evidence, so a structure failure is a partial result rather than
// a failed one. Only a file that could not be decoded at all has nothing to report.
export function isComplete(result: TextInspectionResult): boolean {
  return result.outcome === "ok" && result.coverage.boundedBy === "complete";
}
