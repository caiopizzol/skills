import { realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

// Resolve through symlinks as far as the path exists. A lexical comparison alone lets a symlinked
// artifacts ancestor alias the input, after which failure cleanup would delete the original.
function realOrLexical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    try {
      return resolve(realpathSync(parent), path.slice(parent.length + 1));
    } catch {
      return path;
    }
  }
}

// The original is evidence. Every operation writes beneath the caller's artifacts directory, and a
// destination that resolves onto the input is rejected before any argv is built.
export function resolveWriteTarget(options: {
  inputPath: string;
  artifactsDirectory: string;
  relativePath: string;
  cwd: string;
}): string {
  const inputPath = resolve(options.cwd, options.inputPath);
  const artifactsDirectory = resolve(options.cwd, options.artifactsDirectory);
  const outputPath = resolve(artifactsDirectory, options.relativePath);
  const containment = relative(artifactsDirectory, outputPath);
  if (containment === "" || containment.startsWith("..") || containment.split(sep).includes("..")) {
    throw new Error(`a derivative must be written beneath the artifacts directory: ${options.relativePath}`);
  }
  if (outputPath === inputPath) throw new Error("a derivative must never be written onto the original file");
  if (realOrLexical(outputPath) === realOrLexical(inputPath)) {
    throw new Error("a derivative must never be written onto the original file");
  }
  return outputPath;
}
