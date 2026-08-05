import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const API_VERSION = "2022-11-28";
const ATTACHMENT_HOSTS = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
  "user-images.githubusercontent.com",
]);

export type GitHubResourceKind = "issue" | "pull_request";
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type GhRunner = (arguments_: readonly string[]) => Promise<unknown>;

export interface GitHubLocator {
  owner: string;
  repository: string;
  number: number;
  requestedKind: GitHubResourceKind;
  requestedUrl: string;
  canonicalUrl: string;
}

interface Actor {
  login: string;
  id: number | null;
  type: string | null;
}

interface Comment {
  id: number;
  nodeId: string;
  author: Actor | null;
  authorAssociation: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface Review {
  id: number;
  nodeId: string;
  author: Actor | null;
  authorAssociation: string | null;
  state: string;
  body: string;
  commitId: string | null;
  submittedAt: string | null;
  url: string;
}

interface ReviewComment extends Comment {
  path: string;
  commitId: string;
  originalCommitId: string;
  inReplyToId: number | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  startLine: number | null;
  diffHunk: string;
}

interface ReviewThread {
  id: string;
  resolved: boolean;
  outdated: boolean;
  commentIds: number[];
}

interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  previousPath: string | null;
  blobUrl: string;
  rawUrl: string;
  patch: string | null;
}

interface GitHubAttachmentBase {
  identity: string;
  originalName: string;
  sourceLocations: string[];
}

interface RetrievedAttachment extends GitHubAttachmentBase {
  status: "retrieved";
  localPath: string;
  detectedMime: string;
  bytes: number;
  sha256: string;
}

interface UnreadAttachment extends GitHubAttachmentBase {
  status: "failed" | "unsupported";
  error: string;
}

export type GitHubAttachment = RetrievedAttachment | UnreadAttachment;

export interface GitHubCollection {
  schemaVersion: "1.0";
  generatedAt: string;
  requested: GitHubLocator;
  authenticatedAccount: string;
  repository: { owner: string; name: string; private: boolean };
  resource: {
    kind: GitHubResourceKind;
    id: number;
    nodeId: string;
    number: number;
    title: string;
    state: string;
    stateReason: string | null;
    author: Actor | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    url: string;
    labels: string[];
    assignees: Actor[];
  };
  pullRequest: {
    draft: boolean;
    merged: boolean;
    mergedAt: string | null;
    base: { ref: string; sha: string };
    head: { ref: string; sha: string };
    additions: number;
    deletions: number;
    changedFileCount: number;
    commitCount: number;
  } | null;
  issueComments: Comment[];
  reviews: Review[];
  reviewComments: ReviewComment[];
  reviewThreads: ReviewThread[];
  changedFiles: ChangedFile[];
  laneCompleteness: {
    issueComments: boolean;
    pullRequest: boolean | null;
    reviews: boolean | null;
    reviewComments: boolean | null;
    reviewThreads: boolean | null;
    changedFiles: boolean | null;
  };
  externalReferences: string[];
  attachments: GitHubAttachment[];
  gaps: string[];
  runDirectory: string;
  contextPath: string;
}

export interface CollectGitHubOptions {
  expectedKind: GitHubResourceKind;
  artifactsDirectory: string;
  runner?: GhRunner;
  fetcher?: Fetcher;
  now?: () => Date;
  limits?: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
}

interface EvidenceSource {
  location: string;
  body: string;
  bodyHtml: string;
}

interface PendingAttachment extends GitHubAttachmentBase {
  originalUrl: string | null;
  signedUrl: string | null;
}

export function parseGitHubResourceUrl(input: string): GitHubLocator {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("GitHub input must be one exact HTTPS issue or pull request URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("GitHub input must be one exact HTTPS issue or pull request URL");
  }
  const match = url.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9]\d*)\/?$/,
  );
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..")
    throw new Error("GitHub URL must identify one issue or pull request");
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number))
    throw new Error("GitHub issue or pull request number is too large");
  const requestedKind = match[3] === "pull" ? "pull_request" : "issue";
  const canonicalUrl = `https://github.com/${match[1]}/${match[2]}/${match[3]}/${number}`;
  return {
    owner: match[1]!,
    repository: match[2]!,
    number,
    requestedKind,
    requestedUrl: sanitizeReference(url.toString(), true)!,
    canonicalUrl,
  };
}

export async function collectGitHubResource(
  input: string,
  options: CollectGitHubOptions,
): Promise<GitHubCollection> {
  const requested = parseGitHubResourceUrl(input);
  if (requested.requestedKind !== options.expectedKind)
    throw new Error(
      options.expectedKind === "issue"
        ? "GitHub pull request URL must be routed to read-github-pr"
        : "GitHub issue URL must be routed to read-github-issue",
    );
  const runner = options.runner ?? defaultGhRunner;
  const fetcher = options.fetcher ?? fetch;
  const limits = options.limits ?? {
    maxFiles: DEFAULT_MAX_FILES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  };
  validateLimits(limits);

  const identity = record(await ghObject(runner, "user"), "GitHub authenticated identity");
  const authenticatedAccount = requiredString(identity.login, "GitHub authenticated login");
  const repositoryRaw = record(
    await ghObject(runner, `repos/${encode(requested.owner)}/${encode(requested.repository)}`),
    "GitHub repository",
  );
  const fullName = requiredString(repositoryRaw.full_name, "GitHub repository full name");
  if (fullName.toLowerCase() !== `${requested.owner}/${requested.repository}`.toLowerCase())
    throw new Error("GitHub returned a different repository than the requested URL");

  const rootRaw = record(
    await ghObject(
      runner,
      `repos/${encode(requested.owner)}/${encode(requested.repository)}/issues/${requested.number}`,
    ),
    "GitHub issue resource",
  );
  const resolvedKind: GitHubResourceKind = isRecord(rootRaw.pull_request)
    ? "pull_request"
    : "issue";
  if (resolvedKind !== options.expectedKind)
    throw new Error(
      options.expectedKind === "issue"
        ? "GitHub issue URL resolved to a pull request"
        : "GitHub pull request URL resolved to an issue",
    );
  const resource = parseResource(rootRaw, resolvedKind);
  if (resource.number !== requested.number)
    throw new Error("GitHub returned a different resource number than the requested URL");

  const gaps: string[] = [];
  const sources: EvidenceSource[] = [bodySource(`${resolvedKind}.body`, rootRaw)];
  const issueCommentRaw = await ghPages(
    runner,
    `repos/${encode(requested.owner)}/${encode(requested.repository)}/issues/${requested.number}/comments?per_page=100`,
  );
  const issueComments = issueCommentRaw.map(parseComment).sort(compareCreated);
  issueCommentRaw.forEach((value, index) =>
    sources.push(bodySource(`issueComments[${index}].body`, value)),
  );
  const expectedIssueComments = integer(rootRaw.comments, "GitHub issue comment count");
  const issueCommentsComplete = issueComments.length === expectedIssueComments;
  if (!issueCommentsComplete)
    gaps.push(
      `GitHub reported ${expectedIssueComments} issue comments but retrieved ${issueComments.length}`,
    );

  let pullRequest: GitHubCollection["pullRequest"] = null;
  let reviews: Review[] = [];
  let reviewComments: ReviewComment[] = [];
  let reviewThreads: ReviewThread[] = [];
  let changedFiles: ChangedFile[] = [];
  let pullRequestComplete: boolean | null = null;
  let reviewsComplete: boolean | null = null;
  let reviewCommentsComplete: boolean | null = null;
  let reviewThreadsComplete: boolean | null = null;
  let changedFilesComplete: boolean | null = null;
  if (resolvedKind === "pull_request") {
    const pullRaw = record(
      await ghObject(
        runner,
        `repos/${encode(requested.owner)}/${encode(requested.repository)}/pulls/${requested.number}`,
      ),
      "GitHub pull request",
    );
    pullRequest = parsePullRequest(pullRaw);
    pullRequestComplete = true;
    sources.push(bodySource("pullRequest.body", pullRaw));

    const reviewRaw = await ghPages(
      runner,
      `repos/${encode(requested.owner)}/${encode(requested.repository)}/pulls/${requested.number}/reviews?per_page=100`,
    );
    reviews = reviewRaw.map(parseReview).sort(compareSubmitted);
    reviewRaw.forEach((value, index) => sources.push(bodySource(`reviews[${index}].body`, value)));
    reviewsComplete = true;

    const reviewCommentRaw = await ghPages(
      runner,
      `repos/${encode(requested.owner)}/${encode(requested.repository)}/pulls/${requested.number}/comments?per_page=100`,
    );
    reviewComments = reviewCommentRaw.map(parseReviewComment).sort(compareCreated);
    reviewCommentRaw.forEach((value, index) =>
      sources.push(bodySource(`reviewComments[${index}].body`, value)),
    );
    const expectedReviewComments = integer(
      pullRaw.review_comments,
      "GitHub inline review comment count",
    );
    reviewCommentsComplete = reviewComments.length === expectedReviewComments;
    if (!reviewCommentsComplete)
      gaps.push(
        `GitHub reported ${expectedReviewComments} inline review comments but retrieved ${reviewComments.length}`,
      );

    const threadResult = await ghReviewThreads(
      runner,
      requested.owner,
      requested.repository,
      requested.number,
    );
    reviewThreads = threadResult.threads;
    reviewThreadsComplete = threadResult.complete;
    if (!threadResult.complete)
      gaps.push("One or more GitHub review thread comment lists exceeded the GraphQL bound");
    const mappedCommentIds = reviewThreads.flatMap((thread) => thread.commentIds);
    const threadedCommentIds = new Set(mappedCommentIds);
    if (threadedCommentIds.size !== mappedCommentIds.length) {
      reviewThreadsComplete = false;
      gaps.push("One or more inline review comments appeared in multiple review threads");
    }
    const retrievedCommentIds = new Set(reviewComments.map((comment) => comment.id));
    const unknownThreadComments = [...threadedCommentIds].filter(
      (commentId) => !retrievedCommentIds.has(commentId),
    );
    if (unknownThreadComments.length > 0) {
      reviewThreadsComplete = false;
      gaps.push(
        `${unknownThreadComments.length} review-thread comments had no retrieved inline comment`,
      );
    }
    const unthreaded = reviewComments.filter((comment) => !threadedCommentIds.has(comment.id));
    if (unthreaded.length > 0) {
      reviewThreadsComplete = false;
      gaps.push(`${unthreaded.length} inline review comments were not mapped to a review thread`);
    }

    const fileRaw = await ghPages(
      runner,
      `repos/${encode(requested.owner)}/${encode(requested.repository)}/pulls/${requested.number}/files?per_page=100`,
    );
    changedFiles = fileRaw
      .map(parseChangedFile)
      .sort((left, right) => left.path.localeCompare(right.path));
    const expectedChangedFiles = integer(pullRaw.changed_files, "GitHub changed file count");
    changedFilesComplete = changedFiles.length === expectedChangedFiles;
    if (!changedFilesComplete)
      gaps.push(
        `GitHub reported ${expectedChangedFiles} changed files but retrieved ${changedFiles.length}`,
      );
    for (const file of changedFiles) {
      if (file.patch === null) gaps.push(`Changed file ${file.path} has no API patch`);
    }
  }

  const externalReferences = discoverExternalReferences(sources);
  const pendingAttachments = discoverAttachments(sources);
  const { runDirectory, filesDirectory, contextPath } = await createRunDirectory(
    options.artifactsDirectory,
  );
  const attachments = await acquireAttachments(
    pendingAttachments,
    filesDirectory,
    runDirectory,
    fetcher,
    limits,
  );
  for (const attachment of attachments) {
    if (attachment.status !== "retrieved")
      gaps.push(`Attachment ${attachment.identity}: ${attachment.error}`);
  }
  if (pendingAttachments.length > limits.maxFiles)
    gaps.push(
      `${pendingAttachments.length - limits.maxFiles} attachments exceeded the acquisition count limit`,
    );

  const result: GitHubCollection = {
    schemaVersion: "1.0",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    requested,
    authenticatedAccount,
    repository: {
      owner: requested.owner,
      name: requested.repository,
      private: requiredBoolean(repositoryRaw.private, "GitHub repository visibility"),
    },
    resource,
    pullRequest,
    issueComments,
    reviews,
    reviewComments,
    reviewThreads,
    changedFiles,
    laneCompleteness: {
      issueComments: issueCommentsComplete,
      pullRequest: pullRequestComplete,
      reviews: reviewsComplete,
      reviewComments: reviewCommentsComplete,
      reviewThreads: reviewThreadsComplete,
      changedFiles: changedFilesComplete,
    },
    externalReferences,
    attachments,
    gaps: [...new Set(gaps)],
    runDirectory,
    contextPath,
  };
  await writeFile(
    contextPath,
    `${JSON.stringify({ ...result, runDirectory: ".", contextPath: basename(contextPath) }, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}

async function ghObject(runner: GhRunner, endpoint: string): Promise<unknown> {
  return runner(apiArguments(endpoint, false));
}

async function ghPages(runner: GhRunner, endpoint: string): Promise<Record<string, unknown>[]> {
  const value = await runner(apiArguments(endpoint, true));
  if (!Array.isArray(value)) throw new Error("GitHub paginated response was not an array of pages");
  const output: Record<string, unknown>[] = [];
  for (const [pageIndex, page] of value.entries()) {
    if (!Array.isArray(page))
      throw new Error(`GitHub pagination page ${pageIndex + 1} was not an array`);
    for (const item of page) output.push(record(item, "GitHub pagination item"));
  }
  return output;
}

async function ghReviewThreads(
  runner: GhRunner,
  owner: string,
  repository: string,
  number: number,
): Promise<{ threads: ReviewThread[]; complete: boolean }> {
  const query = `query($owner:String!,$repository:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repository){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{id isResolved isOutdated comments(first:100){nodes{databaseId} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}`;
  const value = await runner([
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
    "-F",
    `owner=${owner}`,
    "-F",
    `repository=${repository}`,
    "-F",
    `number=${number}`,
    "-f",
    `query=${query}`,
  ]);
  if (!Array.isArray(value)) throw new Error("GitHub review thread response was not paginated");
  const threads: ReviewThread[] = [];
  let complete = true;
  for (const page of value) {
    const data = record(record(page, "GitHub GraphQL page").data, "GitHub GraphQL data");
    const repositoryData = record(data.repository, "GitHub GraphQL repository");
    const pullRequest = record(repositoryData.pullRequest, "GitHub GraphQL pull request");
    const connection = record(pullRequest.reviewThreads, "GitHub review thread connection");
    for (const node of array(connection.nodes)) {
      const thread = record(node, "GitHub review thread");
      const comments = record(thread.comments, "GitHub review thread comments");
      const pageInfo = record(comments.pageInfo, "GitHub review thread comment page info");
      if (requiredBoolean(pageInfo.hasNextPage, "GitHub thread comment pagination"))
        complete = false;
      threads.push({
        id: requiredString(thread.id, "GitHub review thread id"),
        resolved: requiredBoolean(thread.isResolved, "GitHub review thread resolution"),
        outdated: requiredBoolean(thread.isOutdated, "GitHub review thread outdated state"),
        commentIds: array(comments.nodes).map((comment) =>
          integer(record(comment, "GitHub review thread comment").databaseId, "GitHub comment id"),
        ),
      });
    }
  }
  return { threads, complete };
}

function apiArguments(endpoint: string, paginate: boolean): string[] {
  return [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github.full+json",
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    ...(paginate ? ["--paginate", "--slurp"] : []),
    endpoint,
  ];
}

async function defaultGhRunner(arguments_: readonly string[]): Promise<unknown> {
  const child = Bun.spawn(["gh", ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const safe = redactText(stderr.trim());
    if (/\b404\b/.test(safe))
      throw new Error("GitHub returned 404; the resource may be missing or inaccessible");
    throw new Error(safe ? `gh failed: ${safe}` : `gh failed with exit ${exitCode}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("gh returned invalid JSON");
  }
}

function parseResource(
  value: Record<string, unknown>,
  kind: GitHubResourceKind,
): GitHubCollection["resource"] {
  return {
    kind,
    id: integer(value.id, "GitHub resource id"),
    nodeId: requiredString(value.node_id, "GitHub resource node id"),
    number: integer(value.number, "GitHub resource number"),
    title: redactText(requiredString(value.title, "GitHub resource title")),
    state: requiredString(value.state, "GitHub resource state"),
    stateReason: optionalString(value.state_reason) ?? null,
    author: parseActor(value.user),
    body: redactText(optionalString(value.body) ?? ""),
    createdAt: requiredString(value.created_at, "GitHub resource creation time"),
    updatedAt: requiredString(value.updated_at, "GitHub resource update time"),
    closedAt: optionalString(value.closed_at) ?? null,
    url: requiredString(value.html_url, "GitHub resource URL"),
    labels: array(value.labels).map((label) =>
      requiredString(record(label, "GitHub label").name, "GitHub label name"),
    ),
    assignees: array(value.assignees).map(parseActor).filter(isPresent),
  };
}

function parsePullRequest(
  value: Record<string, unknown>,
): NonNullable<GitHubCollection["pullRequest"]> {
  const base = record(value.base, "GitHub pull request base");
  const head = record(value.head, "GitHub pull request head");
  return {
    draft: requiredBoolean(value.draft, "GitHub pull request draft state"),
    merged: requiredBoolean(value.merged, "GitHub pull request merged state"),
    mergedAt: optionalString(value.merged_at) ?? null,
    base: {
      ref: requiredString(base.ref, "GitHub base ref"),
      sha: requiredString(base.sha, "GitHub base sha"),
    },
    head: {
      ref: requiredString(head.ref, "GitHub head ref"),
      sha: requiredString(head.sha, "GitHub head sha"),
    },
    additions: integer(value.additions, "GitHub pull request additions"),
    deletions: integer(value.deletions, "GitHub pull request deletions"),
    changedFileCount: integer(value.changed_files, "GitHub changed file count"),
    commitCount: integer(value.commits, "GitHub pull request commit count"),
  };
}

function parseComment(value: Record<string, unknown>): Comment {
  return {
    id: integer(value.id, "GitHub comment id"),
    nodeId: requiredString(value.node_id, "GitHub comment node id"),
    author: parseActor(value.user),
    authorAssociation: optionalString(value.author_association) ?? null,
    body: redactText(optionalString(value.body) ?? ""),
    createdAt: requiredString(value.created_at, "GitHub comment creation time"),
    updatedAt: requiredString(value.updated_at, "GitHub comment update time"),
    url: requiredString(value.html_url, "GitHub comment URL"),
  };
}

function parseReview(value: Record<string, unknown>): Review {
  return {
    id: integer(value.id, "GitHub review id"),
    nodeId: requiredString(value.node_id, "GitHub review node id"),
    author: parseActor(value.user),
    authorAssociation: optionalString(value.author_association) ?? null,
    state: requiredString(value.state, "GitHub review state"),
    body: redactText(optionalString(value.body) ?? ""),
    commitId: optionalString(value.commit_id) ?? null,
    submittedAt: optionalString(value.submitted_at) ?? null,
    url: requiredString(value.html_url, "GitHub review URL"),
  };
}

function parseReviewComment(value: Record<string, unknown>): ReviewComment {
  return {
    ...parseComment(value),
    path: requiredString(value.path, "GitHub review comment path"),
    commitId: requiredString(value.commit_id, "GitHub review comment commit id"),
    originalCommitId: requiredString(
      value.original_commit_id,
      "GitHub review comment original commit id",
    ),
    inReplyToId: optionalInteger(value.in_reply_to_id),
    line: optionalInteger(value.line),
    originalLine: optionalInteger(value.original_line),
    side: optionalString(value.side) ?? null,
    startLine: optionalInteger(value.start_line),
    diffHunk: redactText(requiredString(value.diff_hunk, "GitHub review diff hunk")),
  };
}

function parseChangedFile(value: Record<string, unknown>): ChangedFile {
  return {
    path: requiredString(value.filename, "GitHub changed file path"),
    status: requiredString(value.status, "GitHub changed file status"),
    additions: integer(value.additions, "GitHub file additions"),
    deletions: integer(value.deletions, "GitHub file deletions"),
    changes: integer(value.changes, "GitHub file changes"),
    previousPath: optionalString(value.previous_filename) ?? null,
    blobUrl: requiredString(value.blob_url, "GitHub file blob URL"),
    rawUrl: requiredString(value.raw_url, "GitHub file raw URL"),
    patch: typeof value.patch === "string" ? redactText(value.patch) : null,
  };
}

function parseActor(value: unknown): Actor | null {
  if (!isRecord(value)) return null;
  return {
    login: requiredString(value.login, "GitHub actor login"),
    id: optionalInteger(value.id),
    type: optionalString(value.type) ?? null,
  };
}

function bodySource(location: string, value: Record<string, unknown>): EvidenceSource {
  return {
    location,
    body: optionalString(value.body) ?? "",
    bodyHtml: optionalString(value.body_html) ?? "",
  };
}

function discoverExternalReferences(sources: EvidenceSource[]): string[] {
  const references = new Set<string>();
  for (const source of sources) {
    for (const match of source.body.matchAll(/https?:\/\/[^\s<>()[\]{}"']+/g)) {
      const candidate = match[0].replace(/[.,;:!?]+$/, "");
      if (candidate.includes("`")) continue;
      if (isGitHubAttachmentUrl(candidate)) continue;
      const sanitized = sanitizeReference(candidate);
      if (sanitized) references.add(sanitized);
    }
  }
  return [...references].sort();
}

function discoverAttachments(sources: EvidenceSource[]): PendingAttachment[] {
  const discovered = new Map<string, PendingAttachment>();
  for (const source of sources) {
    for (const match of source.body.matchAll(
      /!?\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[^\s)]+)\)/g,
    )) {
      addAttachment(discovered, match[2]!, source.location, match[1] || "GitHub attachment", false);
    }
    for (const match of source.body.matchAll(
      /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[^\s<>()\]"']+/g,
    )) {
      addAttachment(discovered, match[0], source.location, "GitHub attachment", false);
    }
    for (const match of source.body.matchAll(
      /https:\/\/(?:private-user-images|user-images)\.githubusercontent\.com\/[^\s<>()\]"']+/gi,
    )) {
      addAttachment(
        discovered,
        match[0],
        source.location,
        "GitHub attachment",
        match[0].toLowerCase().includes("private-user-images"),
      );
    }
    for (const match of source.bodyHtml.matchAll(
      /https:\/\/(?:private-user-images|user-images)\.githubusercontent\.com\/[^"']+/gi,
    )) {
      addAttachment(
        discovered,
        decodeHtmlUrl(match[0]),
        source.location,
        "GitHub attachment",
        true,
      );
    }
  }
  return [...discovered.values()].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
}

function addAttachment(
  discovered: Map<string, PendingAttachment>,
  value: string,
  location: string,
  name: string,
  signed: boolean,
): void {
  const sanitizedValue = value.replace(/[.,;:!?]+$/, "");
  if (sanitizedValue.includes("`")) return;
  let url: URL;
  try {
    url = validateAttachmentUrl(sanitizedValue);
  } catch {
    return;
  }
  const identity = attachmentIdentity(url);
  if (!identity) return;
  const existing = discovered.get(identity);
  const derivedName = safeFilename(name === "GitHub attachment" ? attachmentName(url) : name);
  if (existing) {
    if (!existing.sourceLocations.includes(location)) existing.sourceLocations.push(location);
    if (signed) existing.signedUrl = url.toString();
    else existing.originalUrl = url.toString();
    if (existing.originalName === "GitHub-attachment" && derivedName !== "GitHub-attachment")
      existing.originalName = derivedName;
    return;
  }
  discovered.set(identity, {
    identity,
    originalName: derivedName,
    sourceLocations: [location],
    originalUrl: signed ? null : url.toString(),
    signedUrl: signed ? url.toString() : null,
  });
}

async function acquireAttachments(
  pending: PendingAttachment[],
  filesDirectory: string,
  runDirectory: string,
  fetcher: Fetcher,
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
): Promise<GitHubAttachment[]> {
  const entries: GitHubAttachment[] = [];
  let totalBytes = 0;
  for (const [index, attachment] of pending.slice(0, limits.maxFiles).entries()) {
    const base = attachmentBase(attachment);
    if (totalBytes >= limits.maxTotalBytes) {
      entries.push({
        ...base,
        status: "failed",
        error: "GitHub attachments exceed the total byte limit",
      });
      continue;
    }
    try {
      let source = validateAttachmentUrl(attachment.signedUrl ?? attachment.originalUrl ?? "");
      let response = await fetcher(source, {
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("GitHub attachment redirect had no location");
        source = validateAttachmentUrl(new URL(location, source).toString());
        response = await fetcher(source, {
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        });
      }
      if (response.status >= 300 && response.status < 400)
        throw new Error("GitHub attachment returned too many redirects");
      if (!response.ok) throw new Error(`GitHub attachment returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes)
        throw new Error("GitHub attachment exceeds the per-file byte limit");
      const bytes = await readBounded(
        response,
        Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes),
        (consumed) => {
          totalBytes += consumed;
        },
      );
      const detectedMime = detectMime(
        bytes,
        response.headers.get("content-type"),
        attachment.originalName,
      );
      if (!isSupportedMime(detectedMime)) {
        entries.push({
          ...base,
          status: "unsupported",
          error: `Detected unsupported GitHub attachment type: ${detectedMime}`,
        });
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const responseName = contentDispositionName(response.headers.get("content-disposition"));
      const originalName = safeFilename(
        attachment.originalName === "GitHub-attachment"
          ? (responseName ?? attachment.originalName)
          : attachment.originalName,
      );
      const localName = `${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 12)}-${originalName}`;
      const localPath = join(filesDirectory, localName);
      await writeFile(localPath, bytes, { flag: "wx" });
      entries.push({
        ...base,
        originalName,
        status: "retrieved",
        localPath: relative(runDirectory, localPath),
        detectedMime,
        bytes: bytes.byteLength,
        sha256,
      });
    } catch (error) {
      entries.push({ ...base, status: "failed", error: safeError(error) });
    }
  }
  return entries;
}

function attachmentBase(attachment: PendingAttachment): GitHubAttachmentBase {
  return {
    identity: attachment.identity,
    originalName: attachment.originalName,
    sourceLocations: [...attachment.sourceLocations].sort(),
  };
}

function validateAttachmentUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("GitHub attachment URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !ATTACHMENT_HOSTS.has(url.hostname) ||
    (url.hostname === "github.com" && !/^\/user-attachments\/(?:assets|files)\//.test(url.pathname))
  ) {
    throw new Error("GitHub attachment URL is not allowed");
  }
  return url;
}

function attachmentIdentity(url: URL): string | null {
  const match = url.pathname.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[A-Za-z0-9]+)?$/i,
  );
  if (match?.[1]) return match[1].toLowerCase();
  if (
    url.hostname === "private-user-images.githubusercontent.com" ||
    url.hostname === "user-images.githubusercontent.com"
  ) {
    return `legacy-${createHash("sha256").update(`${url.hostname}${url.pathname}`).digest("hex").slice(0, 24)}`;
  }
  return null;
}

function attachmentName(url: URL): string {
  const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "GitHub attachment");
  return /^[0-9a-f-]{36}$/i.test(name) ? "GitHub attachment" : name.replace(/^\d+-/, "");
}

function isGitHubAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.hostname === "github.com" &&
        /^\/user-attachments\/(?:assets|files)\//.test(url.pathname)) ||
      url.hostname === "private-user-images.githubusercontent.com" ||
      url.hostname === "user-images.githubusercontent.com"
    );
  } catch {
    return false;
  }
}

function sanitizeReference(input: string, preserveHash = false): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      const value = url.searchParams.get(key) ?? "";
      if (isSensitiveQuery(key, value)) url.searchParams.set(key, "[REDACTED]");
    }
    if (!preserveHash) url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function redactText(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"')\]]+/g, (match) => {
    const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
    const clean = trailing ? match.slice(0, -trailing.length) : match;
    return `${sanitizeReference(clean) ?? "URL [REDACTED]"}${trailing}`;
  });
}

function isSensitiveQuery(key: string, value: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return (
    /(?:^|[-_])(signature|sig|token|secret|key|credential|authorization|auth|jwt|password|passwd)(?:$|[-_])/.test(
      normalized,
    ) ||
    ["expires", "ex", "hm"].includes(normalized) ||
    normalized.startsWith("x-amz-") ||
    normalized.startsWith("x-goog-") ||
    value.length > 64 ||
    value.split(".").length === 3
  );
}

export function detectMime(bytes: Uint8Array, declaredMime: string | null, name: string): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (
    ascii(bytes, 0, 3) === "ID3" ||
    (bytes.length >= 4 &&
      bytes[0] === 0xff &&
      ((bytes[1] ?? 0) & 0xe0) === 0xe0 &&
      ((bytes[1] ?? 0) & 0x18) !== 0x08 &&
      ((bytes[1] ?? 0) & 0x06) === 0x02 &&
      ((bytes[2] ?? 0) & 0xf0) !== 0xf0 &&
      ((bytes[2] ?? 0) & 0x0c) !== 0x0c)
  )
    return "audio/mpeg";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  const isoBoxSize =
    bytes.length >= 16
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
      : 0;
  if (isoBoxSize >= 16 && isoBoxSize <= bytes.length && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, Math.min(isoBoxSize - 8, 32));
    if (brand.includes("avif") || brand.includes("avis")) return "image/avif";
    if (brand.includes("heic") || brand.includes("heix") || brand.includes("mif1"))
      return "image/heic";
    if (brand.includes("M4A ") || brand.includes("M4B ") || brand.includes("M4P "))
      return "audio/mp4";
    if (brand.includes("qt  ")) return "video/quicktime";
    return "video/mp4";
  }
  const text = decodeUtf8(bytes);
  if (text !== null && !text.includes("\0")) {
    const trimmed = text.trimStart();
    const declared = declaredMime?.split(";", 1)[0]?.toLowerCase();
    const containsSvgRoot = /<svg[\s>]/i.test(trimmed.slice(0, 512));
    const claimedSvg = declared === "image/svg+xml" || /\.svg$/i.test(name);
    const beginsWithSvg = /^<svg[\s>]/i.test(trimmed);
    const xmlSvg = trimmed.startsWith("<?xml") && containsSvgRoot;
    if (beginsWithSvg || xmlSvg || (claimedSvg && containsSvgRoot)) return "image/svg+xml";
    if (declared === "application/json" || /\.json$/i.test(name)) {
      try {
        JSON.parse(text);
        return "application/json";
      } catch {
        return "text/plain";
      }
    }
    if (declared === "application/xml" || /\.xml$/i.test(name) || trimmed.startsWith("<?xml"))
      return "application/xml";
    if (declared?.startsWith("text/")) return declared;
    return "text/plain";
  }
  return "application/octet-stream";
}

function isSupportedMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  );
}

export async function readBounded(
  response: Response,
  limit: number,
  account: (bytes: number) => void = () => {},
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    account(bytes.byteLength);
    if (bytes.byteLength > limit) throw new Error("GitHub attachment exceeded its byte limit");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    account(value.byteLength);
    if (total > limit) {
      await reader.cancel();
      throw new Error("GitHub attachment exceeded its byte limit while streaming");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function createRunDirectory(artifactsDirectory: string): Promise<{
  runDirectory: string;
  filesDirectory: string;
  contextPath: string;
}> {
  await mkdir(artifactsDirectory, { recursive: true });
  if ((await lstat(artifactsDirectory)).isSymbolicLink())
    throw new Error("Artifacts directory must not be a symbolic link");
  const root = await realpath(artifactsDirectory);
  const runDirectory = await mkdtemp(join(root, "github-context-"));
  const filesDirectory = join(runDirectory, "files");
  await mkdir(filesDirectory);
  return {
    runDirectory,
    filesDirectory,
    contextPath: join(runDirectory, "github-context.json"),
  };
}

function compareCreated(left: Comment, right: Comment): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id - right.id;
}

function compareSubmitted(left: Review, right: Review): number {
  return (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "") || left.id - right.id;
}

function contentDispositionName(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] ?? null;
}

function decodeHtmlUrl(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&#x3D;/gi, "=");
}

function safeFilename(value: string): string {
  const name = basename(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/, "");
  return name.slice(0, 120) || "GitHub-attachment";
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown GitHub attachment failure";
  return error.message.replace(
    /https?:\/\/[^\s]+/g,
    (value) => sanitizeReference(value) ?? "[redacted URL]",
  );
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.slice(offset, offset + length));
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was missing`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${label} was invalid`);
  return value;
}

function optionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} was invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function validateLimits(limits: {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
  }
}
