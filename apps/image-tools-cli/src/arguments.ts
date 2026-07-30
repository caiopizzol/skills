export interface PrepareArguments {
  command: "prepare";
  inputPath: string;
  artifactsDirectory: string;
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
  if (inputPath === undefined || inputPath.startsWith("--"))
    throw new Error("prepare requires one exact input path");

  let artifactsDirectory: string | undefined;
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
      case "--max-frames":
        maxFrames = positiveInteger(value, option);
        break;
      case "--timeout-ms":
        timeoutMs = positiveInteger(value, option);
        break;
      case "--container-image":
        containerImage = pinnedImage(value);
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
    index += 1;
  }
  if (artifactsDirectory === undefined) throw new Error("prepare requires --artifacts-dir");
  return {
    command: "prepare",
    inputPath,
    artifactsDirectory,
    ...(maxFrames === undefined ? {} : { maxFrames }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(containerImage === undefined ? {} : { containerImage }),
  };
}

function pinnedImage(value: string): string {
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
