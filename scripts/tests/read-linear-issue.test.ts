import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  collectLinearIssue,
  detectMime,
  discoverReferences,
  type Fetcher,
  parseIssueLocator,
  readBounded,
  redactSignedUrls,
} from "../../skills/context/read-linear-issue/scripts/collector.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Linear issue locators", () => {
  it("accepts one identifier and rejects ambiguous URLs", () => {
    expect(parseIssueLocator("it-1314")).toBe("IT-1314");
    expect(parseIssueLocator("https://linear.app/acme/issue/IT-1314/title")).toBe("IT-1314");
    expect(() => parseIssueLocator("https://linear.app/acme/issue/IT-1314/related-IT-2")).toThrow(
      "exactly one",
    );
  });
});

describe("evidence discovery", () => {
  it("deduplicates uploads by stable path and preserves their source containers", () => {
    const references = discoverReferences([
      {
        container: "issue",
        field: "description",
        text: "![image](https://uploads.linear.app/work/file.png?signature=first) https://example.com/context",
      },
      {
        container: "comment:1",
        field: "body",
        text: "[same](https://uploads.linear.app/work/file.png?signature=second)",
      },
    ]);

    const upload = references.find((reference) => reference.kind === "linear-upload");
    expect(upload?.locations).toHaveLength(2);
    expect(references.filter((reference) => reference.kind === "external")).toHaveLength(1);
  });

  it("redacts signed upload queries from persisted prose", () => {
    expect(redactSignedUrls("See https://uploads.linear.app/work/file.png?signature=secret.")).toBe(
      "See https://uploads.linear.app/work/file.png?signature=[REDACTED].",
    );
  });

  it("redacts signed queries from external references", () => {
    const [reference] = discoverReferences([
      {
        container: "comment:1",
        field: "body",
        text: "https://storage.example.com/file?X-Amz-Signature=secret&part=1",
      },
    ]);

    expect(reference?.kind).toBe("external");
    if (reference?.kind !== "external") throw new Error("Expected an external reference");
    expect(reference.queryRedacted).toBe(true);
    expect(reference.url).not.toContain("secret");
    expect(reference.url).toContain("part=1");
  });

  it("redacts URL userinfo, passwords, and camel-case credential keys", () => {
    const redacted = redactSignedUrls(
      "https://alice:short-password@example.com/file?apiKey=short-api&authToken=short-auth&password=short-query&keep=1",
    );

    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("short-");
    expect(redacted).toContain("keep=1");
  });
});

describe("MIME detection", () => {
  it("classifies representative evidence from bytes", () => {
    expect(detectMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(detectMime(new TextEncoder().encode('{"ok":true}'))).toBe("application/json");
    expect(detectMime(new TextEncoder().encode('<svg viewBox="0 0 1 1"></svg>'))).toBe(
      "image/svg+xml",
    );
    expect(detectMime(new TextEncoder().encode("ID3fixture"))).toBe("audio/mpeg");
    expect(detectMime(new TextEncoder().encode("OggSfixture"))).toBe("audio/ogg");
    expect(detectMime(new TextEncoder().encode("fLaCfixture"))).toBe("audio/flac");
    expect(detectMime(new TextEncoder().encode("RIFF0000WAVEfixture"))).toBe("audio/wav");
    expect(detectMime(new TextEncoder().encode("0000ftypM4A fixture"))).toBe("audio/mp4");
  });
});

describe("bounded downloads", () => {
  it("charges bytes consumed before an oversized stream fails", async () => {
    let consumed = 0;
    const response = new Response(new Uint8Array(10));
    let failure: unknown;

    try {
      await readBounded(response, 4, (bytes) => (consumed += bytes));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("configured byte limit");
    expect(consumed).toBe(10);
  });
});

describe("collection", () => {
  it("paginates lanes, finds customer files, fails closed on project errors, and writes redacted artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "linear-skill-test-"));
    temporary.push(root);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const calls: Array<{ field: string; after: string | null }> = [];
    const fetcher: Fetcher = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://uploads.linear.app/")) {
        expect(init?.redirect).toBe("manual");
        if (url.includes("child.png")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/private" },
          });
        }
        return new Response(png, {
          headers: { "content-type": "image/png", "content-length": String(png.length) },
        });
      }
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as {
        query: string;
        variables: { after?: string | null };
      };
      if (body.query.includes("query Issue(")) {
        return Response.json({
          data: {
            organization: { id: "org", name: "Example", urlKey: "example" },
            issue: {
              id: "issue",
              identifier: "IT-1",
              title: "Fixture",
              description: "![fixture](https://uploads.linear.app/work/file.png?signature=secret)",
              project: { id: "project" },
            },
          },
        });
      }
      if (body.query.includes("query Project(")) {
        return Response.json({ errors: [{ message: "Project lane unavailable" }] });
      }
      const field = body.query.match(/issue\(id: \$id\)\s*\{\s*(\w+)\(first:/)?.[1];
      if (!field) throw new Error("Unexpected query in test");
      const after = body.variables.after ?? null;
      calls.push({ field, after });
      const firstCommentsPage = field === "comments" && after === null;
      const needs = field === "needs" && after === null;
      const children = field === "children" && after === null;
      return Response.json({
        data: {
          issue: {
            [field]: {
              nodes: firstCommentsPage
                ? [{ id: "comment", body: "reply", parentId: null }]
                : needs
                  ? [
                      {
                        id: "need",
                        body: "customer request",
                        attachment: {
                          id: "attachment",
                          title: "customer.png",
                          url: "https://uploads.linear.app/work/customer.png?signature=customer-secret",
                        },
                      },
                    ]
                  : children
                    ? [
                        {
                          id: "child",
                          description:
                            "![child](https://uploads.linear.app/work/child.png) https://related.example/context",
                        },
                      ]
                    : [],
              pageInfo: firstCommentsPage
                ? { hasNextPage: true, endCursor: "next" }
                : { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    };

    const result = await collectLinearIssue(
      "https://linear.app/example/issue/IT-1/title?token=request-secret",
      {
        apiKey: "test-only",
        artifactsDirectory: root,
        fetcher,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    expect(calls.filter((call) => call.field === "comments")).toEqual([
      { field: "comments", after: null },
      { field: "comments", after: "next" },
    ]);
    expect(result.files).toHaveLength(3);
    expect(result.files[0]?.status).toBe("retrieved");
    expect(result.gaps).toContain("project: Linear GraphQL error: Project lane unavailable");
    expect(result.gaps.some((gap) => gap.includes("download returned HTTP 302"))).toBe(true);
    expect(result.externalReferences.map((reference) => reference.url)).toContain(
      "https://related.example/context",
    );
    const context = await Bun.file(result.contextPath).text();
    expect(context).not.toContain("signature=secret");
    expect(context).not.toContain("request-secret");
  });
});
