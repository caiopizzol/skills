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

  it("classifies failed pushes from verified remote state instead of error wording", async () => {
    const request = await fixture<AtomicPushRequest>("success.json");
    const providerRejected = gitSimulation(request, { pushFailure: "unchanged" });
    const raced = gitSimulation(request, { pushFailure: "remote-changed" });
    const responseLost = gitSimulation(request, { pushFailure: "applied" });

    expect(await pushGitHubStackAtomically(request, { runner: providerRejected.runner })).toEqual({
      outcome: "provider-error",
      error:
        "Atomic Git push failed: remote: protected branch hook declined\n! [remote rejected] feature/foundation (pre-receive hook declined)",
    });
    expect(await pushGitHubStackAtomically(request, { runner: raced.runner })).toEqual({
      outcome: "input-changed",
      error: "Atomic Git push failed: ! [rejected] feature/foundation (stale info)",
    });
    expect(await pushGitHubStackAtomically(request, { runner: responseLost.runner })).toEqual({
      outcome: "ok",
      remote: request.remote,
      branches: request.branches.map((branch) => ({
        name: branch.name,
        previousSha: branch.expectedRemoteSha,
        pushedSha: branch.localSha,
      })),
    });
  });

  it("preserves push diagnostics when post-push verification cannot complete", async () => {
    const request = await fixture<AtomicPushRequest>("success.json");
    const verificationUnavailable = gitSimulation(request, {
      pushFailure: "remote-changed",
      postPushReadFailure: "transport",
    });
    const branchUnavailable = gitSimulation(request, {
      pushFailure: "remote-changed",
      postPushReadFailure: "missing",
    });

    expect(
      await pushGitHubStackAtomically(request, { runner: verificationUnavailable.runner }),
    ).toEqual({
      outcome: "provider-error",
      error:
        "Atomic Git push failed: ! [rejected] feature/foundation (stale info); post-push verification failed: Unable to read remote branch heads: connection reset",
    });
    expect(await pushGitHubStackAtomically(request, { runner: branchUnavailable.runner })).toEqual({
      outcome: "input-changed",
      error:
        "Atomic Git push failed: ! [rejected] feature/foundation (stale info); post-push verification failed: Remote branch is unavailable: feature/foundation",
    });
  });
});

function gitSimulation(
  request: AtomicPushRequest,
  changes: {
    localChanged?: string;
    remoteChanged?: string;
    pushFailure?: "unchanged" | "remote-changed" | "applied";
    postPushReadFailure?: "transport" | "missing";
  } = {},
): { runner: GitRunner; pushes: string[][] } {
  const local = new Map(request.branches.map((branch) => [branch.name, branch.localSha]));
  const remote = new Map(request.branches.map((branch) => [branch.name, branch.expectedRemoteSha]));
  if (changes.localChanged) local.set(changes.localChanged, "c".repeat(40));
  if (changes.remoteChanged) remote.set(changes.remoteChanged, "d".repeat(40));
  const pushes: string[][] = [];
  let remoteReads = 0;
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
      remoteReads += 1;
      if (remoteReads > 1 && changes.postPushReadFailure === "transport") {
        return { exitCode: 1, stdout: "", stderr: "connection reset" };
      }
      const missingRef =
        remoteReads > 1 && changes.postPushReadFailure === "missing"
          ? `refs/heads/${request.branches[0]!.name}`
          : undefined;
      return success(
        arguments_
          .slice(3)
          .filter((ref) => ref !== missingRef)
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
      if (changes.pushFailure === "remote-changed") {
        remote.set(request.branches[0]!.name, "e".repeat(40));
        return {
          exitCode: 1,
          stdout: "",
          stderr: "! [rejected] feature/foundation (stale info)",
        };
      }
      if (changes.pushFailure === "unchanged") {
        for (const branch of request.branches) {
          remote.set(branch.name, branch.expectedRemoteSha);
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "remote: protected branch hook declined\n! [remote rejected] feature/foundation (pre-receive hook declined)",
        };
      }
      if (changes.pushFailure === "applied") {
        return { exitCode: 1, stdout: "", stderr: "error: remote hung up unexpectedly" };
      }
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
