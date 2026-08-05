import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { afterEach, describe, expect, it } from "bun:test";
import {
  acquireSlackFiles,
  detectMime,
  parseSlackPermalink,
  readBounded,
  type Fetcher,
} from "../../skills/context/read-slack-thread/scripts/acquirer.ts";

const PERMALINK = "https://example.slack.com/archives/C012ABCDEF/p1700000000123456";
const REPLY_PERMALINK =
  "https://example.slack.com/archives/C012ABCDEF/p1700000000654321?thread_ts=1700000000.123456&cid=C012ABCDEF";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Slack locators", () => {
  it("parses one exact message permalink", () => {
    expect(parseSlackPermalink(PERMALINK)).toEqual({
      workspaceHost: "example.slack.com",
      channelId: "C012ABCDEF",
      messageTs: "1700000000.123456",
    });
    expect(parseSlackPermalink(REPLY_PERMALINK).messageTs).toBe("1700000000.654321");
    expect(() => parseSlackPermalink("https://example.slack.com/archives/C012ABCDEF")).toThrow(
      "identify one message",
    );
  });
});

describe("Slack file acquisition", () => {
  it("does not load a repository .env file", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "slack-env-test-"));
    temporary.push(workingDirectory);
    await writeFile(join(workingDirectory, ".env"), "SLACK_BOT_TOKEN=must-not-load\n");
    const script = join(
      import.meta.dir,
      "../../skills/context/read-slack-thread/scripts/acquire.ts",
    );
    const child = Bun.spawn(
      [
        execPath,
        "--no-env-file",
        script,
        PERMALINK,
        "--root-ts",
        "1700000000.123456",
        "--objective",
        "Understand the image",
        "--file-id",
        "FPNG",
        "--artifacts-dir",
        join(workingDirectory, "artifacts"),
      ],
      {
        cwd: workingDirectory,
        env: { PATH: Bun.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SLACK_BOT_TOKEN is unavailable in the runtime");
  });

  it("requires an objective before using a credential", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    let calls = 0;
    let failure: unknown;
    try {
      await acquireSlackFiles(PERMALINK, ["FPNG"], {
        token: "test-token",
        objective: " ",
        rootTs: "1700000000.123456",
        artifactsDirectory,
        fetcher: async () => {
          calls += 1;
          throw new Error("Credential must not be used");
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("objective is required");
    expect(calls).toBe(0);
  });

  it("verifies the workspace and acquires selected supported files", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const bodies = new Map<string, Uint8Array>([
      ["FPNG", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      ["FMP4", new TextEncoder().encode("0000ftypisomfixture")],
      ["FTEXT", new TextEncoder().encode("fixture text")],
    ]);
    const names = new Map([
      ["FPNG", "fixture.png"],
      ["FMP4", "fixture.mp4"],
      ["FTEXT", "fixture.txt"],
    ]);
    const mimes = new Map([
      ["FPNG", "image/png"],
      ["FMP4", "video/mp4"],
      ["FTEXT", "text/plain"],
    ]);
    const fetcher: Fetcher = async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test")) {
        return Response.json({
          ok: true,
          url: "https://example.slack.com/",
          team_id: "TEXAMPLE",
          user_id: "UBOT",
        });
      }
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPNG", "FMP4", "FTEXT"]);
      if (url.endsWith("/files.info")) {
        if (typeof init?.body !== "string") throw new Error("Expected form-encoded fields");
        const id = new URLSearchParams(init.body).get("file");
        if (!id || !bodies.has(id)) throw new Error("Unexpected file identity");
        return Response.json({
          ok: true,
          file: {
            id,
            name: names.get(id),
            mimetype: mimes.get(id),
            size: bodies.get(id)!.byteLength,
            url_private_download: `https://files.slack.com/download/${id}`,
          },
        });
      }
      if (url.startsWith("https://files.slack.com/download/")) {
        const id = url.split("/").at(-1)!;
        const body = bodies.get(id);
        if (!body) throw new Error("Unexpected download identity");
        expect(init?.headers).toEqual({ Authorization: "Bearer test-token" });
        expect(init?.redirect).toBe("manual");
        return new Response(body.slice().buffer);
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await acquireSlackFiles(PERMALINK, ["FPNG", "FMP4", "FTEXT", "FPNG"], {
      token: "test-token",
      objective: "Understand the supported fixture files",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

    expect(result.requestedFileIds).toEqual(["FPNG", "FMP4", "FTEXT"]);
    expect(result.files.map((file) => file.status)).toEqual([
      "retrieved",
      "retrieved",
      "retrieved",
    ]);
    expect(
      result.files.map((file) => (file.status === "retrieved" ? file.detectedMime : null)),
    ).toEqual(["image/png", "video/mp4", "text/plain"]);
    const manifest = await Bun.file(result.manifestPath).text();
    expect(manifest).not.toContain("test-token");
    expect(manifest).not.toContain("files.slack.com");
    expect(manifest).not.toContain(artifactsDirectory);
    expect(JSON.parse(manifest).manifestPath).toBe("slack-files.json");
    expect(JSON.parse(manifest).objective).toBe("Understand the supported fixture files");
  });

  it("resolves a reply permalink and verifies files across every root page", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const replyCalls: Array<{ ts: string | null; cursor: string | null }> = [];
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetcher: Fetcher = async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test"))
        return Response.json({
          ok: true,
          url: "https://example.slack.com/",
          team_id: "TEXAMPLE",
          user_id: "UBOT",
        });
      if (url.endsWith("/conversations.replies")) {
        if (typeof init?.body !== "string") throw new Error("Expected form-encoded fields");
        const fields = new URLSearchParams(init.body);
        const ts = fields.get("ts");
        const cursor = fields.get("cursor");
        replyCalls.push({ ts, cursor });
        if (!cursor)
          return Response.json({
            ok: true,
            messages: [{ ts: "1700000000.123456" }],
            response_metadata: { next_cursor: "next" },
          });
        return Response.json({
          ok: true,
          messages: [
            { ts: "1700000000.123456" },
            {
              ts: "1700000000.654321",
              thread_ts: "1700000000.123456",
              files: [{ id: "FPNG" }],
            },
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "FPNG",
            name: "fixture.png",
            url_private_download: "https://files.slack.com/private",
          },
        });
      if (url === "https://files.slack.com/private") return new Response(bytes.slice().buffer);
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await acquireSlackFiles(REPLY_PERMALINK, ["FPNG"], {
      token: "test-token",
      objective: "Understand the image",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
    });
    expect(result.rootTs).toBe("1700000000.123456");
    expect(result.files[0]?.status).toBe("retrieved");
    expect(replyCalls).toEqual([
      { ts: "1700000000.123456", cursor: null },
      { ts: "1700000000.123456", cursor: "next" },
    ]);
  });

  it("refuses a canonical root inconsistent with the exposing reply", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test")) return identityResponse();
      if (url.endsWith("/conversations.replies"))
        return Response.json({
          ok: true,
          messages: [
            {
              ts: "1700000000.654321",
              thread_ts: "1700000000.123456",
              files: [{ id: "FPNG" }],
            },
          ],
          response_metadata: { next_cursor: "" },
        });
      throw new Error("Inconsistent roots must fail before file metadata");
    };

    let failure: unknown;
    try {
      await acquireSlackFiles(REPLY_PERMALINK, ["FPNG"], {
        token: "test-token",
        objective: "Understand the image",
        rootTs: "1700000000.999999",
        artifactsDirectory,
        fetcher,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "does not belong to the provided canonical thread",
    );
  });

  it("preserves repeated-root files and retries a bounded pagination rate limit", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    let nextPageAttempts = 0;
    const sleeps: number[] = [];
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetcher: Fetcher = async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test")) return identityResponse();
      if (url.endsWith("/conversations.replies")) {
        if (typeof init?.body !== "string") throw new Error("Expected form-encoded fields");
        const cursor = new URLSearchParams(init.body).get("cursor");
        if (!cursor)
          return Response.json({
            ok: true,
            messages: [{ ts: "1700000000.123456", files: [{ id: "FPNG" }] }],
            response_metadata: { next_cursor: "next" },
          });
        nextPageAttempts += 1;
        if (nextPageAttempts === 1)
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "60" },
          });
        return Response.json({
          ok: true,
          messages: [{ ts: "1700000000.123456" }],
          response_metadata: { next_cursor: "" },
        });
      }
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "FPNG",
            name: "fixture.png",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private",
          },
        });
      if (url === "https://files.slack.com/private") return new Response(bytes.slice().buffer);
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await acquireSlackFiles(PERMALINK, ["FPNG"], {
      token: "test-token",
      objective: "Understand the image",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    expect(result.files[0]?.status).toBe("retrieved");
    expect(nextPageAttempts).toBe(2);
    expect(sleeps).toEqual([60_000]);
  });

  it("refuses a credential from another workspace before requesting files", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return Response.json({
        ok: true,
        url: "https://other.slack.com/",
        team_id: "TOTHER",
        user_id: "UBOT",
      });
    };

    let failure: unknown;
    try {
      await acquireSlackFiles(PERMALINK, ["FPNG"], {
        token: "test-token",
        objective: "Understand the image",
        rootTs: "1700000000.123456",
        artifactsDirectory,
        fetcher,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("other.slack.com, not example.slack.com");
    expect(calls).toBe(1);
  });

  it("records a redirect as a file gap without following it", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test"))
        return Response.json({
          ok: true,
          url: "https://example.slack.com/",
          team_id: "TEXAMPLE",
          user_id: "UBOT",
        });
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPNG"]);
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "FPNG",
            name: "fixture.png",
            url_private_download: "https://files.slack.com/download/FPNG",
          },
        });
      if (url === "https://files.slack.com/download/FPNG")
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/private" },
        });
      throw new Error(`Redirect target must not be requested: ${url}`);
    };

    const result = await acquireSlackFiles(PERMALINK, ["FPNG"], {
      token: "test-token",
      objective: "Understand the image",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
    });
    expect(result.files).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "Slack file download returned a redirect",
      }),
    ]);
  });

  it("refuses a selected file that the canonical thread did not expose", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const calls: string[] = [];
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url.endsWith("/auth.test"))
        return Response.json({
          ok: true,
          url: "https://example.slack.com/",
          team_id: "TEXAMPLE",
          user_id: "UBOT",
        });
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPNG"]);
      throw new Error("Unrelated files must not be requested");
    };

    let failure: unknown;
    try {
      await acquireSlackFiles(PERMALINK, ["FOTHER"], {
        token: "test-token",
        objective: "Understand the selected file",
        rootTs: "1700000000.123456",
        artifactsDirectory,
        fetcher,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("not present in the canonical thread");
    expect(calls.every((url) => !url.endsWith("/files.info"))).toBe(true);
  });

  it("redacts provider URLs from persisted file gaps", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test"))
        return Response.json({
          ok: true,
          url: "https://example.slack.com/",
          team_id: "TEXAMPLE",
          user_id: "UBOT",
        });
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPNG"]);
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: false,
          error: "https://files.slack.com/private?signature=PRIVATE",
        });
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await acquireSlackFiles(PERMALINK, ["FPNG"], {
      token: "test-token",
      objective: "Understand the image",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
    });
    const manifest = await Bun.file(result.manifestPath).text();
    expect(manifest).not.toContain("PRIVATE");
    expect(manifest).not.toContain("files.slack.com");
    expect(result.files[0]).toEqual(
      expect.objectContaining({ status: "failed", error: "Slack files.info failed: http_200" }),
    );
  });

  it("redacts bearer credentials from stream failures", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test")) return identityResponse();
      if (url.endsWith("/conversations.replies")) return threadResponse(["FTEXT"]);
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "FTEXT",
            name: "fixture.txt",
            mimetype: "text/plain",
            url_private_download: "https://files.slack.com/private",
          },
        });
      if (url === "https://files.slack.com/private")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("upstream echoed Bearer secret-token"));
            },
          }),
        );
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await acquireSlackFiles(PERMALINK, ["FTEXT"], {
      token: "test-token",
      objective: "Understand the text",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
    });
    const manifest = await Bun.file(result.manifestPath).text();
    expect(manifest).not.toContain("secret-token");
    expect(result.files[0]).toEqual(
      expect.objectContaining({ error: "upstream echoed Bearer [REDACTED]" }),
    );
  });

  it("does not send credentials to a Slack file URL on an alternate port", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    let downloads = 0;
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test"))
        return Response.json({
          ok: true,
          url: "https://example.slack.com/",
          team_id: "TEXAMPLE",
          user_id: "UBOT",
        });
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPNG"]);
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "FPNG",
            name: "fixture.png",
            url_private_download: "https://files.slack.com:4443/private",
          },
        });
      downloads += 1;
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    };

    const result = await acquireSlackFiles(PERMALINK, ["FPNG"], {
      token: "test-token",
      objective: "Understand the image",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
    });
    expect(downloads).toBe(0);
    expect(result.files[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "Slack file download URL is outside files.slack.com",
      }),
    );
  });

  it("leaves a known unsupported file unread without downloading it", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    let downloads = 0;
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test")) return identityResponse();
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPDF"]);
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "FPDF",
            name: "payload.txt",
            mimetype: "application/pdf",
            url_private_download: "https://files.slack.com/private",
          },
        });
      downloads += 1;
      return new Response("must not download");
    };

    const result = await acquireSlackFiles(PERMALINK, ["FPDF"], {
      token: "test-token",
      objective: "Understand the document",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
    });
    expect(downloads).toBe(0);
    expect(result.files[0]).toEqual(
      expect.objectContaining({
        status: "unsupported",
        error: "Slack file type is unsupported for acquisition",
      }),
    );
  });

  it("does not start another download after a failed stream exhausts the total budget", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    temporary.push(artifactsDirectory);
    const downloads: string[] = [];
    const fetcher: Fetcher = async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test")) return identityResponse();
      if (url.endsWith("/conversations.replies")) return threadResponse(["FTEXT1", "FTEXT2"]);
      if (url.endsWith("/files.info")) {
        if (typeof init?.body !== "string") throw new Error("Expected form-encoded fields");
        const id = new URLSearchParams(init.body).get("file");
        return Response.json({
          ok: true,
          file: {
            id,
            name: `${id}.txt`,
            mimetype: "text/plain",
            url_private_download: `https://files.slack.com/${id}`,
          },
        });
      }
      if (url.startsWith("https://files.slack.com/")) {
        downloads.push(url.split("/").at(-1)!);
        return new Response(new Uint8Array(10));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await acquireSlackFiles(PERMALINK, ["FTEXT1", "FTEXT2"], {
      token: "test-token",
      objective: "Understand the text files",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
      limits: { maxFileBytes: 4, maxTotalBytes: 4 },
    });
    expect(downloads).toEqual(["FTEXT1"]);
    expect(result.files.map((file) => file.status)).toEqual(["failed", "failed"]);
    expect(result.files[1]).toEqual(
      expect.objectContaining({ error: "Slack files exceed the total byte limit" }),
    );
  });

  it("uses an atomic run directory instead of a predictable symlinked path", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "slack-files-test-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "slack-files-outside-"));
    temporary.push(artifactsDirectory, outsideDirectory);
    const predictable = join(artifactsDirectory, "slack-files-2026-08-05T12-00-00-000Z");
    await mkdir(predictable);
    await symlink(outsideDirectory, join(predictable, "files"));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test"))
        return Response.json({
          ok: true,
          url: "https://example.slack.com/",
          team_id: "TEXAMPLE",
          user_id: "UBOT",
        });
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPNG"]);
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "FPNG",
            name: "fixture.png",
            url_private_download: "https://files.slack.com/private",
          },
        });
      if (url === "https://files.slack.com/private") return new Response(bytes.slice().buffer);
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await acquireSlackFiles(PERMALINK, ["FPNG"], {
      token: "test-token",
      objective: "Understand the image",
      rootTs: "1700000000.123456",
      artifactsDirectory,
      fetcher,
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });
    expect(result.files[0]?.status).toBe("retrieved");
    expect(await readdir(outsideDirectory)).toEqual([]);
    expect(result.manifestPath.startsWith(predictable)).toBe(false);
  });

  it("refuses an artifacts directory that is itself a symbolic link", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "slack-files-parent-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "slack-files-outside-"));
    temporary.push(parentDirectory, outsideDirectory);
    const artifactsDirectory = join(parentDirectory, "artifacts-link");
    await symlink(outsideDirectory, artifactsDirectory);
    const fetcher: Fetcher = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth.test")) return identityResponse();
      if (url.endsWith("/conversations.replies")) return threadResponse(["FPNG"]);
      throw new Error("File metadata must not be requested");
    };

    let failure: unknown;
    try {
      await acquireSlackFiles(PERMALINK, ["FPNG"], {
        token: "test-token",
        objective: "Understand the image",
        rootTs: "1700000000.123456",
        artifactsDirectory,
        fetcher,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("must not be a symbolic link");
    expect(await readdir(outsideDirectory)).toEqual([]);
  });
});

describe("bounded Slack downloads", () => {
  it("charges consumed bytes before an oversized stream fails", async () => {
    let consumed = 0;
    let failure: unknown;
    try {
      await readBounded(new Response(new Uint8Array(10)), 4, (bytes) => (consumed += bytes));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("configured byte limit");
    expect(consumed).toBe(10);
  });
});

describe("Slack file routing", () => {
  it("recognizes MP3 frames and keeps Ogg containers generic", () => {
    expect(detectMime(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe("audio/mpeg");
    expect(detectMime(new TextEncoder().encode("OggSfixture"))).toBe("application/ogg");
  });
});

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function threadResponse(fileIds: readonly string[]): Response {
  return Response.json({
    ok: true,
    messages: [
      {
        ts: "1700000000.123456",
        files: fileIds.map((id) => ({ id })),
      },
    ],
    response_metadata: { next_cursor: "" },
  });
}

function identityResponse(): Response {
  return Response.json({
    ok: true,
    url: "https://example.slack.com/",
    team_id: "TEXAMPLE",
    user_id: "UBOT",
  });
}
