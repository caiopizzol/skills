import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import {
  createContainerExec,
  detectInputChange,
  execWithBun,
  readSourceIdentity,
  readToolVersions,
  resolveLocalContainerImage,
  type CapabilityUnavailable,
  type ContainerIdentity,
  type ExecBoundary,
  type InputChanged,
  type ToolVersion,
} from "@caiopizzol/media-exec";
import {
  extractAudio,
  extractFrames,
  probeVideo,
  type ExtractAudioResult,
  type ExtractFramesResult,
  type ProbeVideoResult,
} from "@caiopizzol/video-tools";
import type { PrepareArguments } from "./arguments.ts";

export const FFMPEG_COMMANDS = ["ffmpeg", "ffprobe"] as const;

export interface VideoCapability {
  mode: "host" | "container";
  image?: ContainerIdentity;
  // Versions describe a tool already proven to work. A version query that fails leaves this null
  // and records why, rather than turning working tooling into an unavailable capability.
  versions: ToolVersion[] | null;
  versionGap?: CapabilityUnavailable;
}

export interface PrepareVideoResult {
  formatVersion: 1;
  file: { path: string; bytes: number; sha256: string };
  artifacts: { directory: string; mode: "caller-provided" | "temporary" };
  capability: VideoCapability | null;
  capabilityGap: CapabilityUnavailable | null;
  probe: ProbeVideoResult | null;
  frames: ExtractFramesResult | null;
  audio: ExtractAudioResult | null;
  inputChanged: InputChanged | null;
}

export async function prepareVideo(
  args: PrepareArguments,
  options: { cwd?: string; hostExec?: ExecBoundary; dockerExec?: ExecBoundary } = {},
): Promise<PrepareVideoResult> {
  const cwd = options.cwd ?? process.cwd();
  const inputPath = resolve(cwd, args.inputPath);
  const requestedArtifactsDirectory = args.artifactsDirectory === undefined
    ? undefined
    : resolve(cwd, args.artifactsDirectory);
  if (inputPath === requestedArtifactsDirectory) throw new Error("the input and artifacts directory must differ");
  const inputStats = await stat(inputPath);
  if (!inputStats.isFile()) throw new Error(`input is not a regular file: ${inputPath}`);
  const { identity } = await readSourceIdentity(inputPath);
  const artifacts = requestedArtifactsDirectory === undefined
    ? { directory: await mkdtemp(join(tmpdir(), "video-tools-")), mode: "temporary" as const }
    : { directory: requestedArtifactsDirectory, mode: "caller-provided" as const };
  const artifactsDirectory = artifacts.directory;
  await mkdir(artifactsDirectory, { recursive: true });
  const file = { path: identity.path, bytes: identity.bytes, sha256: identity.sha256 };
  const empty = { formatVersion: 1 as const, file, artifacts, probe: null, frames: null, audio: null, inputChanged: null };

  let exec = options.hostExec ?? execWithBun;
  let image: ContainerIdentity | undefined;
  if (args.containerImage !== undefined) {
    const resolved = await resolveLocalContainerImage({
      requestedImage: args.containerImage,
      dockerExec: options.dockerExec ?? execWithBun,
      cwd,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
    if ("outcome" in resolved) return { ...empty, capability: null, capabilityGap: resolved };
    image = resolved;
    exec = createContainerExec({
      identity: resolved,
      inputPath,
      artifactsDirectory,
      allowedCommands: FFMPEG_COMMANDS,
      ...(options.dockerExec === undefined ? {} : { dockerExec: options.dockerExec }),
    });
  }

  // Probe first. It is the operation whose structured outcome already distinguishes an absent
  // binary from a broken run, so it decides capability instead of a version string doing it.
  const toolStage = image === undefined ? "host-tool" as const : "container-tool" as const;
  const probe = await probeVideo({ inputPath, cwd, exec, ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }) });
  if (probe.outcome === "tool-unavailable") {
    // A tool missing from a caller-supplied image is a fact about that image, not about the host.
    return { ...empty, capability: null, capabilityGap: { outcome: "tool-unavailable", stage: toolStage, message: probe.message } };
  }

  const versions = await readToolVersions({
    exec,
    commands: FFMPEG_COMMANDS,
    cwd,
    toolStage,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  const capability: VideoCapability = {
    mode: image === undefined ? "host" : "container",
    ...(image === undefined ? {} : { image }),
    versions: versions.outcome === "ok" ? versions.versions : null,
    ...(versions.outcome === "ok" ? {} : { versionGap: versions }),
  };
  if (probe.outcome !== "ok") return { ...empty, capability, capabilityGap: null, probe };

  const written: string[] = [];
  const frames = await extractFrames({
    inputPath,
    parentSha256: identity.sha256,
    artifactsDirectory,
    durationSeconds: probe.probe.durationSeconds,
    ...(args.frameCount === undefined ? {} : { frameCount: args.frameCount }),
    cwd,
    exec,
    ...(args.maxFrames === undefined ? {} : { maxFrames: args.maxFrames }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  if (frames.outcome === "ok") written.push(...frames.frames.map((frame) => frame.derivative.path));
  const audio = probe.probe.hasAudioStream
    ? await extractAudio({
        inputPath,
        parentSha256: identity.sha256,
        artifactsDirectory,
        probe: probe.probe,
        cwd,
        exec,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      })
    : null;
  if (audio?.outcome === "ok") written.push(audio.derivative.path);

  const inputChanged = await detectInputChange({ identity, writtenPaths: written });
  if (inputChanged) return { ...empty, capability, capabilityGap: null, probe, inputChanged };
  return { formatVersion: 1, file, artifacts, capability, capabilityGap: null, probe, frames, audio, inputChanged: null };
}

export function isComplete(result: PrepareVideoResult): boolean {
  if (result.capabilityGap !== null || result.inputChanged !== null) return false;
  if (result.probe?.outcome !== "ok" || result.frames?.outcome !== "ok") return false;
  if (!result.probe.probe.hasAudioStream) return true;
  if (result.audio?.outcome !== "ok") return false;
  // A source with several audio streams is not fully read after one of them. Reporting complete
  // coverage here is the same overclaim the frame lane already refuses to make.
  return result.audio.selection.omittedStreamIndexes.length === 0;
}
