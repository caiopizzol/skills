// Turns findings into the check's result: whether it passes, and a Markdown summary for the job.
// Pure: findings and the exception label's presence in, verdict out.
import type { Finding } from "./detect.ts";

export const EXCEPTION_LABEL = "tests-changed-ok";

export interface Verdict {
  pass: boolean;
  summary: string;
}

// File paths and details come from the pull request. Keep them on one line, drop control
// characters and backticks, and bound their length, so they render as plain text.
const isControlOrBacktick = (char: string) => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f || char === "`";
};
const plain = (text: string, max: number) =>
  Array.from(text, (char) => (isControlOrBacktick(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// The detail can quote the pull request's code, so it is a code span too: no links or images.
const line = (f: Finding) =>
  `- \`${f.rule}\` in \`${plain(f.file, 200)}\`: \`${plain(f.detail, 200)}\``;

export function decide(findings: Finding[], hasExceptionLabel: boolean): Verdict {
  const blocking = findings.filter((f) => f.severity === "block");
  const reported = findings.filter((f) => f.severity === "report");
  const parts: string[] = [];

  if (findings.length === 0) {
    parts.push("No change weakens the tests or the test gate.");
  } else if (blocking.length === 0) {
    parts.push("Nothing blocks this change.");
  } else if (hasExceptionLabel) {
    parts.push(
      `These changes would weaken the tests or the gate. The \`${EXCEPTION_LABEL}\` label accepts them:`,
    );
  } else {
    parts.push(
      `These changes weaken the tests or the gate. Explain why in the pull request, then add the \`${EXCEPTION_LABEL}\` label to accept them:`,
    );
  }
  if (blocking.length > 0) parts.push("", ...blocking.map(line));
  if (reported.length > 0) parts.push("", "For review (not blocking):", "", ...reported.map(line));

  return { pass: blocking.length === 0 || hasExceptionLabel, summary: parts.join("\n") };
}
