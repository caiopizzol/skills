import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  collectGitHubResource,
  detectMime,
  parseGitHubResourceUrl,
  type Fetcher,
  type GhRunner,
} from "../../skills/context/read-github-resource/scripts/collector.ts";

const OWNER = "fixture-owner";
const REPOSITORY = "fixture-repository";
const ISSUE_URL = `https://github.com/${OWNER}/${REPOSITORY}/issues/3`;
const PR_URL = `https://github.com/${OWNER}/${REPOSITORY}/pull/7`;
const ATTACHMENT_ID = "8f289847-c196-4e1e-9f96-f7e9da192040";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitHub resource locators", () => {
  it("parses exact issue and pull request URLs", () => {
    expect(parseGitHubResourceUrl(`${ISSUE_URL}?notification=1#issuecomment-2`)).toEqual({
      owner: OWNER,
      repository: REPOSITORY,
      number: 3,
      requestedKind: "issue",
      requestedUrl: `${ISSUE_URL}?notification=1#issuecomment-2`,
      canonicalUrl: ISSUE_URL,
    });
    expect(parseGitHubResourceUrl(PR_URL).requestedKind).toBe("pull_request");
    expect(parseGitHubResourceUrl(`${ISSUE_URL}?token=secret#issuecomment-2`).requestedUrl).toBe(
      `${ISSUE_URL}?token=%5BREDACTED%5D#issuecomment-2`,
    );
    expect(() => parseGitHubResourceUrl(`https://github.com/${OWNER}/${REPOSITORY}`)).toThrow(
      "identify one issue or pull request",
    );
    expect(() =>
      parseGitHubResourceUrl(`http://github.com/${OWNER}/${REPOSITORY}/issues/3`),
    ).toThrow("exact HTTPS");
  });

  it("rejects the wrong lane before using gh", async () => {
    let calls = 0;
    let failure: unknown;
    try {
      await collectGitHubResource(PR_URL, {
        expectedKind: "issue",
        artifactsDirectory: await temporaryDirectory(),
        runner: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("read-github-pr");
    expect(calls).toBe(0);
  });
});

describe("GitHub issue collection", () => {
  it("retrieves every issue comment, references, and one deduplicated attachment", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const attachmentHeaders: Array<string | null> = [];
    const routes = baseRoutes();
    routes.set(
      issueEndpoint(3),
      issueResource(3, 2, false, {
        body: `Issue evidence http://alice:password@example.com/context?apiKey=secret&keep=1 and \`https://\`-only plus \`http://example.com/\`\n\n![Fixture image](https://github.com/user-attachments/assets/${ATTACHMENT_ID})`,
        body_html: `<p>Issue evidence</p><a href="https://private-user-images.githubusercontent.com/1/123-${ATTACHMENT_ID}.png?sig=secret&amp;keep=2"><img src="https://private-user-images.githubusercontent.com/1/123-${ATTACHMENT_ID}.png?sig=secret&amp;keep=2"></a>`,
      }),
    );
    routes.set(issueCommentsEndpoint(3), [
      [comment(12, "Second comment", "2026-01-02T00:00:00Z")],
      [comment(11, "First comment https://example.com/first", "2026-01-01T00:00:00Z")],
    ]);
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(requestUrl(input));
      attachmentHeaders.push(new Headers(init?.headers).get("authorization"));
      expect(url.hostname).toBe("private-user-images.githubusercontent.com");
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        headers: {
          "content-type": "image/png",
          "content-disposition": 'inline; filename="fixture.png"',
        },
      });
    };

    const result = await collectGitHubResource(ISSUE_URL, {
      expectedKind: "issue",
      artifactsDirectory,
      runner: routeRunner(routes),
      fetcher,
    });

    expect(result.authenticatedAccount).toBe("fixture-account");
    expect(result.resource.kind).toBe("issue");
    expect(result.issueComments.map((entry) => entry.id)).toEqual([11, 12]);
    expect(result.laneCompleteness).toEqual({
      issueComments: true,
      pullRequest: null,
      reviews: null,
      reviewComments: null,
      reviewThreads: null,
      changedFiles: null,
    });
    expect(result.externalReferences).toEqual([
      "http://example.com/context?apiKey=%5BREDACTED%5D&keep=1",
      "https://example.com/first",
    ]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        identity: ATTACHMENT_ID,
        originalName: "Fixture-image",
        status: "retrieved",
        detectedMime: "image/png",
      }),
    ]);
    expect(attachmentHeaders).toEqual([null]);
    expect(result.gaps).toEqual([]);
    const persisted = await Bun.file(result.contextPath).text();
    expect(persisted).not.toContain("alice");
    expect(persisted).not.toContain("password");
    expect(persisted).not.toContain("secret");
    expect(persisted).not.toContain("private-user-images");
  });

  it("fails closed when the provider count disagrees", async () => {
    const routes = baseRoutes();
    routes.set(issueEndpoint(3), issueResource(3, 2, false));
    routes.set(issueCommentsEndpoint(3), [[comment(11, "Only comment", "2026-01-01T00:00:00Z")]]);

    const result = await collectGitHubResource(ISSUE_URL, {
      expectedKind: "issue",
      artifactsDirectory: await temporaryDirectory(),
      runner: routeRunner(routes),
    });

    expect(result.laneCompleteness.issueComments).toBe(false);
    expect(result.gaps).toContain("GitHub reported 2 issue comments but retrieved 1");
  });
});

describe("GitHub pull request collection", () => {
  it("keeps every conversation lane separate and reports missing patches", async () => {
    const routes = baseRoutes();
    routes.set(issueEndpoint(7), issueResource(7, 1, true));
    routes.set(issueCommentsEndpoint(7), [[comment(21, "Issue comment", "2026-01-01T00:00:00Z")]]);
    routes.set(pullEndpoint(7), pullResource(7));
    routes.set(reviewsEndpoint(7), [
      [review(31, "APPROVED", "2026-01-03T00:00:00Z")],
      [review(30, "COMMENTED", "2026-01-02T00:00:00Z")],
    ]);
    routes.set(reviewCommentsEndpoint(7), [
      [reviewComment(41, null, "2026-01-04T00:00:00Z")],
      [reviewComment(42, 41, "2026-01-05T00:00:00Z")],
    ]);
    routes.set("graphql:reviewThreads", reviewThreadPages());
    routes.set(filesEndpoint(7), [
      [changedFile("src/one.ts", "@@ -1 +1 @@\n-old\n+new"), changedFile("image.png", null)],
    ]);

    const result = await collectGitHubResource(PR_URL, {
      expectedKind: "pull_request",
      artifactsDirectory: await temporaryDirectory(),
      runner: routeRunner(routes),
    });

    expect(result.resource.kind).toBe("pull_request");
    expect(result.issueComments).toHaveLength(1);
    expect(result.reviews.map((entry) => entry.id)).toEqual([30, 31]);
    expect(result.reviewComments.map((entry) => [entry.id, entry.inReplyToId])).toEqual([
      [41, null],
      [42, 41],
    ]);
    expect(result.reviewThreads).toEqual([
      { id: "THREAD_1", resolved: true, outdated: false, commentIds: [41, 42] },
    ]);
    expect(result.changedFiles).toHaveLength(2);
    expect(result.laneCompleteness).toEqual({
      issueComments: true,
      pullRequest: true,
      reviews: true,
      reviewComments: true,
      reviewThreads: true,
      changedFiles: true,
    });
    expect(result.gaps).toEqual(["Changed file image.png has no API patch"]);
  });

  it("fails closed when GraphQL threads name comments absent from REST", async () => {
    const routes = pullRoutes();
    routes.set("graphql:reviewThreads", reviewThreadPages([41, 42, 99]));

    const result = await collectGitHubResource(PR_URL, {
      expectedKind: "pull_request",
      artifactsDirectory: await temporaryDirectory(),
      runner: routeRunner(routes),
    });

    expect(result.laneCompleteness.reviewThreads).toBe(false);
    expect(result.gaps).toContain("1 review-thread comments had no retrieved inline comment");
  });
});

describe("GitHub attachment routing", () => {
  it("retains and acquires legacy GitHub image URLs", async () => {
    const routes = baseRoutes();
    routes.set(
      issueEndpoint(3),
      issueResource(3, 0, false, {
        body: "![Legacy](https://user-images.githubusercontent.com/123/456.png)",
      }),
    );
    routes.set(issueCommentsEndpoint(3), []);

    const result = await collectGitHubResource(ISSUE_URL, {
      expectedKind: "issue",
      artifactsDirectory: await temporaryDirectory(),
      runner: routeRunner(routes),
      fetcher: async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { "content-type": "image/png" },
        }),
    });

    expect(result.attachments).toEqual([
      expect.objectContaining({ status: "retrieved", detectedMime: "image/png" }),
    ]);
    expect(result.externalReferences).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it("routes representative supported bytes", () => {
    expect(detectMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", "a.png")).toBe(
      "image/png",
    );
    expect(detectMime(new TextEncoder().encode("fLaCfixture"), "audio/flac", "a.flac")).toBe(
      "audio/flac",
    );
    expect(
      detectMime(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        "image/svg+xml",
        "a.svg",
      ),
    ).toBe("image/svg+xml");
    expect(
      detectMime(
        new TextEncoder().encode('Markdown example: <svg viewBox="0 0 1 1"></svg>'),
        "text/markdown",
        "notes.md",
      ),
    ).toBe("text/markdown");
  });
});

function baseRoutes(): Map<string, unknown> {
  return new Map([
    ["user", { login: "fixture-account" }],
    [`repos/${OWNER}/${REPOSITORY}`, { full_name: `${OWNER}/${REPOSITORY}`, private: true }],
  ]);
}

function routeRunner(routes: Map<string, unknown>): GhRunner {
  return async (arguments_) => {
    const endpoint = arguments_[1] === "graphql" ? "graphql:reviewThreads" : arguments_.at(-1);
    if (!endpoint || !routes.has(endpoint)) throw new Error(`Unexpected gh endpoint: ${endpoint}`);
    return structuredClone(routes.get(endpoint));
  };
}

function reviewThreadPages(commentIds = [41, 42]): unknown[] {
  return [
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "THREAD_1",
                  isResolved: true,
                  isOutdated: false,
                  comments: {
                    nodes: commentIds.map((databaseId) => ({ databaseId })),
                    pageInfo: { hasNextPage: false },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ];
}

function pullRoutes(): Map<string, unknown> {
  const routes = baseRoutes();
  routes.set(issueEndpoint(7), issueResource(7, 1, true));
  routes.set(issueCommentsEndpoint(7), [[comment(21, "Issue comment", "2026-01-01T00:00:00Z")]]);
  routes.set(pullEndpoint(7), pullResource(7));
  routes.set(reviewsEndpoint(7), [
    [review(31, "APPROVED", "2026-01-03T00:00:00Z")],
    [review(30, "COMMENTED", "2026-01-02T00:00:00Z")],
  ]);
  routes.set(reviewCommentsEndpoint(7), [
    [reviewComment(41, null, "2026-01-04T00:00:00Z")],
    [reviewComment(42, 41, "2026-01-05T00:00:00Z")],
  ]);
  routes.set("graphql:reviewThreads", reviewThreadPages());
  routes.set(filesEndpoint(7), [
    [changedFile("src/one.ts", "@@ -1 +1 @@\n-old\n+new"), changedFile("image.png", null)],
  ]);
  return routes;
}

function issueResource(
  number: number,
  comments: number,
  pullRequest: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1000 + number,
    node_id: `ISSUE_${number}`,
    number,
    title: "Fixture resource",
    state: "open",
    state_reason: null,
    user: actor("author"),
    body: "Fixture body",
    body_html: "<p>Fixture body</p>",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    html_url: pullRequest ? PR_URL : ISSUE_URL,
    labels: [{ name: "fixture" }],
    assignees: [actor("assignee")],
    comments,
    ...(pullRequest ? { pull_request: { url: "https://api.github.test/pull" } } : {}),
    ...overrides,
  };
}

function pullResource(number: number): Record<string, unknown> {
  return {
    number,
    draft: false,
    merged: false,
    merged_at: null,
    base: { ref: "main", sha: "base-sha" },
    head: { ref: "feature", sha: "head-sha" },
    additions: 10,
    deletions: 2,
    changed_files: 2,
    commits: 1,
    review_comments: 2,
    body: "Pull request body",
    body_html: "<p>Pull request body</p>",
  };
}

function comment(id: number, body: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    node_id: `COMMENT_${id}`,
    user: actor(`user-${id}`),
    author_association: "MEMBER",
    body,
    body_html: `<p>${body}</p>`,
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `${ISSUE_URL}#issuecomment-${id}`,
  };
}

function review(id: number, state: string, submittedAt: string): Record<string, unknown> {
  return {
    id,
    node_id: `REVIEW_${id}`,
    user: actor(`reviewer-${id}`),
    author_association: "MEMBER",
    state,
    body: `Review ${id}`,
    body_html: `<p>Review ${id}</p>`,
    commit_id: "head-sha",
    submitted_at: submittedAt,
    html_url: `${PR_URL}#pullrequestreview-${id}`,
  };
}

function reviewComment(
  id: number,
  inReplyToId: number | null,
  createdAt: string,
): Record<string, unknown> {
  return {
    ...comment(id, `Inline ${id}`, createdAt),
    html_url: `${PR_URL}#discussion_r${id}`,
    path: "src/one.ts",
    commit_id: "head-sha",
    original_commit_id: "head-sha",
    in_reply_to_id: inReplyToId,
    line: 2,
    original_line: 2,
    side: "RIGHT",
    start_line: null,
    diff_hunk: "@@ -1 +1 @@\n-old\n+new",
  };
}

function changedFile(path: string, patch: string | null): Record<string, unknown> {
  return {
    filename: path,
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    blob_url: `https://github.com/${OWNER}/${REPOSITORY}/blob/head/${path}`,
    raw_url: `https://github.com/${OWNER}/${REPOSITORY}/raw/head/${path}`,
    ...(patch === null ? {} : { patch }),
  };
}

function actor(login: string): Record<string, unknown> {
  return { login, id: Math.abs(hash(login)), type: "User" };
}

function hash(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) total += value.charCodeAt(index);
  return total;
}

function issueEndpoint(number: number): string {
  return `repos/${OWNER}/${REPOSITORY}/issues/${number}`;
}

function issueCommentsEndpoint(number: number): string {
  return `repos/${OWNER}/${REPOSITORY}/issues/${number}/comments?per_page=100`;
}

function pullEndpoint(number: number): string {
  return `repos/${OWNER}/${REPOSITORY}/pulls/${number}`;
}

function reviewsEndpoint(number: number): string {
  return `repos/${OWNER}/${REPOSITORY}/pulls/${number}/reviews?per_page=100`;
}

function reviewCommentsEndpoint(number: number): string {
  return `repos/${OWNER}/${REPOSITORY}/pulls/${number}/comments?per_page=100`;
}

function filesEndpoint(number: number): string {
  return `repos/${OWNER}/${REPOSITORY}/pulls/${number}/files?per_page=100`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "github-context-test-"));
  temporary.push(directory);
  return directory;
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}
