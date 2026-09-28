import { expect, test } from "vite-plus/test";
import { decide, EXCEPTION_LABEL } from "../src/decide.ts";
import type { Finding } from "../src/detect.ts";

const blockFinding: Finding = {
  rule: "test-file-deleted",
  severity: "block",
  file: "src/a.test.ts",
  detail: "test file deleted",
};
const reportFinding: Finding = {
  rule: "test-content-changed",
  severity: "report",
  file: "src/b.test.ts",
  detail: "2 existing line(s) changed or removed",
};

test("no findings pass with a clear message", () => {
  expect(decide([], false)).toEqual({
    pass: true,
    summary: "No change weakens the tests or the test gate.",
  });
});

test("findings for review only still pass, and are listed", () => {
  const verdict = decide([reportFinding], false);
  expect(verdict.pass).toBe(true);
  expect(verdict.summary).toContain("For review (not blocking):");
  expect(verdict.summary).toContain("`test-content-changed` in `src/b.test.ts`");
});

test("a blocking finding fails without the label and says how to accept it", () => {
  const verdict = decide([blockFinding, reportFinding], false);
  expect(verdict.pass).toBe(false);
  expect(verdict.summary).toContain(`add the \`${EXCEPTION_LABEL}\` label`);
  expect(verdict.summary).toContain("`test-file-deleted` in `src/a.test.ts`: test file deleted");
});

test("the label accepts blocking findings, which are still listed", () => {
  const verdict = decide([blockFinding], true);
  expect(verdict.pass).toBe(true);
  expect(verdict.summary).toContain(`The \`${EXCEPTION_LABEL}\` label accepts them`);
  expect(verdict.summary).toContain("`test-file-deleted` in `src/a.test.ts`");
});

test("text from the pull request cannot break out of its summary line", () => {
  const hostile: Finding = {
    rule: "skip-or-focus-added",
    severity: "block",
    file: "src/a.test.ts",
    detail: "test.skip(`x`)\n\n# Approved by owner\n```\n" + "y".repeat(500),
  };
  const lines = decide([hostile], false).summary.split("\n");
  const findingLine = lines.find((l) => l.includes("skip-or-focus-added"));
  expect(findingLine).toBeDefined();
  expect(lines.some((l) => l.startsWith("# Approved"))).toBe(false);
  expect(findingLine?.includes("```")).toBe(false);
  expect(findingLine?.length ?? 0).toBeLessThan(300);
});

test("the label does not matter when nothing blocks", () => {
  expect(decide([reportFinding], true).pass).toBe(true);
});
