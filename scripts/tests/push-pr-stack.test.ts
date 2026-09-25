import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  parseAtomicPushArguments,
  pushGitHubStackAtomically,
  type AtomicPushRequest,
  type GitRunner,
} from "../../skills/development/push-pr-stack/scripts/push.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "push-pr-stack");

interface FixtureManifest {
  fixtures: Array<{ file: string; sha256: string; property: string }>;
}

describe("push-pr-stack fixtures", () => {
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

  it("classifies a timed-out push from verified remote state", async () => {
    const request = await fixture<AtomicPushRequest>("success.json");
    const landed = gitSimulation(request, { pushFailure: "timed-out-applied" });
    const stalled = gitSimulation(request, { pushFailure: "timed-out-unchanged" });

    expect(await pushGitHubStackAtomically(request, { runner: landed.runner })).toEqual({
      outcome: "ok",
      remote: request.remote,
      branches: request.branches.map((branch) => ({
        name: branch.name,
        previousSha: branch.expectedRemoteSha,
        pushedSha: branch.localSha,
      })),
    });
    expect(await pushGitHubStackAtomically(request, { runner: stalled.runner })).toEqual({
      outcome: "timeout",
      error: "Atomic Git push timed out: Git timed out after 1000ms",
    });
  });

  // The simulated runner above proves classification; this proves the default runner reports a
  // timeout instead of throwing past the readback. A slow pre-receive hook on a local bare remote
  // lets the push land after the deadline, which is the case that used to report `timeout`.
  it("reads back a real push that lands after the deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "push-pr-stack-timeout-"));
    const previous = process.cwd();
    try {
      const remote = join(root, "remote.git");
      const work = join(root, "work");
      await git(root, ["init", "-q", "--bare", remote]);
      await git(root, ["init", "-q", "-b", "main", work]);
      await git(work, [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "base",
      ]);
      await git(work, ["branch", "feature/foundation"]);
      await git(work, ["remote", "add", "origin", remote]);
      await git(work, ["push", "-q", "origin", "feature/foundation"]);
      const expectedRemoteSha = await git(work, ["rev-parse", "feature/foundation"]);
      await git(work, [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "next",
      ]);
      const localSha = await git(work, ["rev-parse", "HEAD"]);
      await git(work, ["branch", "-f", "feature/foundation", localSha]);
      const hook = join(remote, "hooks", "pre-receive");
      await writeFile(hook, "#!/bin/sh\nsleep 2\n");
      await chmod(hook, 0o755);

      process.chdir(work);
      const result = await pushGitHubStackAtomically(
        {
          remote: "origin",
          branches: [{ name: "feature/foundation", localSha, expectedRemoteSha }],
        },
        { timeoutMs: 500 },
      );

      expect(result).toEqual({
        outcome: "ok",
        remote: "origin",
        branches: [
          { name: "feature/foundation", previousSha: expectedRemoteSha, pushedSha: localSha },
        ],
      });
    } finally {
      process.chdir(previous);
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

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
    pushFailure?:
      | "unchanged"
      | "remote-changed"
      | "applied"
      | "timed-out-applied"
      | "timed-out-unchanged";
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
      if (changes.pushFailure === "timed-out-unchanged") {
        for (const branch of request.branches) {
          remote.set(branch.name, branch.expectedRemoteSha);
        }
      }
      if (changes.pushFailure?.startsWith("timed-out")) {
        return { exitCode: 1, stdout: "", stderr: "", timedOut: 1000 };
      }
      return success("");
    }
    return { exitCode: 1, stdout: "", stderr: `Unexpected Git command: ${arguments_.join(" ")}` };
  };
  return { runner, pushes };
}

async function git(cwd: string, arguments_: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...arguments_], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${arguments_.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function success(stdout: string): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout, stderr: "" };
}

async function fixture<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, file), "utf8")) as T;
}
