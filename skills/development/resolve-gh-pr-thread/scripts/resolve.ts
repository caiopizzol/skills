import { readFile } from "node:fs/promises";

export type ThreadReaction = "+1" | "-1";

type FailureOutcome =
  | "tool-unavailable"
  | "unsupported-input"
  | "input-changed"
  | "timeout"
  | "provider-gap"
  | "provider-error"
  | "indeterminate";

export interface ResolveThreadRequest {
  pullRequestUrl: string;
  threadId: string;
  rootCommentId: string;
  expectedHeadSha: string;
  expectedActor: string;
  replyBody: string;
  reaction: ThreadReaction;
  resolve: true;
}

export type StepState = "applied" | "already-present" | "pending";

export interface ThreadSteps {
  reply: StepState;
  reaction: StepState;
  resolution: StepState;
}

export type ResolveThreadResult =
  | {
      outcome: "ok";
      pullRequestUrl: string;
      threadId: string;
      rootCommentId: string;
      headSha: string;
      actor: string;
      steps: ThreadSteps;
    }
  | {
      outcome: FailureOutcome | "partial";
      error: string;
      cause?: FailureOutcome;
      steps?: ThreadSteps;
    };

export type GhRunner = (arguments_: readonly string[]) => Promise<unknown>;

interface PullRequestLocator {
  owner: string;
  repository: string;
  number: number;
  canonicalUrl: string;
}

interface ThreadComment {
  id: string;
  databaseId: string;
  body: string;
  author: string;
  replyToId: string | null;
  reactions: Map<string, boolean>;
}

interface ThreadObservation {
  actor: string;
  threadId: string;
  isResolved: boolean;
  pullRequest: PullRequestLocator & { headSha: string; state: string };
  root: ThreadComment;
  comments: ThreadComment[];
}

interface OperationState {
  observation: ThreadObservation;
  hasReply: boolean;
  hasReaction: boolean;
}

class ThreadFailure extends Error {
  constructor(
    readonly outcome: FailureOutcome,
    message: string,
  ) {
    super(message);
  }
}

const OBSERVE_QUERY = `
query ObserveReviewThread($threadId: ID!) {
  viewer { login }
  node(id: $threadId) {
    __typename
    ... on PullRequestReviewThread {
      id
      isResolved
      pullRequest {
        number
        url
        headRefOid
        state
        repository { nameWithOwner }
      }
      comments(first: 100) {
        totalCount
        nodes {
          id
          databaseId
          body
          author { login }
          replyTo { id }
          reactionGroups { content viewerHasReacted }
        }
      }
    }
  }
}`;

const REPLY_MUTATION = `
mutation ReplyToReviewThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: { pullRequestReviewThreadId: $threadId, body: $body }
  ) { clientMutationId }
}`;

const REACT_MUTATION = `
mutation ReactToReviewComment($commentId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $commentId, content: $content }) {
    clientMutationId
  }
}`;

const RESOLVE_MUTATION = `
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    clientMutationId
  }
}`;

export async function parseResolveThreadArguments(
  arguments_: readonly string[],
  readText: (path: string) => Promise<string> = async (path) => readFile(path, "utf8"),
): Promise<ResolveThreadRequest> {
  const values = new Map<string, string>();
  let resolve = false;
  for (let index = 0; index < arguments_.length;) {
    const flag = arguments_[index];
    if (flag === "--resolve") {
      if (resolve) throw new ThreadFailure("unsupported-input", "--resolve was repeated");
      resolve = true;
      index += 1;
      continue;
    }
    if (!flag || !REQUIRED_VALUE_FLAGS.has(flag)) {
      throw new ThreadFailure("unsupported-input", `Unsupported argument: ${flag ?? "<missing>"}`);
    }
    if (values.has(flag)) {
      throw new ThreadFailure("unsupported-input", `${flag} was repeated`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new ThreadFailure("unsupported-input", `${flag} requires a value`);
    }
    values.set(flag, value);
    index += 2;
  }

  for (const flag of REQUIRED_VALUE_FLAGS) {
    if (!values.has(flag)) throw new ThreadFailure("unsupported-input", `${flag} is required`);
  }
  if (!resolve) {
    throw new ThreadFailure(
      "unsupported-input",
      "Explicit --resolve authorization is required before any mutation",
    );
  }

  let replyBody: string;
  try {
    replyBody = await readText(requiredValue(values, "--reply-file"));
  } catch (error) {
    throw new ThreadFailure(
      "unsupported-input",
      `Unable to read --reply-file: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  return validateRequest({
    pullRequestUrl: requiredValue(values, "--pr"),
    threadId: requiredValue(values, "--thread-id"),
    rootCommentId: requiredValue(values, "--root-comment-id"),
    expectedHeadSha: requiredValue(values, "--expected-head-sha"),
    expectedActor: requiredValue(values, "--expected-actor"),
    replyBody,
    reaction: requiredValue(values, "--reaction") as ThreadReaction,
    resolve: true,
  });
}

const REQUIRED_VALUE_FLAGS = new Set([
  "--pr",
  "--thread-id",
  "--root-comment-id",
  "--expected-head-sha",
  "--expected-actor",
  "--reply-file",
  "--reaction",
]);

export async function resolveGitHubPullRequestThread(
  request: ResolveThreadRequest,
  options: { runner?: GhRunner; timeoutMs?: number } = {},
): Promise<ResolveThreadResult> {
  const steps: ThreadSteps = { reply: "pending", reaction: "pending", resolution: "pending" };
  try {
    request = validateRequest(request);
    const locator = parseGitHubPullRequestUrl(request.pullRequestUrl);
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new ThreadFailure(
        "unsupported-input",
        "timeoutMs must be an integer between 1 and 300000",
      );
    }
    const runner = options.runner ?? createGhRunner(timeoutMs);
    let state = await readAndValidateState(runner, request, locator);

    steps.reply = state.hasReply ? "already-present" : "pending";
    steps.reaction = state.hasReaction ? "already-present" : "pending";
    steps.resolution = state.observation.isResolved ? "already-present" : "pending";

    if (state.observation.isResolved && (!state.hasReply || !state.hasReaction)) {
      throw new ThreadFailure(
        "input-changed",
        "Review thread is already resolved without the requested reply and reaction",
      );
    }

    if (!state.hasReply) {
      state = await mutateAndVerify(
        runner,
        request,
        locator,
        [
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          `query=${REPLY_MUTATION}`,
          "-f",
          `threadId=${request.threadId}`,
          "-f",
          `body=${request.replyBody}`,
        ],
        (current) => current.hasReply,
        "reply",
      );
      steps.reply = "applied";
    }

    if (!state.hasReaction) {
      state = await mutateAndVerify(
        runner,
        request,
        locator,
        [
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          `query=${REACT_MUTATION}`,
          "-f",
          `commentId=${state.observation.root.id}`,
          "-f",
          `content=${reactionContent(request.reaction)}`,
        ],
        (current) => current.hasReaction,
        "reaction",
      );
      steps.reaction = "applied";
    }

    if (!state.observation.isResolved) {
      state = await mutateAndVerify(
        runner,
        request,
        locator,
        [
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          `query=${RESOLVE_MUTATION}`,
          "-f",
          `threadId=${request.threadId}`,
        ],
        (current) => current.observation.isResolved,
        "resolution",
      );
      steps.resolution = "applied";
    }

    return {
      outcome: "ok",
      pullRequestUrl: locator.canonicalUrl,
      threadId: request.threadId,
      rootCommentId: request.rootCommentId,
      headSha: state.observation.pullRequest.headSha,
      actor: state.observation.actor,
      steps,
    };
  } catch (error) {
    const failure = asFailure(error);
    if (failure.outcome === "indeterminate") {
      return { outcome: "indeterminate", error: failure.message, steps };
    }
    const mutated = Object.values(steps).some((step) => step === "applied");
    if (mutated) {
      return {
        outcome: "partial",
        cause: failure.outcome,
        error: failure.message,
        steps,
      };
    }
    return { outcome: failure.outcome, error: failure.message, steps };
  }
}

async function mutateAndVerify(
  runner: GhRunner,
  request: ResolveThreadRequest,
  locator: PullRequestLocator,
  mutationArguments: readonly string[],
  isApplied: (state: OperationState) => boolean,
  step: "reply" | "reaction" | "resolution",
): Promise<OperationState> {
  let mutationFailure: ThreadFailure | undefined;
  try {
    await runner(mutationArguments);
  } catch (error) {
    mutationFailure = asFailure(error);
  }

  let state: OperationState;
  try {
    state = await readAndValidateState(runner, request, locator);
  } catch (error) {
    const verificationFailure = asFailure(error);
    throw new ThreadFailure(
      "indeterminate",
      `${capitalize(step)} state is unknown after mutation attempt: ${verificationFailure.message}`,
    );
  }

  if (isApplied(state)) return state;
  if (mutationFailure) throw mutationFailure;
  throw new ThreadFailure("provider-error", `${capitalize(step)} mutation was not observable`);
}

async function readAndValidateState(
  runner: GhRunner,
  request: ResolveThreadRequest,
  locator: PullRequestLocator,
): Promise<OperationState> {
  const observation = parseObservation(
    await runner([
      "api",
      "--hostname",
      "github.com",
      "graphql",
      "-f",
      `query=${OBSERVE_QUERY}`,
      "-f",
      `threadId=${request.threadId}`,
    ]),
  );
  validateObservation(observation, request, locator);
  const normalizedReply = normalizeBody(request.replyBody);
  const hasReply = observation.comments.some(
    (comment) =>
      comment.replyToId === observation.root.id &&
      sameLogin(comment.author, observation.actor) &&
      normalizeBody(comment.body) === normalizedReply,
  );
  const hasReaction = observation.root.reactions.get(reactionContent(request.reaction)) === true;
  return { observation, hasReply, hasReaction };
}

function parseObservation(value: unknown): ThreadObservation {
  const response = record(value, "GraphQL response");
  const data = record(response.data, "GraphQL data");
  const viewer = record(data.viewer, "authenticated viewer");
  const actor = textField(viewer.login, "authenticated viewer login");
  const node = record(data.node, "review thread");
  if (node.__typename !== "PullRequestReviewThread") {
    throw new ThreadFailure("input-changed", "Thread ID does not identify a review thread");
  }
  const pullRequest = record(node.pullRequest, "thread pull request");
  const repository = record(pullRequest.repository, "thread repository");
  const nameWithOwner = textField(repository.nameWithOwner, "repository name");
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ThreadFailure("provider-error", "GitHub returned an invalid repository name");
  }
  const connection = record(node.comments, "thread comments");
  const nodes = arrayField(connection.nodes, "thread comments");
  const totalCount = integerField(connection.totalCount, "thread comment count");
  if (totalCount !== nodes.length) {
    throw new ThreadFailure(
      "provider-gap",
      `Review thread has ${totalCount} comments but only ${nodes.length} were retrieved`,
    );
  }
  const comments = nodes.map(parseComment);
  const roots = comments.filter((comment) => comment.replyToId === null);
  if (roots.length !== 1 || comments[0]?.id !== roots[0]?.id) {
    throw new ThreadFailure("provider-error", "GitHub returned an invalid review thread root");
  }
  return {
    actor,
    threadId: textField(node.id, "review thread ID"),
    isResolved: booleanField(node.isResolved, "review thread resolution"),
    pullRequest: {
      owner: parts[0],
      repository: parts[1],
      number: integerField(pullRequest.number, "pull request number"),
      canonicalUrl: textField(pullRequest.url, "pull request URL"),
      headSha: textField(pullRequest.headRefOid, "pull request head SHA"),
      state: textField(pullRequest.state, "pull request state"),
    },
    root: roots[0],
    comments,
  };
}

function parseComment(value: unknown): ThreadComment {
  const comment = record(value, "review comment");
  const author = record(comment.author, "review comment author");
  const replyTo = comment.replyTo === null ? null : record(comment.replyTo, "reply target");
  const reactions = new Map<string, boolean>();
  for (const value_ of arrayField(comment.reactionGroups, "review comment reactions")) {
    const group = record(value_, "review comment reaction");
    const content = textField(group.content, "reaction content");
    if (reactions.has(content)) {
      throw new ThreadFailure("provider-error", "GitHub returned a duplicate reaction group");
    }
    reactions.set(content, booleanField(group.viewerHasReacted, "viewer reaction state"));
  }
  return {
    id: textField(comment.id, "review comment ID"),
    databaseId: databaseId(comment.databaseId),
    body: textField(comment.body, "review comment body", true),
    author: textField(author.login, "review comment author login"),
    replyToId: replyTo ? textField(replyTo.id, "reply target ID") : null,
    reactions,
  };
}

function validateObservation(
  observation: ThreadObservation,
  request: ResolveThreadRequest,
  locator: PullRequestLocator,
): void {
  if (observation.threadId !== request.threadId) {
    throw new ThreadFailure("input-changed", "GitHub returned a different review thread");
  }
  if (!sameLogin(observation.actor, request.expectedActor)) {
    throw new ThreadFailure(
      "input-changed",
      `Authenticated GitHub user is ${observation.actor}, expected ${request.expectedActor}`,
    );
  }
  const actual = observation.pullRequest;
  if (
    !sameLogin(actual.owner, locator.owner) ||
    actual.repository.toLowerCase() !== locator.repository.toLowerCase() ||
    actual.number !== locator.number
  ) {
    throw new ThreadFailure(
      "input-changed",
      "Review thread does not belong to the specified pull request",
    );
  }
  if (actual.state !== "OPEN") {
    throw new ThreadFailure("input-changed", `Pull request is ${actual.state.toLowerCase()}`);
  }
  if (actual.headSha !== request.expectedHeadSha) {
    throw new ThreadFailure("input-changed", "Pull request head changed after assessment");
  }
  if (observation.root.databaseId !== request.rootCommentId) {
    throw new ThreadFailure(
      "input-changed",
      "Supplied root comment does not match the review thread root",
    );
  }
}

export function parseGitHubPullRequestUrl(value: string): PullRequestLocator {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ThreadFailure("unsupported-input", "PR must be one exact HTTPS GitHub URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ThreadFailure("unsupported-input", "PR must be one exact HTTPS github.com URL");
  }
  const match = url.pathname.match(
    /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)\/?$/,
  );
  if (!match) {
    throw new ThreadFailure("unsupported-input", "PR URL must identify one GitHub pull request");
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) {
    throw new ThreadFailure("unsupported-input", "PR number is outside the supported range");
  }
  return {
    owner: match[1],
    repository: match[2],
    number,
    canonicalUrl: `https://github.com/${match[1]}/${match[2]}/pull/${number}`,
  };
}

function validateRequest(request: ResolveThreadRequest): ResolveThreadRequest {
  parseGitHubPullRequestUrl(request.pullRequestUrl);
  if (
    request.threadId.length === 0 ||
    request.threadId.length > 256 ||
    hasUnsafeIdentifierCharacters(request.threadId)
  ) {
    throw new ThreadFailure("unsupported-input", "Thread ID is invalid");
  }
  if (!/^[1-9][0-9]*$/.test(request.rootCommentId)) {
    throw new ThreadFailure("unsupported-input", "Root comment ID must be a positive integer");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.expectedHeadSha)) {
    throw new ThreadFailure("unsupported-input", "Expected head SHA is invalid");
  }
  const actorBase = request.expectedActor.endsWith("[bot]")
    ? request.expectedActor.slice(0, -5)
    : request.expectedActor;
  if (
    actorBase.length === 0 ||
    actorBase.length > 100 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(actorBase)
  ) {
    throw new ThreadFailure("unsupported-input", "Expected actor is not a GitHub login");
  }
  if (request.reaction !== "+1" && request.reaction !== "-1") {
    throw new ThreadFailure("unsupported-input", "Reaction must be +1 or -1");
  }
  if (request.resolve !== true) {
    throw new ThreadFailure("unsupported-input", "Explicit resolve authorization is required");
  }
  const bodyBytes = new TextEncoder().encode(request.replyBody).byteLength;
  if (
    normalizeBody(request.replyBody).length === 0 ||
    bodyBytes > 65_536 ||
    request.replyBody.includes("\0")
  ) {
    throw new ThreadFailure(
      "unsupported-input",
      "Reply body must contain 1 to 65536 safe UTF-8 bytes",
    );
  }
  return request;
}

function reactionContent(reaction: ThreadReaction): "THUMBS_UP" | "THUMBS_DOWN" {
  return reaction === "+1" ? "THUMBS_UP" : "THUMBS_DOWN";
}

function createGhRunner(timeoutMs: number): GhRunner {
  return async (arguments_) => {
    const executable = Bun.which("gh");
    if (!executable)
      throw new ThreadFailure("tool-unavailable", "GitHub CLI is unavailable in PATH");
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
    if (timedOut) throw new ThreadFailure("timeout", `GitHub CLI timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) {
      throw new ThreadFailure(
        "provider-error",
        `GitHub CLI failed${stderr.trim() ? `: ${safeDetail(stderr)}` : ""}`,
      );
    }
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new ThreadFailure("provider-error", "GitHub CLI returned invalid JSON");
    }
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreadFailure("provider-error", `GitHub returned an invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function arrayField(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ThreadFailure("provider-error", `GitHub returned invalid ${label}`);
  }
  return value;
}

function textField(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new ThreadFailure("provider-error", `GitHub returned an invalid ${label}`);
  }
  return value;
}

function integerField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ThreadFailure("provider-error", `GitHub returned an invalid ${label}`);
  }
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ThreadFailure("provider-error", `GitHub returned an invalid ${label}`);
  }
  return value;
}

function databaseId(value: unknown): string {
  if (
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) &&
    (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
  ) {
    throw new ThreadFailure("provider-error", "GitHub returned an invalid root comment ID");
  }
  return String(value);
}

function requiredValue(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new ThreadFailure("unsupported-input", `${flag} is required`);
  return value;
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function hasUnsafeIdentifierCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function asFailure(error: unknown): ThreadFailure {
  if (error instanceof ThreadFailure) return error;
  return new ThreadFailure(
    "provider-error",
    error instanceof Error ? error.message : "Unknown GitHub provider failure",
  );
}

function safeDetail(value: string): string {
  return value
    .trim()
    .slice(0, 500)
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_token|token|key|signature)=)[^&\s]+/gi, "$1[redacted]");
}

if (import.meta.main) {
  let result: ResolveThreadResult;
  try {
    const request = await parseResolveThreadArguments(process.argv.slice(2));
    result = await resolveGitHubPullRequestThread(request);
  } catch (error) {
    const failure = asFailure(error);
    result = { outcome: failure.outcome, error: failure.message };
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== "ok") process.exitCode = 1;
}
