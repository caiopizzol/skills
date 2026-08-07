export type AtomicPushOutcome =
  | "ok"
  | "tool-unavailable"
  | "unsupported-input"
  | "input-changed"
  | "timeout"
  | "provider-error";

export interface BranchLease {
  name: string;
  localSha: string;
  expectedRemoteSha: string;
}

export interface AtomicPushRequest {
  remote: string;
  branches: BranchLease[];
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (arguments_: readonly string[]) => Promise<GitResult>;

export type AtomicPushResult =
  | {
      outcome: "ok";
      remote: string;
      branches: Array<{ name: string; previousSha: string; pushedSha: string }>;
    }
  | { outcome: Exclude<AtomicPushOutcome, "ok">; error: string };

class PushFailure extends Error {
  constructor(
    readonly outcome: Exclude<AtomicPushOutcome, "ok">,
    message: string,
  ) {
    super(message);
  }
}

export function parseAtomicPushArguments(arguments_: readonly string[]): AtomicPushRequest {
  let remote: string | undefined;
  const branches: BranchLease[] = [];
  for (let index = 0; index < arguments_.length;) {
    const flag = arguments_[index];
    if (flag === "--remote") {
      if (remote !== undefined) throw new PushFailure("unsupported-input", "Remote was repeated");
      remote = arguments_[index + 1];
      index += 2;
      continue;
    }
    if (flag === "--branch") {
      const name = arguments_[index + 1];
      const localSha = arguments_[index + 2];
      const expectedRemoteSha = arguments_[index + 3];
      if (!name || !localSha || !expectedRemoteSha) {
        throw new PushFailure(
          "unsupported-input",
          "Each --branch requires a name, local SHA, and expected remote SHA",
        );
      }
      branches.push({ name, localSha, expectedRemoteSha });
      index += 4;
      continue;
    }
    throw new PushFailure("unsupported-input", `Unsupported argument: ${flag ?? "<missing>"}`);
  }
  return validateAtomicPushRequest({ remote: remote ?? "", branches });
}

function validateAtomicPushRequest(request: AtomicPushRequest): AtomicPushRequest {
  if (
    !request.remote ||
    request.remote.startsWith("-") ||
    hasUnsafeRemoteCharacters(request.remote)
  ) {
    throw new PushFailure("unsupported-input", "Remote must be one safe Git remote name");
  }
  if (request.branches.length === 0) {
    throw new PushFailure("unsupported-input", "At least one branch lease is required");
  }
  if (new Set(request.branches.map((branch) => branch.name)).size !== request.branches.length) {
    throw new PushFailure("unsupported-input", "Branch leases must be unique");
  }
  for (const branch of request.branches) {
    if (!isObjectId(branch.localSha) || !isObjectId(branch.expectedRemoteSha)) {
      throw new PushFailure("unsupported-input", `Branch ${branch.name} has an invalid object ID`);
    }
  }
  return request;
}

export async function pushGitHubStackAtomically(
  request: AtomicPushRequest,
  options: { runner?: GitRunner; timeoutMs?: number } = {},
): Promise<AtomicPushResult> {
  try {
    request = validateAtomicPushRequest(request);
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new PushFailure(
        "unsupported-input",
        "timeoutMs must be an integer between 1 and 300000",
      );
    }
    const runner = options.runner ?? createGitRunner(timeoutMs);
    await requireSuccess(runner, ["rev-parse", "--show-toplevel"], "Not inside a Git repository");
    for (const branch of request.branches) {
      await requireSuccess(
        runner,
        ["check-ref-format", "--branch", branch.name],
        `Invalid branch name: ${branch.name}`,
        "unsupported-input",
      );
      const local = await requireSuccess(
        runner,
        ["rev-parse", "--verify", `refs/heads/${branch.name}^{commit}`],
        `Local branch is unavailable: ${branch.name}`,
        "input-changed",
      );
      if (local.stdout.trim() !== branch.localSha) {
        throw new PushFailure("input-changed", `Local branch changed: ${branch.name}`);
      }
    }
    const remoteBefore = await readRemoteHeads(runner, request.remote, request.branches);
    for (const branch of request.branches) {
      if (remoteBefore.get(branch.name) !== branch.expectedRemoteSha) {
        throw new PushFailure("input-changed", `Remote branch changed: ${branch.name}`);
      }
    }
    const pushArguments = ["push", "--atomic", request.remote];
    for (const branch of request.branches) {
      pushArguments.push(
        `--force-with-lease=refs/heads/${branch.name}:${branch.expectedRemoteSha}`,
      );
    }
    for (const branch of request.branches) {
      pushArguments.push(`${branch.localSha}:refs/heads/${branch.name}`);
    }
    const pushed = await runner(pushArguments);
    if (pushed.exitCode !== 0) {
      const detail = safeDetail(pushed.stderr);
      throw new PushFailure(
        /stale info|atomic push failed|fetch first|rejected/i.test(detail)
          ? "input-changed"
          : "provider-error",
        `Atomic Git push failed${detail ? `: ${detail}` : ""}`,
      );
    }
    const remoteAfter = await readRemoteHeads(runner, request.remote, request.branches);
    for (const branch of request.branches) {
      if (remoteAfter.get(branch.name) !== branch.localSha) {
        throw new PushFailure("provider-error", `Remote verification failed: ${branch.name}`);
      }
    }
    return {
      outcome: "ok",
      remote: request.remote,
      branches: request.branches.map((branch) => ({
        name: branch.name,
        previousSha: branch.expectedRemoteSha,
        pushedSha: branch.localSha,
      })),
    };
  } catch (error) {
    if (error instanceof PushFailure) return { outcome: error.outcome, error: error.message };
    return {
      outcome: "provider-error",
      error: error instanceof Error ? error.message : "Unknown Git provider failure",
    };
  }
}

async function readRemoteHeads(
  runner: GitRunner,
  remote: string,
  branches: BranchLease[],
): Promise<Map<string, string>> {
  const result = await requireSuccess(
    runner,
    ["ls-remote", "--refs", remote, ...branches.map((branch) => `refs/heads/${branch.name}`)],
    "Unable to read remote branch heads",
  );
  const heads = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/);
    if (!match || heads.has(match[2]!)) {
      throw new PushFailure("provider-error", "Git returned an invalid remote ref listing");
    }
    heads.set(match[2]!, match[1]!);
  }
  for (const branch of branches) {
    if (!heads.has(branch.name)) {
      throw new PushFailure("input-changed", `Remote branch is unavailable: ${branch.name}`);
    }
  }
  return heads;
}

async function requireSuccess(
  runner: GitRunner,
  arguments_: readonly string[],
  message: string,
  outcome: Exclude<AtomicPushOutcome, "ok"> = "provider-error",
): Promise<GitResult> {
  const result = await runner(arguments_);
  if (result.exitCode !== 0) {
    const detail = safeDetail(result.stderr);
    throw new PushFailure(outcome, `${message}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function createGitRunner(timeoutMs: number): GitRunner {
  return async (arguments_) => {
    const executable = Bun.which("git");
    if (!executable) throw new PushFailure("tool-unavailable", "Git is unavailable in PATH");
    const child = Bun.spawn([executable, ...arguments_], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new PushFailure("timeout", `Git timed out after ${timeoutMs}ms`);
    return { exitCode, stdout, stderr };
  };
}

function safeDetail(value: string): string {
  return value
    .trim()
    .slice(0, 500)
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_token|token|key|signature)=)[^&\s]+/gi, "$1[redacted]");
}

function isObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function hasUnsafeRemoteCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

if (import.meta.main) {
  let result: AtomicPushResult;
  try {
    const request = parseAtomicPushArguments(process.argv.slice(2));
    result = await pushGitHubStackAtomically(request);
  } catch (error) {
    result =
      error instanceof PushFailure
        ? { outcome: error.outcome, error: error.message }
        : {
            outcome: "provider-error",
            error: error instanceof Error ? error.message : "Unknown input failure",
          };
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== "ok") process.exitCode = 1;
}
