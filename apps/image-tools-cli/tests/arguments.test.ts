import { describe, expect, it } from "vite-plus/test";
import { parseArguments } from "../src/arguments.ts";

describe("parseArguments", () => {
  it("parses a bounded preparation", () => {
    const image = `example/imagemagick@sha256:${"a".repeat(64)}`;
    expect(
      parseArguments([
        "prepare",
        "fixture.gif",
        "--artifacts-dir",
        "artifacts",
        "--max-frames",
        "4",
        "--container-image",
        image,
      ]),
    ).toEqual({
      command: "prepare",
      inputPath: "fixture.gif",
      artifactsDirectory: "artifacts",
      maxFrames: 4,
      containerImage: image,
    });
  });

  it("refuses mutable container tags", () => {
    expect(() =>
      parseArguments([
        "prepare",
        "fixture.png",
        "--artifacts-dir",
        "artifacts",
        "--container-image",
        "example/imagemagick:latest",
      ]),
    ).toThrow("digest-pinned");
  });
});
