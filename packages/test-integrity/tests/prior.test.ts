import { expect, test } from "vite-plus/test";
import {
  decidePrior,
  type Event,
  formatRecord,
  type PriorRun,
  type PriorRuns,
  RECORD_TITLE,
  reusable,
} from "../src/prior.ts";

const LABEL = "tests-changed-ok";
const WORKFLOW = 42;
const verdict = { pr: 5, base: "a".repeat(40), head: "b".repeat(40), version: "e".repeat(40) };
const subject = { ...verdict, runId: 100 };

function run(overrides: Partial<PriorRun> & { pass?: boolean; record?: string } = {}): PriorRun {
  const { pass = true, record = formatRecord(verdict, pass), ...rest } = overrides;
  return {
    id: 1,
    event: "pull_request_target",
    workflowId: WORKFLOW,
    status: "completed",
    conclusion: pass ? "success" : "failure",
    createdAt: "2026-09-28T13:00:00Z",
    records: [{ title: RECORD_TITLE, message: record }],
    ...rest,
  };
}

const listed = (...runs: PriorRun[]): PriorRuns => ({
  workflowId: WORKFLOW,
  total: runs.length,
  runs,
});
const otherLabel: Event = { action: "labeled", label: "autorelease: pending", baseChanged: false };
const evaluate = { kind: "evaluate" };

test("events that change what is judged are always evaluated again", () => {
  for (const event of [
    { action: "opened", baseChanged: false },
    { action: "synchronize", baseChanged: false },
    { action: "reopened", baseChanged: false },
    { action: "edited", baseChanged: true },
    { action: "labeled", label: LABEL, baseChanged: false },
    { action: "unlabeled", label: LABEL, baseChanged: false },
  ]) {
    expect(reusable(event, LABEL)).toBe(false);
    expect(decidePrior(event, LABEL, subject, listed(run()))).toEqual(evaluate);
  }
});

test("an unrelated label or a title edit reuses the matching verdict, pass or fail", () => {
  for (const event of [
    otherLabel,
    { action: "unlabeled", label: "autorelease: pending", baseChanged: false },
    { action: "edited", baseChanged: false },
  ]) {
    expect(decidePrior(event, LABEL, subject, listed(run({ id: 7 })))).toEqual({
      kind: "reuse",
      pass: true,
      runId: 7,
    });
    expect(decidePrior(event, LABEL, subject, listed(run({ id: 8, pass: false })))).toEqual({
      kind: "reuse",
      pass: false,
      runId: 8,
    });
  }
});

test("the newest earlier run decides, and this run is not its own prior", () => {
  const older = run({ id: 1, pass: true, createdAt: "2026-09-28T13:00:00Z" });
  const newer = run({ id: 2, pass: false, createdAt: "2026-09-28T13:05:00Z" });
  // GitHub lists this run too, as the newest and still in progress.
  const self = run({
    id: subject.runId,
    createdAt: "2026-09-28T13:10:00Z",
    status: "in_progress",
    conclusion: null,
    records: [],
  });
  expect(decidePrior(otherLabel, LABEL, subject, listed(newer, older, self))).toEqual({
    kind: "reuse",
    pass: false,
    runId: 2,
  });
});

test("an older verdict is never used when the newest run gives none", () => {
  // The approval may have been withdrawn since the older pass, so its verdict no longer holds.
  const approved = run({ id: 1, pass: true, createdAt: "2026-09-28T13:00:00Z" });
  const at = "2026-09-28T13:05:00Z";
  for (const newest of [
    run({ id: 2, createdAt: at, status: "in_progress", conclusion: null, records: [] }),
    run({ id: 2, createdAt: at, conclusion: "cancelled" }),
    run({ id: 2, createdAt: at, pass: false, records: [] }),
    run({ id: 2, createdAt: at, pass: false, record: "garbled" }),
    run({ id: 2, createdAt: at, pass: false, record: formatRecord({ ...verdict, pr: 6 }, false) }),
  ]) {
    expect(decidePrior(otherLabel, LABEL, subject, listed(approved, newest))).toEqual(evaluate);
  }
});

test("a verdict for another pull request, base, head, or detector version is not reused", () => {
  for (const other of [
    { ...verdict, pr: 6 },
    { ...verdict, base: "c".repeat(40) },
    { ...verdict, head: "d".repeat(40) },
    { ...verdict, version: "f".repeat(40) },
  ]) {
    const runs = listed(run({ record: formatRecord(other, true) }));
    expect(decidePrior(otherLabel, LABEL, subject, runs)).toEqual(evaluate);
  }
});

test("a detector pinned by branch or tag never reuses, since the name can move to new code", () => {
  for (const version of ["main", "v1", "v0.8.0", "E".repeat(40), "e".repeat(39)]) {
    const pinned = { ...verdict, version };
    const runs = listed(run({ record: formatRecord(pinned, true) }));
    expect(decidePrior(otherLabel, LABEL, { ...pinned, runId: 100 }, runs)).toEqual(evaluate);
  }
});

test("only this workflow's pull_request_target runs can supply a verdict", () => {
  // A workflow the pull request adds, or this file run by `pull_request`, runs the pull request's
  // code and could write a passing record.
  for (const forged of [run({ workflowId: 43 }), run({ event: "pull_request" })]) {
    expect(decidePrior(otherLabel, LABEL, subject, listed(forged))).toEqual(evaluate);
  }
});

test("a run that is not a trustworthy verdict is never reused", () => {
  for (const bad of [
    run({ conclusion: "cancelled" }),
    run({ conclusion: "skipped" }),
    run({ status: "in_progress", conclusion: null }),
    run({ records: [] }),
    run({ record: `base=x head=y version=${verdict.version} verdict=pass` }),
    run({ records: [{ title: "other", message: formatRecord(verdict, true) }] }),
    // A record that disagrees with how the run ended.
    run({ conclusion: "success", record: formatRecord(verdict, false) }),
    // Two records on one run are ambiguous.
    run({
      records: [
        { title: RECORD_TITLE, message: formatRecord(verdict, true) },
        { title: RECORD_TITLE, message: formatRecord(verdict, false) },
      ],
    }),
  ]) {
    expect(decidePrior(otherLabel, LABEL, subject, listed(bad))).toEqual(evaluate);
  }
});

test("a list that paging cut short is not trusted", () => {
  const runs = { ...listed(run()), total: 101 };
  expect(decidePrior(otherLabel, LABEL, subject, runs)).toEqual(evaluate);
});

test("with no earlier run, an unrelated event evaluates again", () => {
  expect(decidePrior(otherLabel, LABEL, subject, listed())).toEqual(evaluate);
});
