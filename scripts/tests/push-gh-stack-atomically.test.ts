import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  parseAtomicPushArguments,
  pushGitHubStackAtomically,
  type AtomicPushRequest,
  type GitRunner,
} from "../../skills/development/push-gh-stack-atomically/scripts/push.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "push-gh-stack-atomically");

interface FixtureManifest {
  fixtures: Array<{ file: string; sha256: string; property: string }>;
}

describe("push-gh-stack-atomically fixtures", () => {
  it("retains the recorded bytes for every Git state", async () => {
    const manifest = await fixture<FixtureManifest>("manifest.json");
    for (const entry of manifest.fixtures) {
      const bytes = await readFile(join(FIXTURES, entry.file));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.property).toBe(entry.sha256);
    }
  });
});

describe("atomic Stack push arguments", () => {
  it("parses explicit branch leases and rejects incomplete input", async () => {
    const request = await fixture<AtomicPushRequest>("success.json");
    const arguments_ = ["--remote", request.remote];
    for (const branch of request.branches) {
      arguments_.push("--branch", branch.name, branch.localSha, branch.expectedRemoteSha);
    }

    expect(parseAtomicPushArguments(arguments_)).toEqual(request);
    expect(() => parseAtomicPushArguments(["--remote", "origin", "--branch", "feature/a"])).toThrow(
      "requires a name, local SHA, and expected remote SHA",
    );
  });
});

describe("atomic Stack publication", () => {
  it("pushes every exact object under one atomic operation and verifies the result", async () => {
    const request = await fixture<AtomicPushRequest>("success.json");
    const simulation = gitSimulation(request);

    const result = await pushGitHubStackAtomically(request, { runner: simulation.runner });

    expect(result).toEqual({
      outcome: "ok",
      remote: "origin",
      branches: request.branches.map((branch) => ({
        name: branch.name,
        previousSha: branch.expectedRemoteSha,
        pushedSha: branch.localSha,
      })),
    });
    expect(simulation.pushes).toEqual([
      [
        "push",
        "--atomic",
        "origin",
        "--force-with-lease=refs/heads/feature/foundation:1111111111111111111111111111111111111111",
        "--force-with-lease=refs/heads/feature/consumer:2222222222222222222222222222222222222222",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/feature/foundation",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:refs/heads/feature/consumer",
      ],
    ]);
  });

  it("refuses stale local or remote observations before pushing", async () => {
    const request = await fixture<AtomicPushRequest>("success.json");
    const localChanged = gitSimulation(request, { localChanged: "feature/foundation" });
    const remoteChanged = gitSimulation(request, { remoteChanged: "feature/consumer" });

    expect(await pushGitHubStackAtomically(request, { runner: localChanged.runner })).toEqual({
      outcome: "input-changed",
      error: "Local branch changed: feature/foundation",
    });
    expect(await pushGitHubStackAtomically(request, { runner: remoteChanged.runner })).toEqual({
      outcome: "input-changed",
      error: "Remote branch changed: feature/consumer",
    });
    expect(localChanged.pushes).toHaveLength(0);
    expect(remoteChanged.pushes).toHaveLength(0);
  });
});

function gitSimulation(
  request: AtomicPushRequest,
  changes: { localChanged?: string; remoteChanged?: string } = {},
): { runner: GitRunner; pushes: string[][] } {
  const local = new Map(request.branches.map((branch) => [branch.name, branch.localSha]));
  const remote = new Map(request.branches.map((branch) => [branch.name, branch.expectedRemoteSha]));
  if (changes.localChanged) local.set(changes.localChanged, "c".repeat(40));
  if (changes.remoteChanged) remote.set(changes.remoteChanged, "d".repeat(40));
  const pushes: string[][] = [];
  const runner: GitRunner = async (arguments_) => {
    if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel") {
      return success("/fixture/repository\n");
    }
    if (arguments_[0] === "check-ref-format") return success("");
    if (arguments_[0] === "rev-parse" && arguments_[1] === "--verify") {
      const name = String(arguments_[2])
        .replace(/^refs\/heads\//, "")
        .replace(/\^\{commit\}$/, "");
      return success(`${local.get(name) ?? ""}\n`);
    }
    if (arguments_[0] === "ls-remote") {
      return success(
        arguments_
          .slice(3)
          .map((ref) => {
            const name = ref.replace(/^refs\/heads\//, "");
            return `${remote.get(name) ?? ""}\t${ref}`;
          })
          .join("\n") + "\n",
      );
    }
    if (arguments_[0] === "push") {
      pushes.push([...arguments_]);
      for (const branch of request.branches) remote.set(branch.name, branch.localSha);
      return success("");
    }
    return { exitCode: 1, stdout: "", stderr: `Unexpected Git command: ${arguments_.join(" ")}` };
  };
  return { runner, pushes };
}

function success(stdout: string): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout, stderr: "" };
}

async function fixture<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, file), "utf8")) as T;
}
