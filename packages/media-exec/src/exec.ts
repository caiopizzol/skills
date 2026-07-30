// The process boundary the media adapters share. Git execution deliberately stays out:
// packages/review-target/src/git/exec-git.ts has no deadline and no tool-unavailable vocabulary,
// and widening this contract to cover it would generalize past what either consumer needs.

export interface ExecRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecBoundary = (request: ExecRequest) => Promise<ExecResult>;

export const execWithBun: ExecBoundary = async ({ command, args, cwd, timeoutMs }) => {
  const process = Bun.spawn([command, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // The caller also enforces the deadline, but the child is killed here so a timed-out run leaves
  // no process behind writing into the caller's artifacts directory.
  const deadline =
    timeoutMs === undefined ? undefined : setTimeout(() => process.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
};

// A missing binary is not a failed run. Bun rejects the spawn, and some boundaries report the
// shell-style exit code 127 instead, so both shapes map to the same tool-unavailable outcome.
export function isToolUnavailableError(error: unknown): boolean {
  const record =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; syscall?: unknown; path?: unknown })
      : undefined;
  // ENOENT means "something in this request does not exist", which is the missing binary only when
  // the spawn itself failed. A missing cwd raises the same code and is a caller error, not an
  // absent tool, so require the spawn syscall before claiming the tool is unavailable.
  if (record?.code === "ENOENT")
    return (
      record.syscall === undefined ||
      (typeof record.syscall === "string" && record.syscall.startsWith("spawn"))
    );
  return /\benoent\b|no such file or directory|command not found|executable not found/i.test(
    errorMessage(error),
  );
}

export function isToolUnavailableResult(result: ExecResult): boolean {
  return result.exitCode === 127 && /not found|no such file or directory/i.test(result.stderr);
}

// A daemon that answers "you may not ask" is not a daemon that is absent. Keeping the two apart is
// what lets a capability report say access-denied instead of tool-unavailable.
export function isPermissionDeniedResult(result: ExecResult): boolean {
  return (
    result.exitCode !== 0 &&
    /permission denied|dial unix .*permission denied|got permission denied/i.test(result.stderr)
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
