import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  collectPylonIssue,
  parsePylonAssetUrl,
  parsePylonLocator,
  resolvePylonApiUrl,
} from "../../skills/context/read-pylon-issue/scripts/collector.ts";

const issueId = "a8667e49-5f40-4106-b6cb-20da07d9cc2c";
const asset = (name: string) =>
  `https://assets.usepylon.com/${name}?Expires=1788460000&Key-Pair-Id=key&Signature=signed`;

describe("read-pylon-issue", () => {
  test("accepts exact issue locators and signed Pylon assets", () => {
    expect(parsePylonLocator("7")).toEqual({ kind: "number", value: "7" });
    expect(parsePylonLocator(issueId)).toEqual({ kind: "id", value: issueId });
    expect(parsePylonLocator("https://app.usepylon.com/issues?issueNumber=7")).toEqual({
      kind: "number",
      value: "7",
    });
    expect(parsePylonAssetUrl(asset("fixture.docx")).hostname).toBe("assets.usepylon.com");
    expect(resolvePylonApiUrl(undefined)).toBe("https://api.usepylon.com");

    for (const input of [
      "https://app.usepylon.com/issues",
      "https://app.usepylon.com.attacker.test/issues?issueNumber=7",
      "https://app.usepylon.com/issues?issueNumber=7&extra=1",
    ]) {
      expect(() => parsePylonLocator(input)).toThrow();
    }
    for (const input of [
      "https://assets.usepylon.com.attacker.test/file?Expires=1&Key-Pair-Id=k&Signature=s",
      "https://assets.usepylon.com/file?Expires=1&Key-Pair-Id=k&Signature=s&extra=1",
      "https://assets.usepylon.com/file?Expires=1&Key-Pair-Id=k",
    ]) {
      expect(() => parsePylonAssetUrl(input)).toThrow();
    }
  });

  test("collects context and files without leaking credentials", async () => {
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "read-pylon-issue-test-"));
    const requests: Request[] = [];
    const fixtureUrl = asset("fixture");
    const traceUrl = asset("trace");
    let issueReads = 0;
    try {
      const result = await collectPylonIssue("7", {
        apiUrl: "https://api.usepylon.com",
        artifactsDirectory,
        token: "pylon-test-token",
        now: () => new Date("2026-09-03T20:00:00Z"),
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          const url = new URL(request.url);
          if (url.hostname === "assets.usepylon.com") {
            const name = url.pathname === "/fixture" ? "fixture.docx" : "trace.json";
            const bytes =
              url.pathname === "/fixture"
                ? new Uint8Array([0x50, 0x4b, 1, 2])
                : new TextEncoder().encode('{"ok":true}');
            const response = new Response(bytes, {
              headers: { "content-disposition": `inline; filename=${name}` },
            });
            Object.defineProperty(response, "url", { value: request.url });
            return response;
          }
          if (url.pathname === "/me") {
            return Response.json({ data: { id: "org-1", name: "Workspace" } });
          }
          if (url.pathname === "/issues/7") {
            issueReads += 1;
            return Response.json({
              data: {
                id: issueId,
                number: 7,
                title: "Tracked changes cannot be accepted",
                body_html: "<p>See https://linear.app/acme/issue/SD-1/test</p>",
                link: "https://app.usepylon.com/issues?issueNumber=7",
                state: "pip_investigation",
                source: "slack",
                updated_at: "2026-09-03T19:00:00Z",
                attachment_urls: [fixtureUrl],
                external_issues: [
                  {
                    source: "linear",
                    external_id: "linear-1",
                    link: "https://linear.app/acme/issue/SD-1/test",
                  },
                ],
              },
            });
          }
          if (url.pathname === "/issues/7/threads") {
            return Response.json({
              data: [{ id: "thread-1", name: "engineering", source: "pylon" }],
            });
          }
          if (url.pathname === "/issues/7/messages" && !url.searchParams.has("cursor")) {
            return Response.json({
              data: [
                {
                  id: "message-1",
                  is_private: false,
                  message_html: "customer report",
                  file_urls: [traceUrl],
                },
              ],
              pagination: { has_next_page: true, cursor: "next" },
            });
          }
          if (url.pathname === "/issues/7/messages") {
            return Response.json({
              data: [
                {
                  id: "message-2",
                  is_private: true,
                  message_html: "internal detail",
                  thread_id: "thread-1",
                  file_urls: [],
                },
              ],
              pagination: { has_next_page: false, cursor: "done" },
            });
          }
          return new Response(null, { status: 404 });
        },
      });

      expect(issueReads).toBe(2);
      expect(result.gaps).toEqual([]);
      expect(result.files).toHaveLength(2);
      expect(result.files.every((file) => file.status === "retrieved")).toBe(true);
      const context = await readFile(result.contextPath, "utf8");
      const manifest = await readFile(result.manifestPath, "utf8");
      expect(context).toContain("thread-1");
      expect(context).toContain("pylon-asset-");
      expect(manifest).toContain("fixture.docx");
      expect(manifest).toContain("https://linear.app/acme/issue/SD-1/test");
      for (const secret of ["pylon-test-token", "Signature=signed", "Key-Pair-Id=key"]) {
        expect(context).not.toContain(secret);
        expect(manifest).not.toContain(secret);
      }

      const apiRequests = requests.filter(
        (request) => new URL(request.url).hostname === "api.usepylon.com",
      );
      const assetRequests = requests.filter(
        (request) => new URL(request.url).hostname === "assets.usepylon.com",
      );
      expect(
        apiRequests.every(
          (request) => request.headers.get("authorization") === "Bearer pylon-test-token",
        ),
      ).toBe(true);
      expect(assetRequests.every((request) => request.headers.get("authorization") === null)).toBe(
        true,
      );
      expect(assetRequests.every((request) => request.redirect === "manual")).toBe(true);
    } finally {
      await rm(artifactsDirectory, { recursive: true, force: true });
    }
  });
});
