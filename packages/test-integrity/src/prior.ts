// Chooses whether a run reuses an earlier verdict or evaluates the change again.
// Pure: event facts and earlier check runs in, a decision out. `cli.ts` supplies them.
//
// Events that cannot change the verdict (a title or body edit, or any label other than the
// exception label) reuse the newest completed verdict recorded for the same base, head, and
// detector version, so an approval is not lost to unrelated activity. The version must be a commit
// SHA: a branch or tag pin names different code over time, so it never reuses. Anything else, or no
// exact match, is evaluated again, which is fail-closed: without the exception label a blocking
// change fails.

export const RECORD_TITLE = "test-integrity-result";

export interface Event {
  action: string;
  // The label an event added or removed, if any.
  label?: string;
  // True when an `edited` event changed the base branch.
  baseChanged: boolean;
}

export interface CheckRun {
  id: number;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
  appId: number | null;
  // Notice annotations the run wrote, as `title` and `message`.
  records: { title: string; message: string }[];
}

export interface Subject {
  base: string;
  head: string;
  version: string;
}

export type Decision = { kind: "evaluate" } | { kind: "reuse"; pass: boolean; runId: number };

const GITHUB_ACTIONS = 15368;
const COMMIT = /^[0-9a-f]{40}$/;

// A verdict record: `base=<sha> head=<sha> version=<id> verdict=pass|fail`.
export function formatRecord(subject: Subject, pass: boolean): string {
  return `base=${subject.base} head=${subject.head} version=${subject.version} verdict=${pass ? "pass" : "fail"}`;
}

function parseRecord(message: string): (Subject & { pass: boolean }) | undefined {
  const match = /^base=([0-9a-f]{40}) head=([0-9a-f]{40}) version=(\S+) verdict=(pass|fail)$/.exec(
    message,
  );
  if (!match) return undefined;
  const [, base = "", head = "", version = "", verdict] = match;
  return { base, head, version, pass: verdict === "pass" };
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
  runs: CheckRun[],
): Decision {
  if (!reusable(event, exceptionLabel) || !COMMIT.test(subject.version))
    return { kind: "evaluate" };
  const candidates = runs
    .filter((run) => run.status === "completed" && run.appId === GITHUB_ACTIONS)
    .filter((run) => run.conclusion === "success" || run.conclusion === "failure")
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  for (const run of candidates) {
    const records = run.records
      .filter((record) => record.title === RECORD_TITLE)
      .map((record) => parseRecord(record.message));
    // One well-formed record that matches exactly, and agrees with how the run ended.
    if (records.length !== 1 || !records[0]) continue;
    const record = records[0];
    const matches =
      record.base === subject.base &&
      record.head === subject.head &&
      record.version === subject.version;
    if (!matches) continue;
    if (record.pass !== (run.conclusion === "success")) continue;
    return { kind: "reuse", pass: record.pass, runId: run.id };
  }
  return { kind: "evaluate" };
}
