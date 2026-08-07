import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  parseResolveThreadArguments,
  resolveGitHubPullRequestThread,
  type GhRunner,
  type ResolveThreadRequest,
} from "../../skills/development/resolve-gh-pr-thread/scripts/resolve.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "resolve-gh-pr-thread");
const PR_URL = "https://github.com/fixture-owner/fixture-repository/pull/8";

interface FixtureManifest {
  fixtures: Array<{ file: string; sha256: string; property: string }>;
}

interface Simulation {
  runner: GhRunner;
  mutations: string[];
}

describe("resolve-gh-pr-thread fixtures", () => {
  it("retains the recorded bytes for every provider state and reply", async () => {
    const manifest = await fixture<FixtureManifest>("manifest.json");
    for (const entry of manifest.fixtures) {
      const bytes = await readFile(join(FIXTURES, entry.file));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.property).toBe(entry.sha256);
    }
  });
});

describe("review thread mutation arguments", () => {
  it("requires explicit resolution authority and reads the reply from a file boundary", async () => {
    const arguments_ = requestArguments();
    const parsed = await parseResolveThreadArguments(arguments_);
    let refusal: unknown;
    try {
      await parseResolveThreadArguments(arguments_.filter((argument) => argument !== "--resolve"));
    } catch (error) {
      refusal = error;
    }

    expect(parsed).toEqual(await request());
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("Explicit --resolve authorization is required");
  });
});

describe("review thread reconciliation", () => {
  it("replies, reacts, and resolves one exact thread with readback after every step", async () => {
    const simulation = await githubSimulation();

    const result = await resolveGitHubPullRequestThread(await request(), {
      runner: simulation.runner,
    });

    expect(result).toEqual({
      outcome: "ok",
      pullRequestUrl: PR_URL,
      threadId: "PRRT_fixture_thread_123",
      rootCommentId: "456",
      headSha: "a".repeat(40),
      actor: "fixture-actor",
      steps: { reply: "applied", reaction: "applied", resolution: "applied" },
    });
    expect(simulation.mutations).toEqual(["reply", "reaction", "resolution"]);
  });

  it("resumes a partial prior attempt without duplicating its reply", async () => {
    const simulation = await githubSimulation({ replyPresent: true });

    const result = await resolveGitHubPullRequestThread(await request(), {
      runner: simulation.runner,
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error(result.error);
    expect(result.steps).toEqual({
      reply: "already-present",
      reaction: "applied",
      resolution: "applied",
    });
    expect(simulation.mutations).toEqual(["reaction", "resolution"]);
  });

  it("recognizes a fully applied retry without issuing mutations", async () => {
    const simulation = await githubSimulation({
      replyPresent: true,
      reactionPresent: true,
      resolved: true,
    });

    const result = await resolveGitHubPullRequestThread(await request(), {
      runner: simulation.runner,
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error(result.error);
    expect(result.steps).toEqual({
      reply: "already-present",
      reaction: "already-present",
      resolution: "already-present",
    });
    expect(simulation.mutations).toHaveLength(0);
  });

  it("recovers when a mutation response fails after GitHub applied the step", async () => {
    const simulation = await githubSimulation({ failReplyAfterApply: true });

    const result = await resolveGitHubPullRequestThread(await request(), {
      runner: simulation.runner,
    });

    expect(result.outcome).toBe("ok");
    expect(simulation.mutations).toEqual(["reply", "reaction", "resolution"]);
  });

  it("reports confirmed partial state instead of hiding a later provider failure", async () => {
    const simulation = await githubSimulation({ failReactionBeforeApply: true });

    const result = await resolveGitHubPullRequestThread(await request(), {
      runner: simulation.runner,
    });

    expect(result).toEqual({
      outcome: "partial",
      cause: "provider-error",
      error: "fixture reaction failure",
      steps: { reply: "applied", reaction: "pending", resolution: "pending" },
    });
  });

  it("refuses a stale assessment while the matching control can mutate", async () => {
    const stale = await githubSimulation();
    const valid = await githubSimulation();

    const staleResult = await resolveGitHubPullRequestThread(
      { ...(await request()), expectedHeadSha: "b".repeat(40) },
      { runner: stale.runner },
    );
    const validResult = await resolveGitHubPullRequestThread(await request(), {
      runner: valid.runner,
    });

    expect(staleResult.outcome).toBe("input-changed");
    expect(stale.mutations).toHaveLength(0);
    expect(validResult.outcome).toBe("ok");
    expect(valid.mutations).toHaveLength(3);
  });

  it("fails closed when an already-resolved thread lacks the requested evidence", async () => {
    const simulation = await githubSimulation({ resolved: true });

    const result = await resolveGitHubPullRequestThread(await request(), {
      runner: simulation.runner,
    });

    expect(result.outcome).toBe("input-changed");
    expect(simulation.mutations).toHaveLength(0);
  });
});

async function request(): Promise<ResolveThreadRequest> {
  return {
    pullRequestUrl: PR_URL,
    threadId: "PRRT_fixture_thread_123",
    rootCommentId: "456",
    expectedHeadSha: "a".repeat(40),
    expectedActor: "fixture-actor",
    replyBody: await readFile(join(FIXTURES, "reply.md"), "utf8"),
    reaction: "+1",
    resolve: true,
  };
}

function requestArguments(): string[] {
  return [
    "--pr",
    PR_URL,
    "--thread-id",
    "PRRT_fixture_thread_123",
    "--root-comment-id",
    "456",
    "--expected-head-sha",
    "a".repeat(40),
    "--expected-actor",
    "fixture-actor",
    "--reply-file",
    join(FIXTURES, "reply.md"),
    "--reaction",
    "+1",
    "--resolve",
  ];
}

async function githubSimulation(
  initial: {
    replyPresent?: boolean;
    reactionPresent?: boolean;
    resolved?: boolean;
    failReplyAfterApply?: boolean;
    failReactionBeforeApply?: boolean;
  } = {},
): Promise<Simulation> {
  const provider = structuredClone(await fixture<Record<string, unknown>>("unresolved.json"));
  const data = provider.data as Record<string, unknown>;
  const node = data.node as Record<string, unknown>;
  const comments = node.comments as { totalCount: number; nodes: Array<Record<string, unknown>> };
  const root = comments.nodes[0]!;
  const reactionGroups = root.reactionGroups as Array<{
    content: string;
    viewerHasReacted: boolean;
  }>;
  const replyBody = await readFile(join(FIXTURES, "reply.md"), "utf8");
  const mutations: string[] = [];

  const addReply = (): void => {
    if (comments.nodes.length > 1) return;
    comments.nodes.push({
      id: "PRRC_fixture_reply_789",
      databaseId: 789,
      body: replyBody,
      author: { login: "fixture-actor" },
      replyTo: { id: "PRRC_fixture_root_456" },
      reactionGroups: [],
    });
    comments.totalCount = comments.nodes.length;
  };
  if (initial.replyPresent) addReply();
  if (initial.reactionPresent) reactionGroups[0]!.viewerHasReacted = true;
  if (initial.resolved) node.isResolved = true;

  const runner: GhRunner = async (arguments_) => {
    expect(arguments_.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
    const query = String(arguments_[5]);
    if (query.includes("ObserveReviewThread")) return structuredClone(provider);
    if (query.includes("ReplyToReviewThread")) {
      mutations.push("reply");
      addReply();
      if (initial.failReplyAfterApply) throw new Error("fixture lost reply response");
      return { data: {} };
    }
    if (query.includes("ReactToReviewComment")) {
      mutations.push("reaction");
      if (initial.failReactionBeforeApply) throw new Error("fixture reaction failure");
      reactionGroups[0]!.viewerHasReacted = true;
      return { data: {} };
    }
    if (query.includes("ResolveReviewThread")) {
      mutations.push("resolution");
      node.isResolved = true;
      return { data: {} };
    }
    throw new Error(`Unexpected fixture route: ${arguments_.join(" ")}`);
  };
  return { runner, mutations };
}

async function fixture<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, file), "utf8")) as T;
}
