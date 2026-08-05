import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const API_ORIGIN = "https://discord.com/api/v10";
const DEFAULT_MAX_SCANNED_MESSAGES = 1_000;
const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DiscordLocator {
  guildId: string;
  channelId: string;
  messageId: string;
  permalink: string;
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  type: number;
  timestamp: string;
  editedTimestamp: string | null;
  author: { id: string; username: string | null; displayName: string | null; bot: boolean };
  content: string;
  replyToMessageId: string | null;
  attachments: DiscordAttachment[];
  embeds: Array<{
    type: string | null;
    title: string | null;
    description: string | null;
    url: string | null;
  }>;
}

export interface DiscordAttachment {
  id: string;
  messageId: string;
  originalName: string;
  declaredMime: string | null;
  declaredBytes: number;
}

export interface RetrievedDiscordFile extends DiscordAttachment {
  status: "retrieved";
  localPath: string;
  detectedMime: string;
  bytes: number;
  sha256: string;
}

export interface UnreadDiscordFile extends DiscordAttachment {
  status: "failed" | "unsupported";
  error: string;
}

export type DiscordFileEntry = RetrievedDiscordFile | UnreadDiscordFile;

export interface DiscordCollection {
  schemaVersion: "1.0";
  generatedAt: string;
  requested: DiscordLocator;
  authorizedBot: { id: string; username: string | null };
  guild: { id: string; name: string };
  channel: { id: string; name: string | null; type: number };
  conversation: {
    kind: "message" | "thread";
    rootMessageId: string;
    requestedMessageId: string;
    scannedMessages: number;
    paginationComplete: boolean;
  };
  messages: DiscordMessage[];
  externalReferences: string[];
  files: DiscordFileEntry[];
  gaps: string[];
  runDirectory: string;
  contextPath: string;
}

export interface DiscordCollectOptions {
  token: string;
  artifactsDirectory: string;
  fetcher?: Fetcher;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  limits?: {
    maxScannedMessages: number;
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
  };
}

interface RawAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

interface RawMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  timestamp: string;
  edited_timestamp?: string | null;
  author: { id: string; username?: string; global_name?: string | null; bot?: boolean };
  content?: string;
  message_reference?: {
    type?: number;
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  thread?: { id?: string; type?: number };
  attachments?: RawAttachment[];
  embeds?: Array<{ type?: string; title?: string; description?: string; url?: string }>;
  components?: unknown[];
  sticker_items?: unknown[];
  message_snapshots?: unknown[];
  poll?: unknown;
  unsupportedFields: string[];
}

interface PendingAttachment extends DiscordAttachment {
  sourceUrl: string;
}

export function parseDiscordPermalink(input: string): DiscordLocator {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Discord input must be one exact HTTPS guild message permalink");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "discord.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("Discord input must be one exact HTTPS guild message permalink");
  }
  const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/);
  if (!match) {
    if (url.pathname.startsWith("/channels/@me/"))
      throw new Error("Discord direct-message permalinks are unsupported for bot retrieval");
    throw new Error("Discord permalink must identify one guild message");
  }
  return {
    guildId: match[1]!,
    channelId: match[2]!,
    messageId: match[3]!,
    permalink: `https://discord.com/channels/${match[1]}/${match[2]}/${match[3]}`,
  };
}

export async function collectDiscordConversation(
  permalink: string,
  options: DiscordCollectOptions,
): Promise<DiscordCollection> {
  const requested = parseDiscordPermalink(permalink);
  if (!options.token.trim()) throw new Error("A Discord bot credential is required");
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const limits = options.limits ?? {
    maxScannedMessages: DEFAULT_MAX_SCANNED_MESSAGES,
    maxFiles: DEFAULT_MAX_FILES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  };
  validateLimits(limits);

  const bot = object(await discordApi(fetcher, options.token, "/users/@me", sleep), "Discord bot");
  if (bot.bot !== true) throw new Error("DISCORD_BOT_TOKEN did not authenticate a bot identity");
  const botId = string(bot.id, "Discord bot id");
  const guild = object(
    await discordApi(fetcher, options.token, `/guilds/${requested.guildId}`, sleep),
    "Discord guild",
  );
  if (string(guild.id, "Discord guild id") !== requested.guildId)
    throw new Error("Discord returned a different guild than the permalink");
  const channel = object(
    await discordApi(fetcher, options.token, `/channels/${requested.channelId}`, sleep),
    "Discord channel",
  );
  if (string(channel.id, "Discord channel id") !== requested.channelId)
    throw new Error("Discord returned a different channel than the permalink");
  if (optionalString(channel.guild_id) !== requested.guildId)
    throw new Error("Discord channel does not belong to the permalink guild");
  const channelType = integer(channel.type, "Discord channel type");

  const requestedMessage = rawMessage(
    await discordApi(
      fetcher,
      options.token,
      `/channels/${requested.channelId}/messages/${requested.messageId}`,
      sleep,
    ),
  );
  assertMessageLocation(requestedMessage, requested.channelId, requested.guildId);

  const gaps: string[] = [];
  const rawMessages = new Map<string, RawMessage>();
  rawMessages.set(requestedMessage.id, requestedMessage);
  let rootMessageId = requestedMessage.id;
  let scannedMessages = 1;
  let paginationComplete = true;

  if (THREAD_CHANNEL_TYPES.has(channelType)) {
    const pageResult = await paginateChannelBackward(
      requested.channelId,
      options.token,
      fetcher,
      sleep,
      limits.maxScannedMessages,
    );
    scannedMessages = pageResult.scanned;
    paginationComplete =
      pageResult.complete &&
      pageResult.messages.some((message) => message.id === requested.messageId);
    for (const message of pageResult.messages) rawMessages.set(message.id, message);
    const oldest = [...rawMessages.values()].sort(compareRawMessages)[0];
    if (oldest) rootMessageId = oldest.id;
  } else {
    const ancestry = await retrieveReplyAncestry(
      requestedMessage,
      requested.guildId,
      options.token,
      fetcher,
      sleep,
      limits.maxScannedMessages,
    );
    for (const message of ancestry.messages) rawMessages.set(message.id, message);
    rootMessageId = ancestry.rootMessageId;
    scannedMessages += ancestry.messages.length;
    if (!ancestry.complete) {
      paginationComplete = false;
      gaps.push("Reply ancestry could not be retrieved completely");
    }

    const remaining = Math.max(0, limits.maxScannedMessages - scannedMessages);
    const descendants = await scanReplyDescendants(
      requested.channelId,
      requested.guildId,
      rootMessageId,
      options.token,
      fetcher,
      sleep,
      remaining,
    );
    scannedMessages += descendants.scanned;
    paginationComplete &&= descendants.complete;
    for (const message of descendants.messages) rawMessages.set(message.id, message);

    const threadId = optionalString(requestedMessage.thread?.id);
    if (threadId) {
      const threadRemaining = Math.max(0, limits.maxScannedMessages - scannedMessages);
      const thread = await paginateChannelBackward(
        threadId,
        options.token,
        fetcher,
        sleep,
        threadRemaining,
      );
      scannedMessages += thread.scanned;
      paginationComplete &&= thread.complete && thread.messages.length > 0;
      for (const message of thread.messages) rawMessages.set(message.id, message);
    }
  }
  if (!paginationComplete)
    gaps.push("Conversation pagination stopped before completeness was established");

  const messages = [...rawMessages.values()].sort(compareRawMessages);
  for (const message of messages) {
    if (!hasMessageContentEvidence(message))
      gaps.push(`Message ${message.id} may be missing Message Content access`);
    if (message.unsupportedFields.length > 0)
      gaps.push(
        `Message ${message.id} contains unsupported Discord fields: ${message.unsupportedFields.join(", ")}`,
      );
  }

  const normalized = messages.map(normalizeMessage);
  const externalReferences = discoverReferences(messages);
  const pendingAttachments = messages.flatMap(pendingMessageAttachments);
  const { runDirectory, filesDirectory, contextPath } = await createRunDirectory(
    options.artifactsDirectory,
  );
  const files = await acquireAttachments(
    pendingAttachments,
    filesDirectory,
    runDirectory,
    fetcher,
    limits,
  );
  for (const file of files) {
    if (file.status !== "retrieved") gaps.push(`Attachment ${file.id}: ${file.error}`);
  }
  if (pendingAttachments.length > limits.maxFiles)
    gaps.push(
      `${pendingAttachments.length - limits.maxFiles} attachments exceeded the acquisition count limit`,
    );

  const result: DiscordCollection = {
    schemaVersion: "1.0",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    requested,
    authorizedBot: { id: botId, username: optionalString(bot.username) ?? null },
    guild: { id: requested.guildId, name: string(guild.name, "Discord guild name") },
    channel: {
      id: requested.channelId,
      name: optionalString(channel.name) ?? null,
      type: channelType,
    },
    conversation: {
      kind: THREAD_CHANNEL_TYPES.has(channelType) ? "thread" : "message",
      rootMessageId,
      requestedMessageId: requested.messageId,
      scannedMessages,
      paginationComplete,
    },
    messages: normalized,
    externalReferences,
    files,
    gaps: [...new Set(gaps)],
    runDirectory,
    contextPath,
  };
  await writeFile(
    contextPath,
    `${JSON.stringify({ ...result, runDirectory: ".", contextPath: basename(contextPath) }, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}

async function retrieveReplyAncestry(
  requested: RawMessage,
  guildId: string,
  token: string,
  fetcher: Fetcher,
  sleep: (milliseconds: number) => Promise<void>,
  limit: number,
): Promise<{ messages: RawMessage[]; rootMessageId: string; complete: boolean }> {
  const messages: RawMessage[] = [];
  const visited = new Set([requested.id]);
  let current = requested;
  while (isReply(current)) {
    const reference = current.message_reference;
    const parentId = optionalString(reference?.message_id);
    const parentChannelId = optionalString(reference?.channel_id);
    if (!parentId || !parentChannelId)
      return { messages, rootMessageId: current.id, complete: false };
    if (visited.has(parentId)) throw new Error("Discord reply ancestry contains a cycle");
    if (messages.length + 1 >= limit)
      return { messages, rootMessageId: current.id, complete: false };
    visited.add(parentId);
    try {
      current = rawMessage(
        await discordApi(
          fetcher,
          token,
          `/channels/${parentChannelId}/messages/${parentId}`,
          sleep,
        ),
      );
    } catch (error) {
      if (error instanceof DiscordHttpError && error.status === 404)
        return { messages, rootMessageId: current.id, complete: false };
      throw error;
    }
    assertMessageLocation(current, parentChannelId, guildId);
    messages.push(current);
  }
  return { messages, rootMessageId: current.id, complete: true };
}

async function scanReplyDescendants(
  channelId: string,
  guildId: string,
  rootMessageId: string,
  token: string,
  fetcher: Fetcher,
  sleep: (milliseconds: number) => Promise<void>,
  limit: number,
): Promise<{ messages: RawMessage[]; scanned: number; complete: boolean }> {
  if (limit <= 0) return { messages: [], scanned: 0, complete: false };
  const candidates = await paginateChannelBackward(
    channelId,
    token,
    fetcher,
    sleep,
    limit,
    rootMessageId,
  );
  const descendants = new Set([rootMessageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of candidates.messages) {
      const parentId = isReply(message)
        ? optionalString(message.message_reference?.message_id)
        : undefined;
      if (parentId && descendants.has(parentId) && !descendants.has(message.id)) {
        descendants.add(message.id);
        changed = true;
      }
    }
  }
  return {
    messages: candidates.messages.filter((message) => descendants.has(message.id)),
    scanned: candidates.scanned,
    complete: candidates.complete,
  };
}

async function paginateChannelBackward(
  channelId: string,
  token: string,
  fetcher: Fetcher,
  sleep: (milliseconds: number) => Promise<void>,
  limit: number,
  stopAtOrBefore?: string,
): Promise<{ messages: RawMessage[]; scanned: number; complete: boolean }> {
  const messages: RawMessage[] = [];
  const cursors = new Set<string>();
  let before: string | undefined;
  while (messages.length < limit) {
    const pageLimit = Math.min(100, limit - messages.length);
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (before) query.set("before", before);
    const pageValue = await discordApi(
      fetcher,
      token,
      `/channels/${channelId}/messages?${query}`,
      sleep,
    );
    if (!Array.isArray(pageValue)) throw new Error("Discord message history was not an array");
    const page = pageValue.map(rawMessage);
    for (const message of page) {
      if (message.channel_id !== channelId)
        throw new Error("Discord history returned a message from another channel");
      if (!stopAtOrBefore || compareSnowflakes(message.id, stopAtOrBefore) > 0)
        messages.push(message);
    }
    if (
      stopAtOrBefore &&
      page.some((message) => compareSnowflakes(message.id, stopAtOrBefore) <= 0)
    )
      return { messages, scanned: messages.length, complete: true };
    if (page.length < pageLimit)
      return { messages, scanned: messages.length, complete: stopAtOrBefore === undefined };
    const oldest = page.at(-1);
    if (!oldest) return { messages, scanned: messages.length, complete: true };
    if (cursors.has(oldest.id)) throw new Error("Discord repeated a pagination cursor");
    cursors.add(oldest.id);
    before = oldest.id;
  }
  return { messages, scanned: messages.length, complete: false };
}

async function acquireAttachments(
  attachments: PendingAttachment[],
  filesDirectory: string,
  runDirectory: string,
  fetcher: Fetcher,
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
): Promise<DiscordFileEntry[]> {
  const files: DiscordFileEntry[] = [];
  let totalBytes = 0;
  for (const [index, attachment] of attachments.slice(0, limits.maxFiles).entries()) {
    const base = withoutSourceUrl(attachment);
    if (!isSupportedMetadata(attachment)) {
      files.push({ ...base, status: "unsupported", error: "Attachment type is unsupported" });
      continue;
    }
    if (attachment.declaredBytes > limits.maxFileBytes) {
      files.push({
        ...base,
        status: "failed",
        error: "Attachment exceeds the per-file byte limit",
      });
      continue;
    }
    if (totalBytes + attachment.declaredBytes > limits.maxTotalBytes) {
      files.push({ ...base, status: "failed", error: "Attachments exceed the total byte limit" });
      continue;
    }
    try {
      const source = validateCdnUrl(attachment.sourceUrl);
      const response = await fetcher(source, {
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status >= 300 && response.status < 400)
        throw new Error("Attachment download returned a redirect");
      if (!response.ok) throw new Error(`Attachment download returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes)
        throw new Error("Attachment exceeds the per-file byte limit");
      const bytes = await readBounded(
        response,
        Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes),
        (consumed) => {
          totalBytes += consumed;
        },
      );
      const detectedMime = detectMime(bytes, attachment.declaredMime, attachment.originalName);
      if (!isSupportedDetectedMime(detectedMime)) {
        files.push({
          ...base,
          status: "unsupported",
          error: `Detected unsupported attachment type: ${detectedMime}`,
        });
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const localName = `${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 12)}-${safeFilename(attachment.originalName)}`;
      const localPath = join(filesDirectory, localName);
      await writeFile(localPath, bytes, { flag: "wx" });
      files.push({
        ...base,
        status: "retrieved",
        localPath: relative(runDirectory, localPath),
        detectedMime,
        bytes: bytes.byteLength,
        sha256,
      });
    } catch (error) {
      files.push({ ...base, status: "failed", error: safeError(error) });
    }
  }
  return files;
}

async function discordApi(
  fetcher: Fetcher,
  token: string,
  path: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetcher(`${API_ORIGIN}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < 3) {
      const body = await response.json().catch(() => null);
      const retryAfter =
        isRecord(body) && typeof body.retry_after === "number" ? body.retry_after : 1;
      await sleep(Math.max(0, Math.min(retryAfter * 1_000, 30_000)));
      continue;
    }
    if (!response.ok) throw new DiscordHttpError(response.status);
    return response.json();
  }
  throw new Error("Discord rate limit retry bound was exhausted");
}

class DiscordHttpError extends Error {
  constructor(readonly status: number) {
    super(`Discord API returned HTTP ${status}`);
  }
}

function normalizeMessage(message: RawMessage): DiscordMessage {
  return {
    id: message.id,
    channelId: message.channel_id,
    type: message.type,
    timestamp: message.timestamp,
    editedTimestamp: message.edited_timestamp ?? null,
    author: {
      id: message.author.id,
      username: message.author.username ?? null,
      displayName: message.author.global_name ?? null,
      bot: message.author.bot ?? false,
    },
    content: redactText(message.content ?? ""),
    replyToMessageId: isReply(message)
      ? (optionalString(message.message_reference?.message_id) ?? null)
      : null,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      messageId: message.id,
      originalName: attachment.filename,
      declaredMime: attachment.content_type ?? null,
      declaredBytes: attachment.size,
    })),
    embeds: (message.embeds ?? []).map((embed) => ({
      type: embed.type ?? null,
      title: embed.title ? redactText(embed.title) : null,
      description: embed.description ? redactText(embed.description) : null,
      url: embed.url ? sanitizeReference(embed.url) : null,
    })),
  };
}

function pendingMessageAttachments(message: RawMessage): PendingAttachment[] {
  return (message.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    messageId: message.id,
    originalName: attachment.filename,
    declaredMime: attachment.content_type ?? null,
    declaredBytes: attachment.size,
    sourceUrl: attachment.url,
  }));
}

function discoverReferences(messages: RawMessage[]): string[] {
  const references = new Set<string>();
  for (const message of messages) {
    for (const text of [
      message.content ?? "",
      ...(message.embeds ?? []).flatMap((embed) => [
        embed.url ?? "",
        embed.title ?? "",
        embed.description ?? "",
      ]),
    ]) {
      for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]{}"']+/g)) {
        const sanitized = sanitizeReference(match[0].replace(/[.,;:!?]+$/, ""));
        if (sanitized && !isDiscordCdnReference(sanitized)) references.add(sanitized);
      }
    }
  }
  return [...references].sort();
}

function sanitizeReference(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      const value = url.searchParams.get(key) ?? "";
      if (isSensitiveQuery(key, value)) url.searchParams.set(key, "[REDACTED]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function redactText(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"')\]]+/g, (match) => {
    const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
    const clean = trailing ? match.slice(0, -trailing.length) : match;
    return `${sanitizeReference(clean) ?? "URL [REDACTED]"}${trailing}`;
  });
}

function isSensitiveQuery(key: string, value: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return (
    /(?:^|[-_])(signature|sig|token|secret|key|credential|authorization|auth|jwt|password|passwd)(?:$|[-_])/.test(
      normalized,
    ) ||
    ["expires", "ex", "hm"].includes(normalized) ||
    normalized.startsWith("x-amz-") ||
    normalized.startsWith("x-goog-") ||
    value.length > 64 ||
    value.split(".").length === 3
  );
}

function isDiscordCdnReference(input: string): boolean {
  try {
    return DISCORD_CDN_HOSTS.has(new URL(input).hostname);
  } catch {
    return false;
  }
}

function validateCdnUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !DISCORD_CDN_HOSTS.has(url.hostname)
  ) {
    throw new Error("Attachment URL is outside the Discord CDN");
  }
  return url;
}

function hasMessageContentEvidence(message: RawMessage): boolean {
  if (message.type !== 0 && message.type !== 19) return true;
  return Boolean(
    message.content ||
    message.attachments?.length ||
    message.embeds?.length ||
    message.components?.length ||
    message.sticker_items?.length ||
    message.message_snapshots?.length ||
    message.poll,
  );
}

function isReply(message: RawMessage): boolean {
  return message.type === 19 && (message.message_reference?.type ?? 0) === 0;
}

function assertMessageLocation(message: RawMessage, channelId: string, guildId: string): void {
  if (message.channel_id !== channelId)
    throw new Error("Discord returned a message from another channel");
  if (message.guild_id && message.guild_id !== guildId)
    throw new Error("Discord returned a message from another guild");
}

function compareRawMessages(left: RawMessage, right: RawMessage): number {
  return compareSnowflakes(left.id, right.id);
}

function compareSnowflakes(left: string, right: string): number {
  const difference = BigInt(left) - BigInt(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function isSupportedMetadata(attachment: PendingAttachment): boolean {
  const mime = attachment.declaredMime?.split(";", 1)[0]?.toLowerCase();
  if (mime?.startsWith("image/") || mime?.startsWith("video/") || mime?.startsWith("audio/"))
    return true;
  if (mime?.startsWith("text/")) return true;
  if (["application/json", "application/xml"].includes(mime ?? "")) return true;
  return /\.(?:png|jpe?g|gif|webp|avif|heic|svg|txt|md|json|xml|csv|mp4|m4[abpv]|webm|mov|mp3|wav|ogg|flac)$/i.test(
    attachment.originalName,
  );
}

function isSupportedDetectedMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  );
}

export function detectMime(bytes: Uint8Array, declaredMime: string | null, name: string): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (
    startsWith(bytes, [0x49, 0x44, 0x33]) ||
    (bytes.length >= 4 &&
      bytes[0] === 0xff &&
      ((bytes[1] ?? 0) & 0xe0) === 0xe0 &&
      ((bytes[1] ?? 0) & 0x18) !== 0x08 &&
      ((bytes[1] ?? 0) & 0x06) === 0x02 &&
      ((bytes[2] ?? 0) & 0xf0) !== 0xf0 &&
      ((bytes[2] ?? 0) & 0x0c) !== 0x0c)
  )
    return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  const isoBoxSize =
    bytes.length >= 16
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
      : 0;
  if (isoBoxSize >= 16 && isoBoxSize <= bytes.length && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, Math.min(isoBoxSize - 8, 32));
    if (brand.includes("avif") || brand.includes("avis")) return "image/avif";
    if (brand.includes("heic") || brand.includes("heix") || brand.includes("mif1"))
      return "image/heic";
    if (brand.includes("M4A ") || brand.includes("M4B ") || brand.includes("M4P "))
      return "audio/mp4";
    if (brand.includes("qt  ")) return "video/quicktime";
    return "video/mp4";
  }
  const text = decodeUtf8(bytes);
  if (text !== null && !text.includes("\0")) {
    const trimmed = text.trimStart();
    const declared = declaredMime?.split(";", 1)[0]?.toLowerCase();
    if (trimmed.startsWith("<svg") || /<svg[\s>]/i.test(trimmed.slice(0, 512)))
      return "image/svg+xml";
    if (declared === "application/json" || /\.json$/i.test(name)) {
      try {
        JSON.parse(text);
        return "application/json";
      } catch {
        return "text/plain";
      }
    }
    if (declared === "application/xml" || /\.xml$/i.test(name) || trimmed.startsWith("<?xml"))
      return "application/xml";
    if (declared?.startsWith("text/")) return declared;
    return "text/plain";
  }
  return "application/octet-stream";
}

export async function readBounded(
  response: Response,
  limit: number,
  account: (bytes: number) => void = () => {},
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    account(bytes.byteLength);
    if (bytes.byteLength > limit) throw new Error("Attachment exceeded its byte limit");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    account(value.byteLength);
    if (total > limit) {
      await reader.cancel();
      throw new Error("Attachment exceeded its byte limit while streaming");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function createRunDirectory(artifactsDirectory: string): Promise<{
  runDirectory: string;
  filesDirectory: string;
  contextPath: string;
}> {
  await mkdir(artifactsDirectory, { recursive: true });
  if ((await lstat(artifactsDirectory)).isSymbolicLink())
    throw new Error("Artifacts directory must not be a symbolic link");
  const root = await realpath(artifactsDirectory);
  const runDirectory = await mkdtemp(join(root, "discord-context-"));
  const filesDirectory = join(runDirectory, "files");
  await mkdir(filesDirectory);
  return {
    runDirectory,
    filesDirectory,
    contextPath: join(runDirectory, "discord-context.json"),
  };
}

function rawMessage(value: unknown): RawMessage {
  const message = object(value, "Discord message");
  const author = object(message.author, "Discord message author");
  const attachments = optionalArray(message.attachments).map((value) => {
    const attachment = object(value, "Discord attachment");
    return {
      id: string(attachment.id, "Discord attachment id"),
      filename: string(attachment.filename, "Discord attachment filename"),
      ...(optionalString(attachment.content_type)
        ? { content_type: optionalString(attachment.content_type) }
        : {}),
      size: integer(attachment.size, "Discord attachment size"),
      url: string(attachment.url, "Discord attachment URL"),
    };
  });
  const unsupportedFields = new Set<string>();
  const embeds = optionalArray(message.embeds).map((value) => {
    const embed = object(value, "Discord embed");
    for (const [key, child] of Object.entries(embed)) {
      if (!["type", "title", "description", "url"].includes(key) && child !== null)
        unsupportedFields.add(`embed.${key}`);
    }
    return {
      ...(optionalString(embed.type) ? { type: optionalString(embed.type) } : {}),
      ...(optionalString(embed.title) ? { title: optionalString(embed.title) } : {}),
      ...(optionalString(embed.description)
        ? { description: optionalString(embed.description) }
        : {}),
      ...(optionalString(embed.url) ? { url: optionalString(embed.url) } : {}),
    };
  });
  const reference = isRecord(message.message_reference) ? message.message_reference : undefined;
  const thread = isRecord(message.thread) ? message.thread : undefined;
  if (optionalArray(message.components).length > 0) unsupportedFields.add("components");
  if (optionalArray(message.sticker_items).length > 0) unsupportedFields.add("stickers");
  if (optionalArray(message.message_snapshots).length > 0)
    unsupportedFields.add("forwarded snapshots");
  if (message.poll !== undefined) unsupportedFields.add("poll");
  return {
    id: string(message.id, "Discord message id"),
    channel_id: string(message.channel_id, "Discord message channel id"),
    ...(optionalString(message.guild_id) ? { guild_id: optionalString(message.guild_id) } : {}),
    type: integer(message.type, "Discord message type"),
    timestamp: string(message.timestamp, "Discord message timestamp"),
    ...(message.edited_timestamp === null
      ? { edited_timestamp: null }
      : optionalString(message.edited_timestamp)
        ? { edited_timestamp: optionalString(message.edited_timestamp) }
        : {}),
    author: {
      id: string(author.id, "Discord author id"),
      ...(optionalString(author.username) ? { username: optionalString(author.username) } : {}),
      ...(author.global_name === null
        ? { global_name: null }
        : optionalString(author.global_name)
          ? { global_name: optionalString(author.global_name) }
          : {}),
      ...(typeof author.bot === "boolean" ? { bot: author.bot } : {}),
    },
    ...(typeof message.content === "string" ? { content: message.content } : {}),
    ...(reference
      ? {
          message_reference: {
            ...(typeof reference.type === "number" ? { type: reference.type } : {}),
            ...(optionalString(reference.message_id)
              ? { message_id: optionalString(reference.message_id) }
              : {}),
            ...(optionalString(reference.channel_id)
              ? { channel_id: optionalString(reference.channel_id) }
              : {}),
            ...(optionalString(reference.guild_id)
              ? { guild_id: optionalString(reference.guild_id) }
              : {}),
          },
        }
      : {}),
    ...(thread
      ? {
          thread: {
            ...(optionalString(thread.id) ? { id: optionalString(thread.id) } : {}),
            ...(typeof thread.type === "number" ? { type: thread.type } : {}),
          },
        }
      : {}),
    attachments,
    embeds,
    components: optionalArray(message.components),
    sticker_items: optionalArray(message.sticker_items),
    message_snapshots: optionalArray(message.message_snapshots),
    ...(message.poll !== undefined ? { poll: message.poll } : {}),
    unsupportedFields: [...unsupportedFields].sort(),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was missing`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${label} was invalid`);
  return value;
}

function optionalArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLimits(limits: {
  maxScannedMessages: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
  }
}

function withoutSourceUrl(attachment: PendingAttachment): DiscordAttachment {
  const { sourceUrl: _, ...entry } = attachment;
  return entry;
}

function safeFilename(value: string): string {
  const name = basename(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/, "");
  return name.slice(0, 120) || "attachment";
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown attachment failure";
  return error.message
    .replace(/https?:\/\/[^\s]+/g, (value) => sanitizeReference(value) ?? "[redacted URL]")
    .replace(/\b(Bot|Bearer)\s+\S+/gi, "$1 [REDACTED]");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
