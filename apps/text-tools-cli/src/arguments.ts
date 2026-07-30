export interface InspectArguments {
  command: "inspect";
  inputPath: string;
  maximumCharacters?: number;
}

export type CliArguments = InspectArguments | { command: "help" };

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { command: "help" };
  }
  if (argv[0] !== "inspect") throw new Error(`unknown command: ${argv[0]}`);
  const inputPath = argv[1];
  if (inputPath === undefined || inputPath.startsWith("--"))
    throw new Error("inspect requires one exact input path");

  let maximumCharacters: number | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    switch (option) {
      case "--max-characters":
        maximumCharacters = positiveInteger(value, option);
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
    index += 1;
  }
  return {
    command: "inspect",
    inputPath,
    ...(maximumCharacters === undefined ? {} : { maximumCharacters }),
  };
}

function positiveInteger(value: string, option: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${option} requires a positive integer`);
  return parsed;
}
