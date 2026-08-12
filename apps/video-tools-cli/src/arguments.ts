export interface PrepareArguments {
  command: "prepare";
  inputPath: string;
  artifactsDirectory?: string;
  only?: "audio" | "frames";
  frameCount?: number;
  timestampsSeconds?: number[];
  maxFrames?: number;
  timeoutMs?: number;
  containerImage?: string;
}

export type CliArguments = PrepareArguments | { command: "help" };

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { command: "help" };
  }
  if (argv[0] !== "prepare") throw new Error(`unknown command: ${argv[0]}`);

  const inputPath = argv[1];
  if (inputPath === undefined || inputPath.startsWith("--")) {
    throw new Error("prepare requires one exact input path");
  }

  let artifactsDirectory: string | undefined;
  let only: "audio" | "frames" | undefined;
  let frameCount: number | undefined;
  const timestampsSeconds: number[] = [];
  let maxFrames: number | undefined;
  let timeoutMs: number | undefined;
  let containerImage: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    switch (option) {
      case "--artifacts-dir":
        artifactsDirectory = value;
        break;
      case "--only":
        only = mediaLane(value);
        break;
      case "--max-frames":
        maxFrames = positiveInteger(value, option);
        break;
      case "--frame-count":
        frameCount = positiveInteger(value, option);
        break;
      case "--frame-time":
        timestampsSeconds.push(nonNegativeNumber(value, option));
        break;
      case "--timeout-ms":
        timeoutMs = positiveInteger(value, option);
        break;
      case "--container-image":
        containerImage = parsePinnedImage(value);
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
    index += 1;
  }
  if (frameCount !== undefined && timestampsSeconds.length > 0) {
    throw new Error("--frame-count and --frame-time cannot be used together");
  }
  if (
    only === "audio" &&
    (frameCount !== undefined || timestampsSeconds.length > 0 || maxFrames !== undefined)
  ) {
    throw new Error("frame options cannot be used with --only audio");
  }

  return {
    command: "prepare",
    inputPath,
    ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }),
    ...(only === undefined ? {} : { only }),
    ...(frameCount === undefined ? {} : { frameCount }),
    ...(timestampsSeconds.length === 0 ? {} : { timestampsSeconds }),
    ...(maxFrames === undefined ? {} : { maxFrames }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(containerImage === undefined ? {} : { containerImage }),
  };
}

export function parsePinnedImage(value: string): string {
  if (!/@sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new Error(
      "--container-image requires a digest-pinned image reference ending in @sha256:<64 hex characters>",
    );
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${option} requires a positive integer`);
  return parsed;
}

function nonNegativeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${option} requires a non-negative number`);
  return parsed;
}

function mediaLane(value: string): "audio" | "frames" {
  if (value !== "audio" && value !== "frames") throw new Error("--only requires audio or frames");
  return value;
}
