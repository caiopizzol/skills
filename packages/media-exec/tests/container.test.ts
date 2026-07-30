import { describe, expect, it } from "vite-plus/test";
import { buildBindMount, createContainerExec, mountField, type ExecRequest } from "../src/index.ts";

const IDENTITY = {
  requestedImage: `example@sha256:${"a".repeat(64)}`,
  imageId: `sha256:${"b".repeat(64)}`,
};

// A --mount value is a comma-separated field list, so an unquoted path containing a comma stops
// being a path. Docker parses these fields as CSV, so quoting is what carries the comma through.
describe("bind mount encoding", () => {
  it("leaves an ordinary path unquoted", () => {
    expect(mountField("src", "/tmp/run/input.png")).toBe("src=/tmp/run/input.png");
  });

  it("quotes a path containing a comma so it stays one field", () => {
    expect(mountField("src", "/tmp/report,v2/input.png")).toBe('"src=/tmp/report,v2/input.png"');
  });

  it("escapes an embedded quote rather than terminating the field early", () => {
    expect(mountField("src", '/tmp/a"b,c')).toBe('"src=/tmp/a""b,c"');
  });

  it("keeps readonly a distinct field that a crafted path cannot displace", () => {
    const mount = buildBindMount("/tmp/in,readonly=false/a.png", true);

    expect(mount).toBe(
      'type=bind,"src=/tmp/in,readonly=false/a.png","dst=/tmp/in,readonly=false/a.png",readonly',
    );
    expect(mount.endsWith(",readonly")).toBe(true);
  });
});

describe("container executor", () => {
  it("refuses a command outside the allowed set", async () => {
    const exec = createContainerExec({
      identity: IDENTITY,
      inputPath: "/tmp/a.png",
      artifactsDirectory: "/tmp/art",
      allowedCommands: ["ffmpeg", "ffprobe"],
      dockerExec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      userId: 1000,
      groupId: 1000,
    });

    await expect(exec({ command: "sh", args: ["-c", "id"], cwd: "/tmp" })).rejects.toThrow(
      /refuses unexpected command/,
    );
  });

  it("runs the allowed command with network, capabilities, and write access removed", async () => {
    const requests: ExecRequest[] = [];
    const exec = createContainerExec({
      identity: IDENTITY,
      inputPath: "/tmp/a.png",
      artifactsDirectory: "/tmp/art",
      allowedCommands: ["ffprobe"],
      dockerExec: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      userId: 1000,
      groupId: 1000,
    });

    await exec({ command: "ffprobe", args: ["-version"], cwd: "/tmp" });

    const args = requests[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--pull",
        "never",
      ]),
    );
    expect(args).toEqual(expect.arrayContaining(["--entrypoint", "ffprobe"]));
    expect(args.includes("--tmpfs")).toBe(false);
  });

  it("adds a bounded tmpfs only when the caller asks for scratch space", async () => {
    const requests: ExecRequest[] = [];
    const exec = createContainerExec({
      identity: IDENTITY,
      inputPath: "/tmp/a.png",
      artifactsDirectory: "/tmp/art",
      allowedCommands: ["magick"],
      tmpfsSizeMegabytes: 64,
      dockerExec: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      userId: 1000,
      groupId: 1000,
    });

    await exec({ command: "magick", args: ["-version"], cwd: "/tmp" });

    expect(requests[0]?.args).toEqual(
      expect.arrayContaining(["--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"]),
    );
  });
});
