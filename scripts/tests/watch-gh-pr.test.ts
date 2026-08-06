import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  observeGitHubPullRequest,
  parseGitHubPullRequestUrl,
  type GhRunner,
} from "../../skills/context/watch-gh-pr/scripts/observer.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "watch-gh-pr");
const OWNER = "fixture-owner";
const REPOSITORY = "fixture-repository";
const PR_URL = `https://github.com/${OWNER}/${REPOSITORY}/pull/8`;

interface FixtureManifest {
  fixtures: Array<{ file: string; sha256: string; property: string }>;
}

describe("watch-gh-pr fixtures", () => {
  it("retains the recorded bytes for every provider shape", async () => {
    const manifest = await fixture<FixtureManifest>("manifest.json");
    for (const entry of manifest.fixtures) {
      const bytes = await readFile(join(FIXTURES, entry.file));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.property).toBe(entry.sha256);
    }
  });
});

describe("GitHub pull request locator", () => {
  it("accepts one exact pull request URL and rejects other lanes", () => {
    expect(parseGitHubPullRequestUrl(`${PR_URL}?notification=1#discussion_r1`)).toEqual({
      owner: OWNER,
      repository: REPOSITORY,
      number: 8,
      canonicalUrl: PR_URL,
    });
    expect(() =>
      parseGitHubPullRequestUrl(`https://github.com/${OWNER}/${REPOSITORY}/issues/8`),
    ).toThrow("identify one pull request");
    expect(() =>
      parseGitHubPullRequestUrl(`http://github.com/${OWNER}/${REPOSITORY}/pull/8`),
    ).toThrow("exact HTTPS");
  });
});

describe("GitHub pull request snapshots", () => {
  it("expands a managed Stack in bottom-to-top order", async () => {
    const result = await observeGitHubPullRequest(PR_URL, { runner: fixtureRunner("stack.json") });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error(result.error);
    expect(result.snapshot.scope).toEqual({
      kind: "stack",
      number: 62,
      id: 6200,
      baseRef: "main",
      open: true,
    });
    expect(result.snapshot.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([
      7, 8, 9,
    ]);
    expect(result.snapshot.pullRequests[0]?.checks.map((check) => check.name)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.snapshot.pullRequests[2]?.draft).toBe(true);
    expect(result.snapshot.pullRequests[2]?.autoMergeEnabled).toBe(true);
  });

  it("returns one pull request when GitHub has no managed Stack", async () => {
    const result = await observeGitHubPullRequest(PR_URL, {
      runner: fixtureRunner("no-stack.json"),
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error(result.error);
    expect(result.snapshot.scope).toEqual({ kind: "pull-request" });
    expect(result.snapshot.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8]);
  });

  it("produces identical JSON for unchanged provider state", async () => {
    const first = await observeGitHubPullRequest(PR_URL, { runner: fixtureRunner("stack.json") });
    const second = await observeGitHubPullRequest(PR_URL, { runner: fixtureRunner("stack.json") });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("fails closed when Stack membership omits the requested pull request", async () => {
    const base = fixtureRunner("stack.json");
    const runner: GhRunner = async (arguments_) => {
      const value = await base(arguments_);
      if (arguments_[0] !== "api" || !String(arguments_[1]).includes("/stacks?")) return value;
      const stacks = structuredClone(value) as Array<{ pull_requests: Array<{ number: number }> }>;
      stacks[0]!.pull_requests = [{ number: 7 }, { number: 9 }];
      return stacks;
    };

    const result = await observeGitHubPullRequest(PR_URL, { runner });

    expect(result).toEqual({
      outcome: "provider-error",
      error: "GitHub Stack lookup did not include the requested pull request",
    });
  });

  it("preserves unsupported input and provider failures as distinct outcomes", async () => {
    const unsupported = await observeGitHubPullRequest("not a URL", {
      runner: async () => {
        throw new Error("must not run");
      },
    });
    const provider = await observeGitHubPullRequest(PR_URL, {
      runner: async () => {
        throw new Error("fixture provider unavailable");
      },
    });

    expect(unsupported.outcome).toBe("unsupported-input");
    expect(provider).toEqual({ outcome: "provider-error", error: "fixture provider unavailable" });
  });
});

function fixtureRunner(stackFixture: "stack.json" | "no-stack.json"): GhRunner {
  return async (arguments_) => {
    if (arguments_[0] === "api" && arguments_[1] === "user") return fixture("user.json");
    if (arguments_[0] === "api" && String(arguments_[1]).includes("/stacks?")) {
      return fixture(stackFixture);
    }
    if (arguments_[0] === "pr" && arguments_[1] === "view") {
      const number = Number(arguments_[2]);
      if ([7, 8, 9].includes(number)) return fixture(`pr-${number}.json`);
    }
    throw new Error(`Unexpected fixture route: ${arguments_.join(" ")}`);
  };
}

async function fixture<T>(file: string): Promise<T> {
  const contents = await readFile(join(FIXTURES, file), "utf8");
  return JSON.parse(contents) as T;
}
