import { describe, expect, it } from "vitest";
import {
  readToolVersions,
  resolveLocalContainerImage,
  type ExecBoundary,
  type ExecResult,
} from "../src/index.ts";

const CWD = "/fixture/run";
const PINNED = "dpokidov/imagemagick@sha256:87998ec1b8127b2f73f626f74f7b05e8827f9d7605fa52da5370588f7e53cee1";

function exec(handler: (command: string) => ExecResult | Promise<ExecResult>): ExecBoundary {
  return async (request) => handler(request.command);
}

function missing(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT", syscall: `spawn ${command}` });
}

// A boundary that outlives its deadline and then settles, the way execWithBun does when it kills a
// child. runTool waits for the executor to settle before reporting a timeout so cleanup cannot race
// a process that is still writing, so a boundary that never settles would never report at all.
// A boundary that never settles at all, which is what a wedged process looks like. Discovery writes
// nothing, so it must report the deadline rather than wait for this to return.
function neverSettles(): ExecBoundary {
  return () => new Promise<ExecResult>(() => {});
}

function hangsUntilKilled(): ExecBoundary {
  return async ({ timeoutMs }) =>
    new Promise<ExecResult>((settle) => {
      setTimeout(() => settle({ exitCode: 137, stdout: "", stderr: "killed" }), (timeoutMs ?? 0) + 10);
    });
}

// Each of these is a different fact about the runtime, and a caller acts on each differently:
// install a tool, grant a group, pull an image, or retry. Flattening them into one token is the
// failure this table exists to prevent.
describe("capability discovery keeps its stages distinct", () => {
  it("reports an absent docker client as a container-runtime tool-unavailable", async () => {
    const result = await resolveLocalContainerImage({
      requestedImage: PINNED,
      dockerExec: async () => { throw missing("docker"); },
      cwd: CWD,
    });

    expect(result).toMatchObject({ outcome: "tool-unavailable", stage: "container-runtime" });
  });

  it("reports a refusing daemon as access-denied rather than absent", async () => {
    const result = await resolveLocalContainerImage({
      requestedImage: PINNED,
      dockerExec: exec(() => ({ exitCode: 1, stdout: "", stderr: "Got permission denied while trying to connect to the Docker daemon socket" })),
      cwd: CWD,
    });

    expect(result).toMatchObject({ outcome: "access-denied", stage: "container-runtime" });
  });

  // A stopped daemon also exits non-zero. Calling that a missing image sends the caller to pull
  // something when the runtime is what is broken.
  it("separates an unreachable daemon from an absent image", async () => {
    const unreachable = await resolveLocalContainerImage({
      requestedImage: PINNED,
      dockerExec: exec(() => ({ exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" })),
      cwd: CWD,
    });

    expect(unreachable).toMatchObject({ outcome: "failed", stage: "container-runtime" });
  });

  it("attributes a tool missing inside a caller-supplied image to that image, not the host", async () => {
    const result = await readToolVersions({
      exec: async () => { throw missing("identify"); },
      commands: ["identify"],
      cwd: CWD,
      toolStage: "container-tool",
    });

    expect(result).toMatchObject({ outcome: "tool-unavailable", stage: "container-tool" });
  });

  it("reports an absent local image as image-unavailable, not a missing runtime", async () => {
    const result = await resolveLocalContainerImage({
      requestedImage: PINNED,
      dockerExec: exec(() => ({ exitCode: 1, stdout: "", stderr: "Error response from daemon: No such image: example" })),
      cwd: CWD,
    });

    expect(result).toMatchObject({ outcome: "image-unavailable", stage: "container-image" });
  });

  it("bounds image inspection with the caller's deadline instead of hanging", async () => {
    const result = await resolveLocalContainerImage({
      requestedImage: PINNED,
      dockerExec: hangsUntilKilled(),
      cwd: CWD,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ outcome: "timeout", stage: "container-image" });
  });

  it("reports an image-inspection deadline even when the executor never settles", async () => {
    const result = await resolveLocalContainerImage({ requestedImage: PINNED, dockerExec: neverSettles(), cwd: CWD, timeoutMs: 20 });

    expect(result).toMatchObject({ outcome: "timeout", stage: "container-image" });
  });

  it("records the requested digest and resolved local image identity", async () => {
    const requested = `example.invalid/other@sha256:${"a".repeat(64)}`;
    const result = await resolveLocalContainerImage({
      requestedImage: requested,
      dockerExec: exec(() => ({ exitCode: 0, stdout: `sha256:${"b".repeat(64)}\n`, stderr: "" })),
      cwd: CWD,
    });

    expect(result).toEqual({ requestedImage: requested, imageId: `sha256:${"b".repeat(64)}` });
  });
});

describe("version discovery is metadata, not a capability gate", () => {
  it("bounds a hung version query with the caller's deadline", async () => {
    const result = await readToolVersions({
      exec: hangsUntilKilled(),
      commands: ["ffprobe"],
      cwd: CWD,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ outcome: "timeout", stage: "version-query" });
  });

  it("reports the deadline even when the executor never settles", async () => {
    const result = await readToolVersions({ exec: neverSettles(), commands: ["ffprobe"], cwd: CWD, timeoutMs: 20 });

    expect(result).toMatchObject({ outcome: "timeout", stage: "version-query" });
  });

  it("separates a failed version query from an absent binary", async () => {
    const failed = await readToolVersions({
      exec: exec(() => ({ exitCode: 1, stdout: "", stderr: "unrecognized option" })),
      commands: ["ffprobe"],
      cwd: CWD,
    });
    const absent = await readToolVersions({
      exec: async () => { throw missing("ffprobe"); },
      commands: ["ffprobe"],
      cwd: CWD,
    });

    expect(failed).toMatchObject({ outcome: "failed", stage: "version-query" });
    expect(absent).toMatchObject({ outcome: "tool-unavailable", stage: "host-tool" });
  });

  it("returns one version per requested command", async () => {
    const result = await readToolVersions({
      exec: exec((command) => ({ exitCode: 0, stdout: `${command} 7.1\nbuild details\n`, stderr: "" })),
      commands: ["ffmpeg", "ffprobe"],
      cwd: CWD,
    });

    expect(result).toEqual({
      outcome: "ok",
      versions: [{ command: "ffmpeg", version: "ffmpeg 7.1" }, { command: "ffprobe", version: "ffprobe 7.1" }],
    });
  });
});
