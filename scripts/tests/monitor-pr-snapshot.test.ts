import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  observeGitHubPullRequest,
  parseGitHubPullRequestUrl,
  type GhRunner,
} from "../../skills/development/monitor-pr/scripts/observer.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "monitor-pr-snapshot");
const OWNER = "fixture-owner";
const REPOSITORY = "fixture-repository";
const PR_URL = `https://github.com/${OWNER}/${REPOSITORY}/pull/8`;

interface FixtureManifest {
  fixtures: Array<{ file: string; sha256: string; property: string }>;
}

describe("monitor-pr snapshot fixtures", () => {
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
    expect(result.snapshot.pullRequests[0]?.checks.map((check) => check.name)).toEqual(["z", "ä"]);
    expect(result.snapshot.pullRequests[0]?.checks.at(-1)?.conclusion).toBe("SUCCESS");
    expect(
      result.snapshot.pullRequests[0]?.supersededChecks.map((check) => [
        check.name,
        check.conclusion,
      ]),
    ).toEqual([["ä", "CANCELLED"]]);
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

  it("uses run sequence for a missing start without preferring an older active run", async () => {
    const result = await observeGitHubPullRequest(PR_URL, {
      runner: fixtureRunner("no-stack.json", "pr-queued.json"),
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error(result.error);
    expect(
      result.snapshot.pullRequests[0]?.checks.map((check) => [check.name, check.status, check.url]),
    ).toEqual([
      [
        "Build",
        "COMPLETED",
        "https://github.com/fixture-owner/fixture-repository/actions/runs/201",
      ],
      ["Check", "QUEUED", "https://github.com/fixture-owner/fixture-repository/actions/runs/101"],
    ]);
    expect(
      result.snapshot.pullRequests[0]?.supersededChecks.map((check) => [
        check.name,
        check.status,
        check.url,
      ]),
    ).toEqual([
      [
        "Build",
        "IN_PROGRESS",
        "https://github.com/fixture-owner/fixture-repository/actions/runs/200",
      ],
      [
        "Check",
        "COMPLETED",
        "https://github.com/fixture-owner/fixture-repository/actions/runs/100",
      ],
    ]);
  });

  it("fails closed when Stack membership omits the requested pull request", async () => {
    const base = fixtureRunner("stack.json");
    const runner: GhRunner = async (arguments_) => {
      const value = await base(arguments_);
      if (arguments_[0] !== "api" || !String(arguments_.at(-1)).includes("/stacks?")) return value;
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

  it("classifies multiple managed Stacks as a provider failure", async () => {
    const base = fixtureRunner("stack.json");
    const runner: GhRunner = async (arguments_) => {
      const value = await base(arguments_);
      if (arguments_[0] !== "api" || !String(arguments_.at(-1)).includes("/stacks?")) return value;
      const stacks = structuredClone(value) as unknown[];
      return [...stacks, ...stacks];
    };

    const result = await observeGitHubPullRequest(PR_URL, { runner });

    expect(result).toEqual({
      outcome: "provider-error",
      error: "GitHub returned multiple managed Stacks for the pull request",
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

function fixtureRunner(
  stackFixture: "stack.json" | "no-stack.json",
  pr8Fixture: "pr-8.json" | "pr-queued.json" = "pr-8.json",
): GhRunner {
  return async (arguments_) => {
    if (arguments_[0] === "api" && arguments_.at(-1) === "user") {
      expect(arguments_.slice(1, 3)).toEqual(["--hostname", "github.com"]);
      return fixture("user.json");
    }
    if (arguments_[0] === "api" && String(arguments_.at(-1)).includes("/stacks?")) {
      expect(arguments_.slice(1, 3)).toEqual(["--hostname", "github.com"]);
      return fixture(stackFixture);
    }
    if (arguments_[0] === "pr" && arguments_[1] === "view") {
      const number = Number(arguments_[2]);
      expect(arguments_[4]).toBe(`github.com/${OWNER}/${REPOSITORY}`);
      if (number === 8) return fixture(pr8Fixture);
      if ([7, 9].includes(number)) return fixture(`pr-${number}.json`);
    }
    throw new Error(`Unexpected fixture route: ${arguments_.join(" ")}`);
  };
}

async function fixture<T>(file: string): Promise<T> {
  const contents = await readFile(join(FIXTURES, file), "utf8");
  return JSON.parse(contents) as T;
}
