import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { errorMessage, isToolUnavailableError, isToolUnavailableResult, type ExecBoundary, type ExecRequest, type ExecResult } from "./exec.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;

export type ReadOutputBoundary = (path: string) => Promise<Uint8Array>;
export type PrepareOutputBoundary = (path: string) => Promise<void>;
export type DiscardOutputBoundary = (path: string) => Promise<void>;

export const readOutputWithNode: ReadOutputBoundary = async (path) => readFile(path);

export const prepareOutputWithNode: PrepareOutputBoundary = async (path) => {
  await mkdir(dirname(path), { recursive: true });
};

// A run that timed out or failed may have left a truncated file behind. Partial output is never
// reported as a derivative, so it is removed rather than hashed.
export const discardOutputWithNode: DiscardOutputBoundary = async (path) => {
  await rm(path, { force: true });
};

export type ToolRun =
  | { kind: "result"; result: ExecResult }
  | { kind: "tool-unavailable"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "error"; message: string };

export interface RunToolOptions {
  // A call that can leave a partial file behind must not report a timeout until the executor has
  // settled, or cleanup races a process still writing. A call that writes nothing has no such
  // race, so it reports the timeout immediately rather than waiting on a process that may never
  // settle. Capability discovery is the second kind.
  writesOutput?: boolean;
}

// Every process this repository starts goes through here, including capability discovery. A call
// that skips it is a call with no deadline and no tool-unavailable vocabulary, which is how a
// missing binary previously escaped as an exception instead of a reportable outcome.
export async function runTool(
  exec: ExecBoundary,
  request: ExecRequest,
  timeoutMs: number,
  options: RunToolOptions = {},
): Promise<ToolRun> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<ToolRun>((resolveRace) => {
    deadline = setTimeout(
      () => resolveRace({ kind: "timeout", message: `${request.command} exceeded the ${timeoutMs} ms deadline` }),
      timeoutMs,
    );
  });
  const attempt = exec({ ...request, timeoutMs }).then(
    (result): ToolRun =>
      isToolUnavailableResult(result)
        ? { kind: "tool-unavailable", message: `${request.command} is not available in this runtime` }
        : { kind: "result", result },
    (error: unknown): ToolRun =>
      isToolUnavailableError(error)
        ? { kind: "tool-unavailable", message: `${request.command} is not available in this runtime` }
        : { kind: "error", message: errorMessage(error) },
  );
  try {
    const outcome = await Promise.race([attempt, expiry]);
    if (outcome.kind === "timeout" && (options.writesOutput ?? true)) {
      // The boundary owns killing the process on its own deadline. Waiting here keeps a caller from
      // deleting a partial derivative while the tool is still recreating it.
      await attempt.catch(() => undefined);
    }
    return outcome;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

// A derivative with no parent hash cannot be traced back to the bytes it came from, so it is not a
// derivative record at all. Reject the missing hash instead of writing a record without one.
export function assertParentSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("a derivative requires the parent SHA-256 of the original file");
  }
}

export interface MediaDerivative<TOperation extends string> {
  path: string;
  bytes: number;
  sha256: string;
  operation: TOperation;
  parentSha256: string;
}

export async function describeDerivative<TOperation extends string>(
  path: string,
  operation: TOperation,
  parentSha256: string,
  readOutput: ReadOutputBoundary,
): Promise<MediaDerivative<TOperation>> {
  const bytes = await readOutput(path);
  if (bytes.byteLength === 0) throw new Error(`${operation} produced an empty file: ${path}`);
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    operation,
    parentSha256: parentSha256.toLowerCase(),
  };
}

export function resolvePath(path: string, cwd: string): string {
  return resolve(cwd, path);
}
