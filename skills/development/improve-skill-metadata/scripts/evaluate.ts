// Runs metadata variants through the real Codex skill-routing surface while replacing each workflow
// body with an inert marker. The marker separates routing from execution: a selected skill identifies
// itself, and no production workflow can run during this experiment.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKER_PREFIX = "SKILL_ROUTING_SELECTED:";

export interface MetadataVariant {
  id: string;
  name?: string;
  description: string;
}

export interface RoutingSkill {
  name: string;
  description: string;
}

export interface RoutingCase {
  id: string;
  prompt: string;
  expected: string | null;
}

export interface RoutingExperiment {
  name: string;
  target: string;
  variants: MetadataVariant[];
  competitors: RoutingSkill[];
  cases: RoutingCase[];
}

export type RunOutcome =
  | { status: "ok"; selected: string | null; response: string }
  | { status: "tool-unavailable"; detail: string }
  | { status: "timeout"; detail: string }
  | { status: "runtime-error"; detail: string; exitCode: number | null }
  | { status: "invalid-output"; detail: string };

export interface RoutingRun {
  variant: string;
  case: string;
  repetition: number;
  expected: string | null;
  outcome: RunOutcome;
}

export interface VariantScore {
  variant: string;
  correct: number;
  scorable: number;
  errors: number;
  targetHits: number;
  targetCases: number;
  targetFalseActivations: number;
  nonTargetCases: number;
}

interface CliOptions {
  experimentPath: string;
  model: string;
  repetitions: number;
  timeoutMs: number;
  artifactsDirectory: string | null;
  variant: string | null;
  caseId: string | null;
}

interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface RunRecord extends RoutingRun {
  stdoutFile: string;
  stderrFile: string;
}

export function parseExperiment(value: unknown): RoutingExperiment {
  const source = record(value, "experiment");
  const name = text(source["name"], "experiment.name");
  const target = skillName(source["target"], "experiment.target");
  const variants = array(source["variants"], "experiment.variants").map((item, index) => {
    const variant = record(item, `experiment.variants[${index}]`);
    const name = variant["name"];
    return {
      id: identifier(variant["id"], `experiment.variants[${index}].id`),
      ...(name === undefined
        ? {}
        : { name: skillName(name, `experiment.variants[${index}].name`) }),
      description: description(variant["description"], `experiment.variants[${index}].description`),
    };
  });
  const competitors = array(source["competitors"], "experiment.competitors").map((item, index) => {
    const competitor = record(item, `experiment.competitors[${index}]`);
    return {
      name: skillName(competitor["name"], `experiment.competitors[${index}].name`),
      description: description(
        competitor["description"],
        `experiment.competitors[${index}].description`,
      ),
    };
  });
  const known = new Set([target, ...competitors.map((skill) => skill.name)]);
  const cases = array(source["cases"], "experiment.cases").map((item, index) => {
    const case_ = record(item, `experiment.cases[${index}]`);
    const expected = case_["expected"];
    if (expected !== null && (typeof expected !== "string" || !known.has(expected))) {
      throw new Error(
        `experiment.cases[${index}].expected must be null or one of ${[...known].join(", ")}`,
      );
    }
    return {
      id: identifier(case_["id"], `experiment.cases[${index}].id`),
      prompt: text(case_["prompt"], `experiment.cases[${index}].prompt`),
      expected,
    };
  });

  unique(
    variants.map((variant) => variant.id),
    "variant ids",
  );
  unique([target, ...competitors.map((skill) => skill.name)], "skill names");
  const competitorNames = new Set(competitors.map((skill) => skill.name));
  for (const [index, variant] of variants.entries()) {
    if (variant.name && competitorNames.has(variant.name)) {
      throw new Error(`experiment.variants[${index}].name conflicts with a competitor`);
    }
  }
  unique(
    cases.map((case_) => case_.id),
    "case ids",
  );
  if (variants.length === 0) throw new Error("experiment.variants must not be empty");
  if (cases.length === 0) throw new Error("experiment.cases must not be empty");
  return { name, target, variants, competitors, cases };
}

export function renderProbeSkill(skill: RoutingSkill, selectedAs = skill.name): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n# Routing probe\n\nReturn exactly \`${marker(selectedAs)}\` and stop. Do not perform the user's task or call tools.\n`;
}

export function marker(skillName_: string): string {
  return `${MARKER_PREFIX}${skillName_}`;
}

export function classifyCodexOutput(
  result: ProcessResult,
  knownSkills: ReadonlySet<string>,
): RunOutcome {
  if (result.timedOut) return { status: "timeout", detail: "Codex exceeded the run timeout" };
  if (result.exitCode === null && result.stderr.startsWith("tool-unavailable:")) {
    return {
      status: "tool-unavailable",
      detail: result.stderr.slice("tool-unavailable:".length).trim(),
    };
  }
  if (result.exitCode !== 0) {
    return {
      status: "runtime-error",
      exitCode: result.exitCode,
      detail: result.stderr.trim() || "Codex exited without an error message",
    };
  }

  let response = "";
  for (const [index, line] of result.stdout.split("\n").entries()) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { status: "invalid-output", detail: `stdout line ${index + 1} is not JSON` };
    }
    const item = recordOrNull(recordOrNull(event)?.["item"]);
    if (recordOrNull(event)?.["type"] === "item.completed" && item?.["type"] === "agent_message") {
      const candidate = item["text"];
      if (typeof candidate === "string") response = candidate;
    }
  }
  if (response === "") {
    return { status: "invalid-output", detail: "Codex emitted no completed agent message" };
  }

  const selected = [...knownSkills].filter((skill) => response.includes(marker(skill)));
  if (selected.length > 1) {
    return {
      status: "invalid-output",
      detail: `Codex returned multiple skill markers: ${selected.join(", ")}`,
    };
  }
  return { status: "ok", selected: selected[0] ?? null, response };
}

export function scoreRuns(runs: RoutingRun[], target: string): VariantScore[] {
  const variants = [...new Set(runs.map((run) => run.variant))];
  return variants.map((variant) => {
    const selected = runs.filter((run) => run.variant === variant);
    const scorable = selected.filter(
      (run): run is RoutingRun & { outcome: Extract<RunOutcome, { status: "ok" }> } =>
        run.outcome.status === "ok",
    );
    const targetCases = scorable.filter((run) => run.expected === target);
    const nonTargetCases = scorable.filter((run) => run.expected !== target);
    return {
      variant,
      correct: scorable.filter((run) => run.outcome.selected === run.expected).length,
      scorable: scorable.length,
      errors: selected.length - scorable.length,
      targetHits: targetCases.filter((run) => run.outcome.selected === target).length,
      targetCases: targetCases.length,
      targetFalseActivations: nonTargetCases.filter((run) => run.outcome.selected === target)
        .length,
      nonTargetCases: nonTargetCases.length,
    };
  });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const experimentBytes = await readFile(options.experimentPath);
  const experiment = parseExperiment(JSON.parse(experimentBytes.toString("utf8")));
  const variants = options.variant
    ? experiment.variants.filter((variant) => variant.id === options.variant)
    : experiment.variants;
  const cases = options.caseId
    ? experiment.cases.filter((case_) => case_.id === options.caseId)
    : experiment.cases;
  if (variants.length === 0) throw new Error(`unknown variant: ${options.variant}`);
  if (cases.length === 0) throw new Error(`unknown case: ${options.caseId}`);

  const artifactsDirectory = options.artifactsDirectory
    ? resolve(options.artifactsDirectory)
    : await mkdtemp(join(tmpdir(), "skill-routing-eval-"));
  await mkdir(artifactsDirectory, { recursive: true });

  const codexVersion = await requireCodex();
  const knownSkills = new Set([
    experiment.target,
    ...experiment.competitors.map((skill) => skill.name),
  ]);
  const sourceSkillNames = new Set([
    ...knownSkills,
    ...experiment.variants.flatMap((variant) => (variant.name ? [variant.name] : [])),
  ]);
  const disabledPaths = installedSkillPaths(sourceSkillNames);
  const skillConfig = tomlSkillConfig(disabledPaths);
  const records: RunRecord[] = [];

  console.log(`Experiment: ${experiment.name}`);
  console.log(`Model: ${options.model}`);
  console.log(`Codex: ${codexVersion}`);
  console.log(`Artifacts: ${artifactsDirectory}`);

  for (const variant of variants) {
    const workspace = join(artifactsDirectory, "workspaces", variant.id);
    await materializeWorkspace(workspace, experiment, variant);
    // macOS exposes /var through /private/var. Codex reports canonical source paths, so compare and
    // execute with the canonical workspace rather than treating those aliases as different catalogs.
    const canonicalWorkspace = await realpath(workspace);
    const catalogSkills = new Set([
      variant.name ?? experiment.target,
      ...experiment.competitors.map((skill) => skill.name),
    ]);
    await verifyCatalog(canonicalWorkspace, catalogSkills, skillConfig, options.timeoutMs);

    for (const case_ of cases) {
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        const stem = `${variant.id}--${case_.id}--${repetition}`;
        const result = await runCodex({
          workspace: canonicalWorkspace,
          model: options.model,
          prompt: case_.prompt,
          timeoutMs: options.timeoutMs,
          skillConfig,
        });
        const stdoutFile = join(artifactsDirectory, `${stem}.stdout.jsonl`);
        const stderrFile = join(artifactsDirectory, `${stem}.stderr.txt`);
        await Promise.all([
          writeFile(stdoutFile, result.stdout),
          writeFile(stderrFile, result.stderr),
        ]);
        const outcome = classifyCodexOutput(result, knownSkills);
        records.push({
          variant: variant.id,
          case: case_.id,
          repetition,
          expected: case_.expected,
          outcome,
          stdoutFile,
          stderrFile,
        });
        console.log(formatRun(records.at(-1)!));
      }
    }
  }

  const report = {
    experiment: experiment.name,
    source: options.experimentPath,
    sourceSha256: createHash("sha256").update(experimentBytes).digest("hex"),
    model: options.model,
    codexVersion,
    repetitions: options.repetitions,
    scores: scoreRuns(records, experiment.target),
    runs: records,
  };
  await writeFile(join(artifactsDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("\nSummary");
  for (const score of report.scores) console.log(formatScore(score));
}

async function materializeWorkspace(
  workspace: string,
  experiment: RoutingExperiment,
  variant: MetadataVariant,
): Promise<void> {
  const target = { name: variant.name ?? experiment.target, description: variant.description };
  const skills = [target, ...experiment.competitors];
  for (const skill of skills) {
    const directory = join(workspace, ".agents", "skills", skill.name);
    await mkdir(directory, { recursive: true });
    const selectedAs = skill === target ? experiment.target : skill.name;
    await writeFile(join(directory, "SKILL.md"), renderProbeSkill(skill, selectedAs), {
      flag: "wx",
    });
  }
}

async function verifyCatalog(
  workspace: string,
  knownSkills: ReadonlySet<string>,
  skillConfig: string | null,
  timeoutMs: number,
): Promise<void> {
  const arguments_ = ["debug", "prompt-input"];
  if (skillConfig) arguments_.push("-c", skillConfig);
  arguments_.push("routing catalog preflight");
  const result = await spawn(["codex", ...arguments_], workspace, timeoutMs);
  if (result.timedOut) throw new Error("routing catalog preflight timed out");
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || "routing catalog preflight failed");
  for (const skill of knownSkills) {
    const expected = join(workspace, ".agents", "skills", skill, "SKILL.md");
    if (!result.stdout.includes(`(file: ${expected})`)) {
      throw new Error(`routing catalog preflight did not load ${skill} from ${expected}`);
    }
  }
}

async function runCodex(input: {
  workspace: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  skillConfig: string | null;
}): Promise<ProcessResult> {
  const arguments_ = [
    "-a",
    "never",
    "-s",
    "read-only",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C",
    input.workspace,
    "-m",
    input.model,
  ];
  if (input.skillConfig) arguments_.push("-c", input.skillConfig);
  arguments_.push("--", input.prompt);
  return spawn(["codex", ...arguments_], input.workspace, input.timeoutMs);
}

async function spawn(command: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  try {
    const process_ = Bun.spawn({
      cmd: command,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process_.exited,
      Bun.readableStreamToText(process_.stdout),
      Bun.readableStreamToText(process_.stderr),
    ]);
    return {
      exitCode,
      timedOut: process_.signalCode === "SIGKILL" && exitCode !== 0,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: error instanceof Error ? `tool-unavailable: ${error.message}` : "tool-unavailable",
    };
  }
}

async function requireCodex(): Promise<string> {
  const result = await spawn(["codex", "--version"], process.cwd(), 10_000);
  if (result.stderr.startsWith("tool-unavailable:")) throw new Error(result.stderr);
  if (result.timedOut) throw new Error("codex --version timed out");
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "codex --version failed");
  return result.stdout.trim();
}

function installedSkillPaths(skills: ReadonlySet<string>): string[] {
  const roots = [
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".codex", "skills", ".system"),
    join(homedir(), ".agents", "skills"),
  ];
  return roots.flatMap((root) =>
    [...skills].map((skill) => join(root, skill, "SKILL.md")).filter((path) => existsSync(path)),
  );
}

function tomlSkillConfig(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const entries = paths.map((path) => `{path=${JSON.stringify(path)},enabled=false}`);
  return `skills.config=[${entries.join(",")}]`;
}

function parseArguments(arguments_: string[]): CliOptions {
  const experimentArgument = arguments_[0];
  if (!experimentArgument || experimentArgument.startsWith("--")) usage();
  let model: string | null = null;
  let repetitions = 1;
  let timeoutMs = 60_000;
  let artifactsDirectory: string | null = null;
  let variant: string | null = null;
  let caseId: string | null = null;
  for (let index = 1; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!option || !value) usage();
    if (option === "--model") model = value;
    else if (option === "--repetitions") repetitions = positiveInteger(value, option);
    else if (option === "--timeout-ms") timeoutMs = positiveInteger(value, option);
    else if (option === "--artifacts-dir") artifactsDirectory = value;
    else if (option === "--variant") variant = value;
    else if (option === "--case") caseId = value;
    else usage();
    index += 1;
  }
  if (!model) usage();
  return {
    experimentPath: resolve(experimentArgument),
    model,
    repetitions,
    timeoutMs,
    artifactsDirectory,
    variant,
    caseId,
  };
}

function formatRun(run: RunRecord): string {
  const actual =
    run.outcome.status === "ok" ? (run.outcome.selected ?? "none") : run.outcome.status;
  const expected = run.expected ?? "none";
  const result =
    run.outcome.status === "ok" && run.outcome.selected === run.expected ? "PASS" : "FAIL";
  return `${result} ${run.variant}/${run.case} #${run.repetition}: expected=${expected} actual=${actual}`;
}

function formatScore(score: VariantScore): string {
  return [
    score.variant,
    `accuracy=${score.correct}/${score.scorable}`,
    `target-recall=${score.targetHits}/${score.targetCases}`,
    `target-false-activations=${score.targetFalseActivations}/${score.nonTargetCases}`,
    `errors=${score.errors}`,
  ].join("  ");
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be positive`);
  return parsed;
}

function description(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (parsed.includes("\n")) throw new Error(`${field} must fit on one line`);
  return parsed;
}

function skillName(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!SKILL_NAME.test(parsed)) throw new Error(`${field} must be lowercase kebab-case`);
  return parsed;
}

function identifier(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!SKILL_NAME.test(parsed)) throw new Error(`${field} must be lowercase kebab-case`);
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be text`);
  return value.trim();
}

function record(value: unknown, field: string): Record<string, unknown> {
  const parsed = recordOrNull(value);
  if (!parsed) throw new Error(`${field} must be an object`);
  return parsed;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function usage(): never {
  console.error(
    `Usage: bun run eval:skill-routing -- <experiment.json> --model <model> [--repetitions N] [--timeout-ms N] [--artifacts-dir PATH] [--variant ID] [--case ID]`,
  );
  process.exit(2);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `Skill routing evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
