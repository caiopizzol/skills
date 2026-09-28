// Chooses whether a run reuses an earlier verdict or evaluates the change again.
// Pure: event facts and earlier workflow runs in, a decision out. `cli.ts` supplies them.
//
// Events that cannot change the verdict (a title or body edit, or any label other than the
// exception label) reuse the verdict of the newest earlier run of this workflow on the same commit,
// so an approval is not lost to unrelated activity. That run must have finished with one record for
// the same pull request, base, head, and detector version. Anything else is evaluated again, which
// is fail-closed: without the exception label a blocking change fails.

export const RECORD_TITLE = "test-integrity-result";

export interface Event {
  action: string;
  // The label an event added or removed, if any.
  label?: string;
  // True when an `edited` event changed the base branch.
  baseChanged: boolean;
}

// A workflow run on the head commit, with the notice annotations its jobs wrote.
export interface PriorRun {
  id: number;
  event: string;
  workflowId: number;
  status: string;
  conclusion: string | null;
  // When the event that started it happened. A rerun keeps it, so runs sort in event order.
  createdAt: string;
  records: { title: string; message: string }[];
}

// This workflow's runs on the head commit as GitHub listed them, and how many it has, so a list
// cut short by paging is not trusted.
export interface PriorRuns {
  workflowId: number;
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
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  // Only the newest run counts. Without a clear verdict there (it was cancelled or failed to
  // record one), an older verdict may no longer hold: the exception label may have been removed.
  if (!newest || newest.status !== "completed") return EVALUATE;
  if (newest.conclusion !== "success" && newest.conclusion !== "failure") return EVALUATE;
  const records = newest.records.filter((record) => record.title === RECORD_TITLE);
  const record = records.length === 1 && records[0] ? parseRecord(records[0].message) : undefined;
  if (!record) return EVALUATE;
  const matches =
    record.pr === subject.pr &&
    record.base === subject.base &&
    record.head === subject.head &&
    record.version === subject.version;
  if (!matches || record.pass !== (newest.conclusion === "success")) return EVALUATE;
  return { kind: "reuse", pass: record.pass, runId: newest.id };
}
