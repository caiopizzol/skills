import { resolve } from "node:path";
import { mkdir, stat } from "node:fs/promises";
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
  classifyInput,
  convertImage,
  expandGifFrames,
  identifyImage,
  inspectSvgSafety,
  type ConvertImageResult,
  type ExpandGifFramesResult,
  type IdentifyImageResult,
  type InputClassification,
  type InspectSvgSafetyResult,
} from "@caiopizzol/image-tools";
import type { PrepareArguments } from "./arguments.ts";

export const IMAGE_COMMANDS = ["magick", "identify"] as const;
export const CONTAINER_TMPFS_MEGABYTES = 64;

const CONVERTED_FORMATS = new Set(["AVIF", "HEIC", "HEIF", "BMP", "SVG"]);
const SUPPORTED_FORMATS = new Set(["PNG", "JPEG", "JPG", "WEBP", "TIFF", "TIF", "GIF", ...CONVERTED_FORMATS]);

// Formats an SVG-family coder can produce. An identification landing on one of these is the trigger
// for the invariant below, whatever the filename said and whatever the classifier concluded.
const SVG_FORMATS = new Set(["SVG", "SVGZ", "MSVG"]);

export interface ImageCapability {
  mode: "host" | "container";
  image?: ContainerIdentity;
  versions: ToolVersion[] | null;
  versionGap?: CapabilityUnavailable;
}

export interface PrepareImageResult {
  formatVersion: 1;
  file: { path: string; bytes: number; sha256: string };
  classification: InputClassification;
  capability: ImageCapability | null;
  capabilityGap: CapabilityUnavailable | null;
  svgSafety: InspectSvgSafetyResult | null;
  identify: IdentifyImageResult | null;
  derivative: ConvertImageResult | ExpandGifFramesResult | null;
  inputChanged: InputChanged | null;
}

export async function prepareImage(
  args: PrepareArguments,
  options: { cwd?: string; hostExec?: ExecBoundary; dockerExec?: ExecBoundary } = {},
): Promise<PrepareImageResult> {
  const cwd = options.cwd ?? process.cwd();
  const inputPath = resolve(cwd, args.inputPath);
  const artifactsDirectory = resolve(cwd, args.artifactsDirectory);
  if (inputPath === artifactsDirectory) throw new Error("the input and artifacts directory must differ");
  const inputStats = await stat(inputPath);
  if (!inputStats.isFile()) throw new Error(`input is not a regular file: ${inputPath}`);
  const { identity, bytes } = await readSourceIdentity(inputPath);
  await mkdir(artifactsDirectory, { recursive: true });
  const file = { path: identity.path, bytes: identity.bytes, sha256: identity.sha256 };

  const classification = classifyInput(inputPath, bytes);
  const base = {
    formatVersion: 1 as const,
    file,
    classification,
    capability: null,
    capabilityGap: null,
    svgSafety: null,
    identify: null,
    derivative: null,
    inputChanged: null,
  };

  // Compressed content cannot be inspected as text, and decompressing an untrusted archive to look
  // inside would trade one hazard for another. It is refused before any tool runs.
  if (classification.kind === "compressed-input") {
    return {
      ...base,
      svgSafety: {
        outcome: "unsafe-input",
        operation: "inspect-svg",
        inputPath,
        verdict: {
          formatVersion: 1,
          selfContained: false,
          reasons: [{ code: "compressed-input", detail: classification.reason }],
        },
      },
    };
  }

  // Inspect every candidate before a rasterizer sees it. This reduces exposure; it does not
  // establish safety on its own, because the classifier and the renderer can disagree.
  let svgSafety: InspectSvgSafetyResult | null = null;
  if (classification.kind === "textual-svg-candidate") {
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ...base,
        svgSafety: {
          outcome: "unsafe-input",
          operation: "inspect-svg",
          inputPath,
          verdict: {
            formatVersion: 1,
            selfContained: false,
            reasons: [{
              code: "undecodable-candidate",
              detail: "the input looks like an SVG document but is not valid UTF-8, so its safety cannot be established",
            }],
          },
        },
      };
    }
    svgSafety = inspectSvgSafety({ inputPath, source, cwd });
    if (svgSafety.outcome === "unsafe-input") return { ...base, svgSafety };
  }

  let exec = options.hostExec ?? execWithBun;
  let image: ContainerIdentity | undefined;
  if (args.containerImage !== undefined) {
    const resolved = await resolveLocalContainerImage({
      requestedImage: args.containerImage,
      dockerExec: options.dockerExec ?? execWithBun,
      cwd,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
    if ("outcome" in resolved) return { ...base, svgSafety, capabilityGap: resolved };
    image = resolved;
    exec = createContainerExec({
      identity: resolved,
      inputPath,
      artifactsDirectory,
      allowedCommands: IMAGE_COMMANDS,
      tmpfsSizeMegabytes: CONTAINER_TMPFS_MEGABYTES,
      ...(options.dockerExec === undefined ? {} : { dockerExec: options.dockerExec }),
    });
  }

  // Identify first. It reads headers with -ping rather than decoding pixels, and its structured
  // outcome already separates an absent binary from a broken run, so it decides capability instead
  // of a version string doing it. A static PNG therefore never needs `magick` to be present.
  const toolStage = image === undefined ? "host-tool" as const : "container-tool" as const;
  const identify = await identifyImage({ inputPath, cwd, exec, ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }) });
  if (identify.outcome === "tool-unavailable") {
    // A tool missing from a caller-supplied image is a fact about that image, not about the host.
    return { ...base, svgSafety, capabilityGap: { outcome: "tool-unavailable", stage: toolStage, message: identify.message } };
  }

  const versions = await readToolVersions({
    exec,
    commands: IMAGE_COMMANDS,
    cwd,
    toolStage,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  const capability: ImageCapability = {
    mode: image === undefined ? "host" : "container",
    ...(image === undefined ? {} : { image }),
    versions: versions.outcome === "ok" ? versions.versions : null,
    ...(versions.outcome === "ok" ? {} : { versionGap: versions }),
  };
  if (identify.outcome !== "ok") return { ...base, svgSafety, capability, identify };

  const format = identify.identity.format.toUpperCase();

  // The invariant. No SVG identification result may reach conversion without an `ok` safety
  // verdict. The classifier above is a heuristic and the renderer's own sniffing rules are outside
  // this repository's control, so this is the rule that does not depend on either being right.
  if (SVG_FORMATS.has(format) && svgSafety?.outcome !== "ok") {
    return {
      ...base,
      svgSafety: {
        outcome: "unsafe-input",
        operation: "inspect-svg",
        inputPath,
        verdict: {
          formatVersion: 1,
          selfContained: false,
          reasons: [{
            code: "unverified-svg",
            detail: `the file was identified as ${format} but no safety inspection had established it as self-contained, so it was refused rather than rasterized`,
          }],
        },
      },
      capability,
      identify,
    };
  }

  if (!SUPPORTED_FORMATS.has(format)) {
    return {
      ...base,
      svgSafety,
      capability,
      identify: {
        outcome: "unsupported-input",
        operation: "identify",
        inputPath,
        message: `identified format is outside the supported routing table: ${format}`,
      },
    };
  }

  const shared = {
    inputPath,
    parentSha256: identity.sha256,
    artifactsDirectory,
    cwd,
    exec,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  };
  const derivative = identify.identity.frameCount > 1
    ? await expandGifFrames({ ...shared, frameCount: identify.identity.frameCount, ...(args.maxFrames === undefined ? {} : { maxFrames: args.maxFrames }) })
    : CONVERTED_FORMATS.has(format)
    ? await convertImage(shared)
    : null;

  const written = derivativePaths(derivative);
  const inputChanged = await detectInputChange({ identity, writtenPaths: written });
  if (inputChanged) return { ...base, svgSafety, capability, identify, inputChanged };
  return { formatVersion: 1, file, classification, capability, capabilityGap: null, svgSafety, identify, derivative, inputChanged: null };
}

function derivativePaths(derivative: ConvertImageResult | ExpandGifFramesResult | null): string[] {
  if (derivative === null || derivative.outcome !== "ok") return [];
  if (derivative.operation === "convert") return [derivative.derivative.path];
  return derivative.frames.map((frame) => frame.derivative.path);
}

export function isComplete(result: PrepareImageResult): boolean {
  if (result.capabilityGap !== null || result.inputChanged !== null) return false;
  if (result.svgSafety?.outcome === "unsafe-input") return false;
  if (result.identify?.outcome !== "ok") return false;
  return result.derivative === null || result.derivative.outcome === "ok";
}
