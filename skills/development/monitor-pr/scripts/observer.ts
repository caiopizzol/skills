export type SnapshotOutcome =
  | "ok"
  | "tool-unavailable"
  | "timeout"
  | "unsupported-input"
  | "provider-error";

export type GhRunner = (arguments_: readonly string[]) => Promise<unknown>;

export interface GitHubPullRequestLocator {
  owner: string;
  repository: string;
  number: number;
  canonicalUrl: string;
}

export interface CheckSnapshot {
  type: "check-run" | "status-context";
  name: string;
  workflow: string | null;
  status: string;
  conclusion: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PullRequestSnapshot {
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  autoMergeEnabled: boolean;
  updatedAt: string;
  checks: CheckSnapshot[];
  supersededChecks: CheckSnapshot[];
}

export interface PullRequestStateSnapshot {
  schemaVersion: "1.1";
  requested: GitHubPullRequestLocator;
  authenticatedAccount: string;
  scope:
    | { kind: "pull-request" }
    | { kind: "stack"; number: number; id: number; baseRef: string; open: boolean };
  pullRequests: PullRequestSnapshot[];
}

export type SnapshotResult =
  | { outcome: "ok"; snapshot: PullRequestStateSnapshot }
  | { outcome: Exclude<SnapshotOutcome, "ok">; error: string };

export interface ObserveOptions {
  runner?: GhRunner;
  timeoutMs?: number;
  includeManagedStack?: boolean;
}

class SnapshotFailure extends Error {
  constructor(
    readonly outcome: Exclude<SnapshotOutcome, "ok">,
    message: string,
  ) {
    super(message);
  }
}

export function parseGitHubPullRequestUrl(input: string): GitHubPullRequestLocator {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SnapshotFailure(
      "unsupported-input",
      "Input must be one exact HTTPS GitHub pull request URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new SnapshotFailure(
      "unsupported-input",
      "Input must be one exact HTTPS GitHub pull request URL",
    );
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new SnapshotFailure("unsupported-input", "GitHub URL must identify one pull request");
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) {
    throw new SnapshotFailure("unsupported-input", "GitHub pull request number is too large");
  }
  return {
    owner: match[1]!,
    repository: match[2]!,
    number,
    canonicalUrl: `https://github.com/${match[1]}/${match[2]}/pull/${number}`,
  };
}

export async function observeGitHubPullRequest(
  input: string,
  options: ObserveOptions = {},
): Promise<SnapshotResult> {
  try {
    const requested = parseGitHubPullRequestUrl(input);
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new SnapshotFailure(
        "unsupported-input",
        "timeoutMs must be an integer between 1 and 120000",
      );
    }
    const runner = options.runner ?? createDefaultGhRunner(timeoutMs);
    const includeManagedStack = options.includeManagedStack ?? true;
    const identity = record(
      await runner(["api", "--hostname", "github.com", "user"]),
      "GitHub authenticated identity",
    );
    const authenticatedAccount = requiredString(identity.login, "GitHub authenticated account");
    let scope: PullRequestStateSnapshot["scope"] = { kind: "pull-request" };
    let pullRequestNumbers = [requested.number];
    if (includeManagedStack) {
      const stackRaw = await runner([
        "api",
        "--hostname",
        "github.com",
        `repos/${encode(requested.owner)}/${encode(requested.repository)}/stacks?pull_request=${requested.number}`,
      ]);
      const stacks = array(stackRaw, "GitHub Stack lookup");
      if (stacks.length > 1) {
        throw new SnapshotFailure(
          "provider-error",
          "GitHub returned multiple managed Stacks for the pull request",
        );
      }
      if (stacks.length === 1) {
        const stack = record(stacks[0], "GitHub Stack");
        const members = array(stack.pull_requests, "GitHub Stack pull requests");
        pullRequestNumbers = members.map((member, index) =>
          requiredPositiveInteger(
            record(member, `GitHub Stack member ${index + 1}`).number,
            "number",
          ),
        );
        if (new Set(pullRequestNumbers).size !== pullRequestNumbers.length) {
          throw new SnapshotFailure(
            "provider-error",
            "GitHub Stack contains duplicate pull requests",
          );
        }
        if (!pullRequestNumbers.includes(requested.number)) {
          throw new SnapshotFailure(
            "provider-error",
            "GitHub Stack lookup did not include the requested pull request",
          );
        }
        const base = record(stack.base, "GitHub Stack base");
        scope = {
          kind: "stack",
          number: requiredPositiveInteger(stack.number, "GitHub Stack number"),
          id: requiredPositiveInteger(stack.id, "GitHub Stack id"),
          baseRef: requiredString(base.ref, "GitHub Stack base ref"),
          open: requiredBoolean(stack.open, "GitHub Stack open state"),
        };
      }
    }

    const pullRequests: PullRequestSnapshot[] = [];
    for (const number of pullRequestNumbers) {
      const raw = await runner([
        "pr",
        "view",
        String(number),
        "--repo",
        `github.com/${requested.owner}/${requested.repository}`,
        "--json",
        "number,url,title,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup,updatedAt",
      ]);
      pullRequests.push(normalizePullRequest(raw, requested, number));
    }

    return {
      outcome: "ok",
      snapshot: {
        schemaVersion: "1.1",
        requested,
        authenticatedAccount,
        scope,
        pullRequests,
      },
    };
  } catch (error) {
    if (error instanceof SnapshotFailure) return { outcome: error.outcome, error: error.message };
    return {
      outcome: "provider-error",
      error: error instanceof Error ? error.message : "Unknown GitHub provider failure",
    };
  }
}

function normalizePullRequest(
  input: unknown,
  requested: GitHubPullRequestLocator,
  expectedNumber: number,
): PullRequestSnapshot {
  const raw = record(input, `GitHub pull request #${expectedNumber}`);
  const number = requiredPositiveInteger(raw.number, "pull request number");
  if (number !== expectedNumber) {
    throw new SnapshotFailure("provider-error", "GitHub returned a different pull request number");
  }
  const url = requiredString(raw.url, "pull request URL");
  const resolved = parseGitHubPullRequestUrl(url);
  if (
    resolved.owner.toLowerCase() !== requested.owner.toLowerCase() ||
    resolved.repository.toLowerCase() !== requested.repository.toLowerCase() ||
    resolved.number !== expectedNumber
  ) {
    throw new SnapshotFailure(
      "provider-error",
      "GitHub returned a pull request from another repository",
    );
  }
  const normalizedChecks = normalizeChecks(raw.statusCheckRollup);
  return {
    number,
    url: resolved.canonicalUrl,
    title: requiredString(raw.title, "pull request title"),
    state: requiredString(raw.state, "pull request state"),
    draft: requiredBoolean(raw.isDraft, "pull request draft state"),
    base: {
      ref: requiredString(raw.baseRefName, "pull request base ref"),
      sha: requiredString(raw.baseRefOid, "pull request base SHA"),
    },
    head: {
      ref: requiredString(raw.headRefName, "pull request head ref"),
      sha: requiredString(raw.headRefOid, "pull request head SHA"),
    },
    mergeable: requiredString(raw.mergeable, "pull request mergeable state"),
    mergeStateStatus: requiredString(raw.mergeStateStatus, "pull request merge state status"),
    reviewDecision: optionalString(raw.reviewDecision, "pull request review decision"),
    autoMergeEnabled: raw.autoMergeRequest !== null && raw.autoMergeRequest !== undefined,
    updatedAt: requiredString(raw.updatedAt, "pull request update time"),
    checks: normalizedChecks.current,
    supersededChecks: normalizedChecks.superseded,
  };
}

function normalizeChecks(input: unknown): {
  current: CheckSnapshot[];
  superseded: CheckSnapshot[];
} {
  const checks = array(input, "pull request check rollup").map((entry, index) => {
    const raw = record(entry, `pull request check ${index + 1}`);
    const type = requiredString(raw.__typename, "pull request check type");
    if (type === "CheckRun") {
      return {
        type: "check-run" as const,
        name: requiredString(raw.name, "check run name"),
        workflow: optionalString(raw.workflowName, "check run workflow"),
        status: requiredString(raw.status, "check run status"),
        conclusion: optionalString(raw.conclusion, "check run conclusion"),
        url: optionalString(raw.detailsUrl, "check run URL"),
        startedAt: optionalString(raw.startedAt, "check run start time"),
        completedAt: optionalString(raw.completedAt, "check run completion time"),
      };
    }
    if (type === "StatusContext") {
      return {
        type: "status-context" as const,
        name: requiredString(raw.context, "status context name"),
        workflow: null,
        status: requiredString(raw.state, "status context state"),
        conclusion: null,
        url: optionalString(raw.targetUrl, "status context URL"),
        startedAt: null,
        completedAt: null,
      };
    }
    throw new SnapshotFailure("provider-error", `Unsupported GitHub check type: ${type}`);
  });
  const current: CheckSnapshot[] = [];
  const superseded: CheckSnapshot[] = [];
  const runsByIdentity = new Map<string, CheckSnapshot[]>();
  for (const check of checks) {
    if (check.type === "status-context") {
      current.push(check);
      continue;
    }
    const identity = [check.workflow ?? "", check.name].join("\0");
    const group = runsByIdentity.get(identity) ?? [];
    group.push(check);
    runsByIdentity.set(identity, group);
  }
  for (const group of runsByIdentity.values()) {
    group.sort(compareCheckRecency);
    const latest = group.pop();
    if (latest) current.push(latest);
    superseded.push(...group);
  }
  return {
    current: sortChecks(current),
    superseded: sortChecks(superseded),
  };
}

function sortChecks(checks: CheckSnapshot[]): CheckSnapshot[] {
  return checks.sort((left, right) =>
    compareCodeUnits(
      [left.name, left.workflow ?? "", left.type, left.url ?? ""].join("\0"),
      [right.name, right.workflow ?? "", right.type, right.url ?? ""].join("\0"),
    ),
  );
}

function compareCheckRecency(left: CheckSnapshot, right: CheckSnapshot): number {
  if (left.startedAt !== null && right.startedAt !== null) {
    const started = compareCodeUnits(left.startedAt, right.startedAt);
    if (started !== 0) return started;
  }
  const sequence = compareNumericStrings(
    githubActionsRunSequence(left.url),
    githubActionsRunSequence(right.url),
  );
  if (sequence !== 0) return sequence;
  const leftActive = left.status !== "COMPLETED";
  const rightActive = right.status !== "COMPLETED";
  if (leftActive !== rightActive) return leftActive ? 1 : -1;
  return compareCodeUnits(
    [left.startedAt ?? "", left.completedAt ?? "", left.url ?? ""].join("\0"),
    [right.startedAt ?? "", right.completedAt ?? "", right.url ?? ""].join("\0"),
  );
}

function githubActionsRunSequence(url: string | null): string {
  return (
    url?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/([1-9]\d*)(?:\/|$)/)?.[1] ?? ""
  );
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareCodeUnits(left, right);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createDefaultGhRunner(timeoutMs: number): GhRunner {
  return async (arguments_) => {
    const executable = Bun.which("gh");
    if (!executable) {
      throw new SnapshotFailure("tool-unavailable", "GitHub CLI is unavailable in PATH");
    }
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
    if (timedOut) {
      throw new SnapshotFailure("timeout", `GitHub CLI timed out after ${timeoutMs}ms`);
    }
    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, 500);
      throw new SnapshotFailure(
        "provider-error",
        detail.includes("HTTP 404")
          ? "GitHub resource is missing or inaccessible"
          : `GitHub CLI failed${detail ? `: ${detail}` : ""}`,
      );
    }
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new SnapshotFailure("provider-error", "GitHub CLI returned invalid JSON");
    }
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotFailure("provider-error", `${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SnapshotFailure("provider-error", `${label} was not an array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SnapshotFailure("provider-error", `${label} was missing`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new SnapshotFailure("provider-error", `${label} was not a string`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new SnapshotFailure("provider-error", `${label} was missing`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SnapshotFailure("provider-error", `${label} was not a positive integer`);
  }
  return value;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}
