import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DiscardOutputBoundary } from "./run-tool.ts";
import { discardOutputWithNode } from "./run-tool.ts";

// Every derivative claims a parent SHA-256. That claim is only true if the bytes the tool read are
// the bytes that were hashed, and nothing guarantees that across a subprocess boundary: the file is
// re-read from a mutable path after the hash was taken.
//
// So the hash is taken again at the end. A mismatch means the evidence identity became invalid
// mid-run, which is neither a tool failure nor an unsupported input, and it is not a partial
// result that can be reported with gaps: every derivative in the run is bound to bytes that may
// never have existed as a whole file. The derivatives are deleted and the run reports what
// happened.

export interface SourceIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

export interface InputChanged {
  outcome: "input-changed";
  inputPath: string;
  message: string;
  // Reported as evidence of the mismatch, never as alternative parent identities. A derivative
  // bound to either of these would be a claim this run cannot support.
  initialSha256: string;
  finalSha256: string;
}

export async function readSourceIdentity(path: string): Promise<{ identity: SourceIdentity; bytes: Uint8Array }> {
  const bytes = await readFile(path);
  return {
    identity: { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
    bytes,
  };
}

export async function detectInputChange(options: {
  identity: SourceIdentity;
  writtenPaths: readonly string[];
  discardOutput?: DiscardOutputBoundary;
}): Promise<InputChanged | null> {
  let finalSha256: string;
  try {
    finalSha256 = createHash("sha256").update(await readFile(options.identity.path)).digest("hex");
  } catch (error) {
    finalSha256 = "";
    // A source that vanished mid-run is a changed source. Fall through to invalidation rather than
    // letting the read error surface as an unrelated crash.
    void error;
  }
  if (finalSha256 === options.identity.sha256) return null;
  const discardOutput = options.discardOutput ?? discardOutputWithNode;
  // Remove the physical files, not only the manifest entries. A stale derivative left on disk is
  // one an agent can still open and mistake for bound evidence.
  for (const path of options.writtenPaths) await discardOutput(path);
  return {
    outcome: "input-changed",
    inputPath: options.identity.path,
    message:
      "the original file changed while it was being processed, so every derivative from this run was discarded; reacquire or stabilize the source before retrying",
    initialSha256: options.identity.sha256,
    finalSha256: finalSha256 === "" ? "unreadable" : finalSha256,
  };
}
