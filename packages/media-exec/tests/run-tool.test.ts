import { describe, expect, it } from "vite-plus/test";
import { runTool, type ExecBoundary, type ExecResult } from "../src/index.ts";

const REQUEST = { command: "magick", args: ["-version"], cwd: "/fixture/run" };

function settlesAfter(delayMs: number): { boundary: ExecBoundary; settled: () => boolean } {
  let done = false;
  return {
    settled: () => done,
    boundary: () =>
      new Promise<ExecResult>((resolve) => {
        setTimeout(() => {
          done = true;
          resolve({ exitCode: 137, stdout: "", stderr: "killed" });
        }, delayMs);
      }),
  };
}

describe("runTool deadlines", () => {
  // A call that can leave a partial file behind must not report until the executor settles, or the
  // caller deletes a derivative the tool is still writing.
  it("waits for a writing executor to settle before reporting a timeout", async () => {
    const { boundary, settled } = settlesAfter(60);

    const run = await runTool(boundary, REQUEST, 20);

    expect(run.kind).toBe("timeout");
    expect(settled()).toBe(true);
  });

  // Discovery writes nothing, so waiting on a wedged process would hang the whole run instead of
  // reporting the deadline the caller asked for.
  it("reports a non-writing timeout without waiting for the executor", async () => {
    const run = await runTool(() => new Promise<ExecResult>(() => {}), REQUEST, 20, {
      writesOutput: false,
    });

    expect(run.kind).toBe("timeout");
  });
});
