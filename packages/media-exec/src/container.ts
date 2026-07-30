import type { ContainerIdentity } from "./capability.ts";
import { execWithBun, type ExecBoundary } from "./exec.ts";

export interface ContainerExecOptions {
  identity: ContainerIdentity;
  inputPath: string;
  artifactsDirectory: string;
  allowedCommands: readonly string[];
  dockerExec?: ExecBoundary;
  userId?: number;
  groupId?: number;
  // ImageMagick decoders write scratch files; ffmpeg does not need them. Only the callers that do
  // ask for a bounded in-memory /tmp, so the container surface stays as small as each tool needs.
  tmpfsSizeMegabytes?: number;
}

// A --mount value is a comma-separated list of key=value fields, so a path containing a comma
// silently becomes extra fields. Docker parses these fields as CSV, which means a quoted field
// carries its commas intact. Quoting the whole `key=value` is what keeps `/tmp/report,v2` a path
// instead of an unparseable field or, worse, a field that looks like an option.
export function mountField(key: string, value: string): string {
  if (!value.includes(",") && !value.includes('"')) return `${key}=${value}`;
  return `"${key}=${value.replaceAll('"', '""')}"`;
}

export function buildBindMount(path: string, readonly: boolean): string {
  const fields = ["type=bind", mountField("src", path), mountField("dst", path)];
  if (readonly) fields.push("readonly");
  return fields.join(",");
}

export function createContainerExec(options: ContainerExecOptions): ExecBoundary {
  const dockerExec = options.dockerExec ?? execWithBun;
  const userId = options.userId ?? process.getuid?.();
  const groupId = options.groupId ?? process.getgid?.();
  if (userId === undefined || groupId === undefined) {
    throw new Error("container execution requires the current numeric user and group IDs");
  }
  const allowed = new Set(options.allowedCommands);
  return async (request) => {
    if (!allowed.has(request.command)) {
      throw new Error(`container executor refuses unexpected command: ${request.command}`);
    }
    return dockerExec({
      command: "docker",
      args: [
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", `${userId}:${groupId}`,
        ...(options.tmpfsSizeMegabytes === undefined
          ? []
          : ["--tmpfs", `/tmp:rw,noexec,nosuid,size=${options.tmpfsSizeMegabytes}m`]),
        "--mount", buildBindMount(options.inputPath, true),
        "--mount", buildBindMount(options.artifactsDirectory, false),
        "--entrypoint", request.command,
        options.identity.imageId,
        ...request.args,
      ],
      cwd: request.cwd,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
  };
}
