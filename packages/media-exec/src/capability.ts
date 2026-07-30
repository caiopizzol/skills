import { errorMessage, isPermissionDeniedResult, type ExecBoundary, type ExecResult } from "./exec.ts";
import { DEFAULT_TIMEOUT_MS, runTool } from "./run-tool.ts";

// Capability discovery is the stage that decides whether any work can happen at all. It reports a
// stage and an outcome rather than a single boolean, because "no binary on the host", "no docker
// client", "the daemon refused", "that pinned image is not here", and "the version query hung" are
// several different facts and a caller acts on each of them differently. Collapsing them into one
// unavailable token is exactly the flattening this repository exists to prevent.
//
// `host-tool` and `container-tool` are the same missing binary in two different places: one is
// fixed by installing something, the other by choosing an image that carries the tool.

export type CapabilityStage = "host-tool" | "container-tool" | "container-runtime" | "container-image" | "version-query";

export type CapabilityOutcome = "ok" | "tool-unavailable" | "access-denied" | "image-unavailable" | "failed" | "timeout";

export interface CapabilityUnavailable {
  outcome: Exclude<CapabilityOutcome, "ok">;
  stage: CapabilityStage;
  message: string;
}

export interface ContainerIdentity {
  requestedImage: string;
  imageId: string;
}

export async function resolveLocalContainerImage(options: {
  requestedImage: string;
  dockerExec: ExecBoundary;
  cwd: string;
  timeoutMs?: number;
}): Promise<ContainerIdentity | CapabilityUnavailable> {
  const run = await runTool(
    options.dockerExec,
    { command: "docker", args: ["image", "inspect", "--format", "{{.Id}}", options.requestedImage], cwd: options.cwd },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    { writesOutput: false },
  );
  if (run.kind === "tool-unavailable") {
    return { outcome: "tool-unavailable", stage: "container-runtime", message: "docker is not available in this runtime" };
  }
  if (run.kind === "timeout") {
    return { outcome: "timeout", stage: "container-image", message: run.message };
  }
  if (run.kind === "error") {
    return { outcome: "failed", stage: "container-runtime", message: run.message };
  }
  if (isPermissionDeniedResult(run.result)) {
    return {
      outcome: "access-denied",
      stage: "container-runtime",
      message: `the docker daemon refused this runtime: ${run.result.stderr.trim() || "no stderr"}`,
    };
  }
  if (run.result.exitCode !== 0) {
    // Only a daemon that answered "I do not have that image" means the image is absent. A daemon
    // that is stopped, unreachable, or otherwise broken also exits non-zero, and reporting that as
    // a missing image sends the caller to pull something when the runtime is the problem.
    if (!isMissingImageResult(run.result)) {
      return {
        outcome: "failed",
        stage: "container-runtime",
        message: `docker could not inspect the image: ${run.result.stderr.trim() || "no stderr"}`,
      };
    }
    return {
      outcome: "image-unavailable",
      stage: "container-image",
      message: `digest-pinned container image is not present locally: ${options.requestedImage}`,
    };
  }
  const imageId = run.result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
    return {
      outcome: "failed",
      stage: "container-image",
      message: `docker returned an invalid local image identity for ${options.requestedImage}`,
    };
  }
  return { requestedImage: options.requestedImage, imageId };
}

// Docker says "No such image" when it looked and found nothing. Anything else non-zero means the
// question could not be answered, which is a different fact and a different fix.
export function isMissingImageResult(result: ExecResult): boolean {
  return /no such image|no such object|reference does not exist|manifest unknown/i.test(result.stderr);
}

export interface ToolVersion {
  command: string;
  version: string;
}

export type ReadVersionsResult =
  | { outcome: "ok"; versions: ToolVersion[] }
  | CapabilityUnavailable;

// Version strings are metadata about a tool that is already known to work, never the gate that
// decides whether it does. Callers run their first real operation first, so a static image is not
// refused because a converter it never needs is absent.
export async function readToolVersions(options: {
  exec: ExecBoundary;
  commands: readonly string[];
  cwd: string;
  timeoutMs?: number;
  // Which stage an absent tool belongs to. A missing binary inside a caller-supplied container
  // image is a fact about that image, not about the host, and the two have different fixes.
  toolStage?: Extract<CapabilityStage, "host-tool" | "container-tool">;
}): Promise<ReadVersionsResult> {
  const versions: ToolVersion[] = [];
  for (const command of options.commands) {
    const run = await runTool(
      options.exec,
      { command, args: ["-version"], cwd: options.cwd },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      { writesOutput: false },
    );
    if (run.kind === "tool-unavailable") {
      return { outcome: "tool-unavailable", stage: options.toolStage ?? "host-tool", message: run.message };
    }
    if (run.kind === "timeout") return { outcome: "timeout", stage: "version-query", message: run.message };
    if (run.kind === "error") return { outcome: "failed", stage: "version-query", message: run.message };
    if (run.result.exitCode !== 0) {
      return {
        outcome: "failed",
        stage: "version-query",
        message: `${command} version check failed: ${run.result.stderr.trim() || "no stderr"}`,
      };
    }
    versions.push({ command, version: run.result.stdout.split("\n", 1)[0]?.trim() ?? "" });
  }
  return { outcome: "ok", versions };
}

export function capabilityFromError(stage: CapabilityStage, error: unknown): CapabilityUnavailable {
  return { outcome: "failed", stage, message: errorMessage(error) };
}
