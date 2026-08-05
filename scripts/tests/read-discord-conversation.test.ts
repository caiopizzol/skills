import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { afterEach, describe, expect, it } from "bun:test";
import {
  collectDiscordConversation,
  parseDiscordPermalink,
  type Fetcher,
} from "../../skills/context/read-discord-conversation/scripts/collector.ts";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const ROOT = "100000000000000003";
const REPLY = "100000000000000004";
const UNRELATED = "100000000000000005";
const PERMALINK = `https://discord.com/channels/${GUILD}/${CHANNEL}/${ROOT}`;
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Discord locators", () => {
  it("accepts one exact guild message permalink", () => {
    expect(parseDiscordPermalink(PERMALINK)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: ROOT,
      permalink: PERMALINK,
    });
    expect(() => parseDiscordPermalink(`https://discord.com/channels/${GUILD}/${CHANNEL}`)).toThrow(
      "identify one guild message",
    );
    expect(() =>
      parseDiscordPermalink(`https://discord.com/channels/@me/${CHANNEL}/${ROOT}`),
    ).toThrow("direct-message");
    expect(() => parseDiscordPermalink(`${PERMALINK}?query=1`)).toThrow("exact HTTPS");
  });
});

describe("Discord conversation collection", () => {
  it("retrieves descendant replies, supported files, and external references", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const apiHeaders: string[] = [];
    const cdnHeaders: Array<string | null> = [];
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === "discord.com") {
        apiHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
        if (url.pathname.endsWith("/users/@me")) return Response.json(bot());
        if (url.pathname.endsWith(`/guilds/${GUILD}`))
          return Response.json({ id: GUILD, name: "Fixture guild" });
        if (url.pathname.endsWith(`/channels/${CHANNEL}`)) return Response.json(channel());
        if (url.pathname.endsWith(`/channels/${CHANNEL}/messages/${ROOT}`))
          return Response.json({
            ...message(ROOT, {
              content: "Root evidence https://example.com/context",
              attachments: [attachment("ATEXT", "fixture.txt", "text/plain", 12)],
            }),
            guild_id: undefined,
          });
        if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`)) {
          return Response.json([
            message(UNRELATED, { content: "Unrelated" }),
            message(REPLY, {
              type: 19,
              replyTo: ROOT,
              content: "Reply evidence",
              attachments: [attachment("APNG", "fixture.png", "image/png", 8)],
            }),
            message(ROOT, { content: "Root evidence" }),
          ]);
        }
      }
      if (url.hostname === "cdn.discordapp.com") {
        cdnHeaders.push(new Headers(init?.headers).get("authorization"));
        if (url.pathname.endsWith("/ATEXT/fixture.txt"))
          return new Response("fixture text", { headers: { "content-type": "text/plain" } });
        if (url.pathname.endsWith("/APNG/fixture.png"))
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            headers: { "content-type": "image/png" },
          });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await collectDiscordConversation(PERMALINK, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
    });

    expect(result.messages.map((entry) => entry.id)).toEqual([ROOT, REPLY]);
    expect(result.conversation).toEqual({
      kind: "message",
      rootMessageId: ROOT,
      requestedMessageId: ROOT,
      scannedMessages: 3,
      paginationComplete: true,
    });
    expect(result.externalReferences).toEqual(["https://example.com/context"]);
    expect(result.files).toEqual([
      expect.objectContaining({ id: "ATEXT", status: "retrieved", detectedMime: "text/plain" }),
      expect.objectContaining({ id: "APNG", status: "retrieved", detectedMime: "image/png" }),
    ]);
    expect(result.gaps).toEqual([]);
    expect(apiHeaders.every((value) => value === "Bot fixture-token")).toBe(true);
    expect(cdnHeaders).toEqual([null, null]);
    expect(await Bun.file(result.contextPath).exists()).toBe(true);
  });

  it("follows ancestry before finding sibling and transitive replies", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const parent = "100000000000000010";
    const requestedReply = "100000000000000011";
    const sibling = "100000000000000012";
    const nested = "100000000000000013";
    const permalink = `https://discord.com/channels/${GUILD}/${CHANNEL}/${requestedReply}`;
    const fetcher = discordFixture(async (url) => {
      if (url.pathname.endsWith(`/messages/${requestedReply}`))
        return Response.json(message(requestedReply, { type: 19, replyTo: parent }));
      if (url.pathname.endsWith(`/messages/${parent}`)) return Response.json(message(parent));
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
        return Response.json([
          message(nested, { type: 19, replyTo: sibling }),
          message(sibling, { type: 19, replyTo: parent }),
          message(requestedReply, { type: 19, replyTo: parent }),
          message(parent),
        ]);
      return undefined;
    });

    const result = await collectDiscordConversation(permalink, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
    });

    expect(result.conversation.rootMessageId).toBe(parent);
    expect(result.messages.map((entry) => entry.id)).toEqual([
      parent,
      requestedReply,
      sibling,
      nested,
    ]);
    expect(result.conversation.paginationComplete).toBe(true);
  });

  it("fully paginates a Discord thread channel", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const threadRoot = "100000000000000020";
    const threadReply = "100000000000000021";
    const permalink = `https://discord.com/channels/${GUILD}/${CHANNEL}/${threadReply}`;
    const fetcher = discordFixture(async (url) => {
      if (url.pathname.endsWith(`/channels/${CHANNEL}`))
        return Response.json(channel({ type: 11 }));
      if (url.pathname.endsWith(`/messages/${threadReply}`))
        return Response.json(message(threadReply));
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
        return Response.json([message(threadReply), message(threadRoot)]);
      return undefined;
    });

    const result = await collectDiscordConversation(permalink, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
    });

    expect(result.conversation.kind).toBe("thread");
    expect(result.conversation.rootMessageId).toBe(threadRoot);
    expect(result.messages.map((entry) => entry.id)).toEqual([threadRoot, threadReply]);
    expect(result.conversation.paginationComplete).toBe(true);
  });

  it("fails closed when the descendant scan reaches its bound", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const fetcher = discordFixture(async (url) => {
      if (url.pathname.endsWith(`/messages/${ROOT}`)) return Response.json(message(ROOT));
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
        return Response.json([message(UNRELATED)]);
      return undefined;
    });

    const result = await collectDiscordConversation(PERMALINK, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
      limits: { maxScannedMessages: 2, maxFiles: 1, maxFileBytes: 100, maxTotalBytes: 100 },
    });

    expect(result.conversation.paginationComplete).toBe(false);
    expect(result.gaps).toContain(
      "Conversation pagination stopped before completeness was established",
    );
  });

  it("does not call an empty history response complete", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const fetcher = discordFixture(async (url) => {
      if (url.pathname.endsWith(`/messages/${ROOT}`)) return Response.json(message(ROOT));
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`)) return Response.json([]);
      return undefined;
    });

    const result = await collectDiscordConversation(PERMALINK, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
    });

    expect(result.conversation.paginationComplete).toBe(false);
    expect(result.gaps).toContain(
      "Conversation pagination stopped before completeness was established",
    );
  });

  it("rejects attachment URLs outside Discord CDN without sending the token", async () => {
    const artifactsDirectory = await temporaryDirectory();
    let outsideCalls = 0;
    const fetcher = discordFixture(async (url) => {
      if (url.hostname === "evil.example") {
        outsideCalls += 1;
        return new Response("not reached");
      }
      if (url.pathname.endsWith(`/messages/${ROOT}`))
        return Response.json(
          message(ROOT, {
            attachments: [
              {
                id: "ABAD",
                filename: "fixture.txt",
                content_type: "text/plain",
                size: 7,
                url: "https://evil.example/fixture.txt",
              },
            ],
          }),
        );
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
        return Response.json([message(ROOT)]);
      return undefined;
    });

    const result = await collectDiscordConversation(PERMALINK, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
    });

    expect(outsideCalls).toBe(0);
    expect(result.files).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "Attachment URL is outside the Discord CDN",
      }),
    ]);
  });

  it("redacts signed URLs and URL credentials from persisted messages", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const sensitive =
      "https://alice:password@example.com/context?apiKey=secret&authToken=other&keep=1";
    const fetcher = discordFixture(async (url) => {
      if (url.pathname.endsWith(`/messages/${ROOT}`))
        return Response.json(message(ROOT, { content: `Evidence ${sensitive}` }));
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
        return Response.json([message(ROOT)]);
      return undefined;
    });

    const result = await collectDiscordConversation(PERMALINK, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
    });
    const persisted = await Bun.file(result.contextPath).text();

    expect(persisted).not.toContain("alice");
    expect(persisted).not.toContain("secret");
    expect(persisted).not.toContain("other");
    expect(persisted).toContain("keep=1");
  });

  it("charges a failed oversized stream before considering another attachment", async () => {
    const artifactsDirectory = await temporaryDirectory();
    let attachmentCalls = 0;
    const fetcher = discordFixture(async (url) => {
      if (url.hostname === "cdn.discordapp.com") {
        attachmentCalls += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("123456"));
              controller.enqueue(new TextEncoder().encode("789012"));
              controller.close();
            },
          }),
        );
      }
      if (url.pathname.endsWith(`/messages/${ROOT}`))
        return Response.json(
          message(ROOT, {
            attachments: [
              attachment("AONE", "one.txt", "text/plain", 1),
              attachment("ATWO", "two.txt", "text/plain", 1),
            ],
          }),
        );
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
        return Response.json([message(ROOT)]);
      return undefined;
    });

    const result = await collectDiscordConversation(PERMALINK, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
      limits: { maxScannedMessages: 10, maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 10 },
    });

    expect(attachmentCalls).toBe(1);
    expect(result.files).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "Attachment exceeded its byte limit while streaming",
      }),
      expect.objectContaining({
        status: "failed",
        error: "Attachments exceed the total byte limit",
      }),
    ]);
  });

  it("honors Discord rate limits with a bounded retry", async () => {
    const artifactsDirectory = await temporaryDirectory();
    const sleeps: number[] = [];
    let identityCalls = 0;
    const fetcher = discordFixture(async (url) => {
      if (url.pathname.endsWith("/users/@me")) {
        identityCalls += 1;
        if (identityCalls === 1) return Response.json({ retry_after: 0.25 }, { status: 429 });
        return Response.json(bot());
      }
      if (url.pathname.endsWith(`/messages/${ROOT}`)) return Response.json(message(ROOT));
      if (url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
        return Response.json([message(ROOT)]);
      return undefined;
    });

    await collectDiscordConversation(PERMALINK, {
      token: "fixture-token",
      artifactsDirectory,
      fetcher,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    expect(identityCalls).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it("does not load a repository .env file", async () => {
    const workingDirectory = await temporaryDirectory();
    await writeFile(join(workingDirectory, ".env"), "DISCORD_BOT_TOKEN=must-not-load\n");
    const artifactsDirectory = join(workingDirectory, "artifacts");
    const script = join(
      import.meta.dir,
      "../../skills/context/read-discord-conversation/scripts/collect.ts",
    );
    const child = Bun.spawn(
      [execPath, "--no-env-file", script, PERMALINK, "--artifacts-dir", artifactsDirectory],
      {
        cwd: workingDirectory,
        env: { PATH: Bun.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("DISCORD_BOT_TOKEN is required");
    expect(await readdir(workingDirectory)).toEqual([".env"]);
  });
});

function discordFixture(
  override: (url: URL, init?: RequestInit) => Promise<Response | undefined>,
): Fetcher {
  return async (input, init) => {
    const url = new URL(requestUrl(input));
    const overridden = await override(url, init);
    if (overridden) return overridden;
    if (url.pathname.endsWith("/users/@me")) return Response.json(bot());
    if (url.pathname.endsWith(`/guilds/${GUILD}`))
      return Response.json({ id: GUILD, name: "Fixture guild" });
    if (url.pathname.endsWith(`/channels/${CHANNEL}`)) return Response.json(channel());
    throw new Error(`Unexpected request: ${url}`);
  };
}

function bot(): Record<string, unknown> {
  return { id: "100000000000000099", username: "fixture-bot", bot: true };
}

function channel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: CHANNEL, guild_id: GUILD, name: "fixture-channel", type: 0, ...overrides };
}

function message(
  id: string,
  options: {
    type?: number;
    replyTo?: string;
    content?: string;
    attachments?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  return {
    id,
    channel_id: CHANNEL,
    guild_id: GUILD,
    type: options.type ?? 0,
    timestamp: new Date(Number(BigInt(id) % 1_000_000n)).toISOString(),
    edited_timestamp: null,
    author: { id: "100000000000000098", username: "fixture-user", bot: false },
    content: options.content ?? "Fixture evidence",
    attachments: options.attachments ?? [],
    embeds: [],
    components: [],
    sticker_items: [],
    ...(options.replyTo
      ? {
          message_reference: {
            type: 0,
            message_id: options.replyTo,
            channel_id: CHANNEL,
            guild_id: GUILD,
          },
        }
      : {}),
  };
}

function attachment(
  id: string,
  filename: string,
  contentType: string,
  size: number,
): Record<string, unknown> {
  return {
    id,
    filename,
    content_type: contentType,
    size,
    url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${id}/${filename}?ex=signed&hm=secret`,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "discord-context-test-"));
  temporary.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}
