// Chooses whether a run reuses an earlier verdict or evaluates the change again.
// Pure: event facts and earlier workflow runs in, a decision out. `cli.ts` supplies them.
//
// Events that cannot change the verdict (a title or body edit, or any label other than the
// exception label) reuse the verdict of the newest earlier run of this workflow on the same commit,
// so an approval is not lost to unrelated activity. In that run, exactly one job named like this
// one must have finished with one record for the same pull request, base, head, and detector
// version. Anything else is evaluated again, which is fail-closed: without the exception label a
// blocking change fails.

export const RECORD_TITLE = "test-integrity-result";

export interface Event {
  action: string;
  // The label an event added or removed, if any.
  label?: string;
  // True when an `edited` event changed the base branch.
  baseChanged: boolean;
}

// A job in an earlier run's latest attempt, with the notice annotations it wrote. `records` is
// undefined when they could not all be read.
export interface PriorJob {
  name: string;
  status: string;
  conclusion: string | null;
  records?: { title: string; message: string }[];
}

// A workflow run on the head commit. `jobs` is undefined when they could not all be read.
export interface PriorRun {
  id: number;
  event: string;
  workflowId: number;
  // When its latest attempt started. A rerun of an older run starts later, and then it is newest.
  startedAt: string;
  jobs?: PriorJob[];
}

// This workflow's runs on the head commit as GitHub listed them, and how many it has, so a list
// cut short by paging is not trusted. `jobName` is this job's check run name.
export interface PriorRuns {
  workflowId: number;
  jobName: string;
  total: number;
  runs: PriorRun[];
}

// What a verdict is about.
export interface Verdict {
  pr: number;
  base: string;
  head: string;
  // The detector's commit SHA. A branch or tag names different code over time, so it never reuses.
  version: string;
}

// This run: what it judges, and its own run ID.
export interface Subject extends Verdict {
  runId: number;
}

export type Decision = { kind: "evaluate" } | { kind: "reuse"; pass: boolean; runId: number };

const COMMIT = /^[0-9a-f]{40}$/;
const EVALUATE: Decision = { kind: "evaluate" };

// A verdict record: `pr=<n> base=<sha> head=<sha> version=<id> verdict=pass|fail`.
export function formatRecord(verdict: Verdict, pass: boolean): string {
  return `pr=${verdict.pr} base=${verdict.base} head=${verdict.head} version=${verdict.version} verdict=${pass ? "pass" : "fail"}`;
}

function parseRecord(message: string) {
  const match =
    /^pr=(\d+) base=([0-9a-f]{40}) head=([0-9a-f]{40}) version=(\S+) verdict=(pass|fail)$/.exec(
      message,
    );
  if (!match) return undefined;
  const [, pr, base, head, version, verdict] = match;
  return { pr: Number(pr), base, head, version, pass: verdict === "pass" };
}

// Events that do not change what is judged: the diff and the exception label stay the same.
export function reusable(event: Event, exceptionLabel: string): boolean {
  if (event.action === "edited") return !event.baseChanged;
  if (event.action === "labeled" || event.action === "unlabeled") {
    return event.label !== undefined && event.label !== exceptionLabel;
  }
  return false;
}

export function decidePrior(
  event: Event,
  exceptionLabel: string,
  subject: Subject,
  prior: PriorRuns,
): Decision {
  if (!reusable(event, exceptionLabel) || !COMMIT.test(subject.version)) return EVALUATE;
  if (prior.runs.length < prior.total) return EVALUATE;
  // Only this workflow's `pull_request_target` runs, which use the base branch's copy of the file.
  // Another workflow, or this file run by another event, can come from the pull request itself.
  const newest = prior.runs
    .filter((run) => run.event === "pull_request_target" && run.workflowId === prior.workflowId)
    .filter((run) => run.id !== subject.runId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)[0];
  // Only the newest run counts. Without a clear verdict there (it was cancelled or failed to
  // record one), an older verdict may no longer hold: the exception label may have been removed.
  // The verdict is its one job named like this one; another job in the workflow may run the pull
  // request's code and write a record of its own.
  const jobs = newest?.jobs?.filter((job) => job.name === prior.jobName);
  const job = jobs?.length === 1 ? jobs[0] : undefined;
  if (!newest || !job?.records || job.status !== "completed") return EVALUATE;
  if (job.conclusion !== "success" && job.conclusion !== "failure") return EVALUATE;
  const records = job.records.filter((record) => record.title === RECORD_TITLE);
  const record = records.length === 1 && records[0] ? parseRecord(records[0].message) : undefined;
  if (!record) return EVALUATE;
  const matches =
    record.pr === subject.pr &&
    record.base === subject.base &&
    record.head === subject.head &&
    record.version === subject.version;
  if (!matches || record.pass !== (job.conclusion === "success")) return EVALUATE;
  return { kind: "reuse", pass: record.pass, runId: newest.id };
}
