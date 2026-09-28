import { expect, test } from "vite-plus/test";
import {
  type CheckRun,
  decidePrior,
  type Event,
  formatRecord,
  RECORD_TITLE,
  reusable,
} from "../src/prior.ts";

const LABEL = "tests-changed-ok";
const subject = { base: "a".repeat(40), head: "b".repeat(40), version: "e".repeat(40) };

function run(overrides: Partial<CheckRun> & { pass?: boolean; record?: string }): CheckRun {
  const pass = overrides.pass ?? true;
  return {
    id: 1,
    status: "completed",
    conclusion: pass ? "success" : "failure",
    completedAt: "2026-09-28T13:00:00Z",
    appId: 15368,
    records: [{ title: RECORD_TITLE, message: overrides.record ?? formatRecord(subject, pass) }],
    ...overrides,
  };
}

const otherLabel: Event = { action: "labeled", label: "autorelease: pending", baseChanged: false };

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
    expect(decidePrior(event, LABEL, subject, [run({})])).toEqual({ kind: "evaluate" });
  }
});

test("an unrelated label or a title edit reuses the matching verdict, pass or fail", () => {
  for (const event of [
    otherLabel,
    { action: "unlabeled", label: "autorelease: pending", baseChanged: false },
    { action: "edited", baseChanged: false },
  ]) {
    expect(decidePrior(event, LABEL, subject, [run({ id: 7 })])).toEqual({
      kind: "reuse",
      pass: true,
      runId: 7,
    });
    expect(decidePrior(event, LABEL, subject, [run({ id: 8, pass: false })])).toEqual({
      kind: "reuse",
      pass: false,
      runId: 8,
    });
  }
});

test("the newest completed matching run wins", () => {
  const runs = [
    run({ id: 1, pass: true, completedAt: "2026-09-28T13:00:00Z" }),
    run({ id: 2, pass: false, completedAt: "2026-09-28T13:05:00Z" }),
    run({ id: 3, status: "in_progress", conclusion: null, completedAt: null, records: [] }),
  ];
  expect(decidePrior(otherLabel, LABEL, subject, runs)).toEqual({
    kind: "reuse",
    pass: false,
    runId: 2,
  });
});

test("a verdict for another base, head, or detector version is not reused", () => {
  for (const other of [
    { ...subject, base: "c".repeat(40) },
    { ...subject, head: "d".repeat(40) },
    { ...subject, version: "f".repeat(40) },
  ]) {
    const runs = [run({ record: formatRecord(other, true) })];
    expect(decidePrior(otherLabel, LABEL, subject, runs)).toEqual({ kind: "evaluate" });
  }
});

test("a detector pinned by branch or tag never reuses, since the name can move to new code", () => {
  for (const version of ["main", "v1", "v0.8.0", "E".repeat(40), "e".repeat(39)]) {
    const pinned = { ...subject, version };
    const runs = [run({ record: formatRecord(pinned, true) })];
    expect(decidePrior(otherLabel, LABEL, pinned, runs)).toEqual({ kind: "evaluate" });
  }
});

test("a run that is not a trustworthy verdict is never reused", () => {
  for (const bad of [
    run({ appId: 999 }),
    run({ conclusion: "cancelled" }),
    run({ conclusion: "skipped" }),
    run({ status: "in_progress", conclusion: null }),
    run({ records: [] }),
    run({ record: "base=x head=y version=v1 verdict=pass" }),
    run({ records: [{ title: "other", message: formatRecord(subject, true) }] }),
    // A record that disagrees with how the run ended.
    run({ conclusion: "success", record: formatRecord(subject, false) }),
    // Two records on one run are ambiguous.
    run({
      records: [
        { title: RECORD_TITLE, message: formatRecord(subject, true) },
        { title: RECORD_TITLE, message: formatRecord(subject, false) },
      ],
    }),
  ]) {
    expect(decidePrior(otherLabel, LABEL, subject, [bad])).toEqual({ kind: "evaluate" });
  }
});

test("with no earlier run, an unrelated event evaluates again", () => {
  expect(decidePrior(otherLabel, LABEL, subject, [])).toEqual({ kind: "evaluate" });
});
