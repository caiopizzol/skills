import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SlackLocator {
  workspaceHost: string;
  channelId: string;
  messageTs: string;
}

export interface RetrievedSlackFile {
  status: "retrieved";
  identity: string;
  originalName: string;
  localPath: string;
  declaredMime: string | null;
  detectedMime: string;
  bytes: number;
  sha256: string;
}

export interface UnreadSlackFile {
  status: "failed" | "unavailable" | "unsupported";
  identity: string;
  originalName: string | null;
  error: string;
}

export type SlackFileEntry = RetrievedSlackFile | UnreadSlackFile;

export interface AcquireSlackFilesOptions {
  token?: string;
  objective: string;
  rootTs: string;
  artifactsDirectory: string;
  fetcher?: Fetcher;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  limits?: { maxFileBytes: number; maxTotalBytes: number };
}

export interface SlackFileAcquisition {
  generatedAt: string;
  objective: string;
  workspaceHost: string;
  channelId: string;
  messageTs: string;
  rootTs: string;
  authorizedTeamId: string | null;
  authorizedUserId: string | null;
  requestedFileIds: string[];
  files: SlackFileEntry[];
  gaps: string[];
  manifestPath: string;
}

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

interface SlackMessage {
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

interface SlackApiEnvelope {
  ok: boolean;
  error?: string;
  url?: string;
  team_id?: string;
  user_id?: string;
  file?: SlackFile;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

export function parseSlackPermalink(input: string): SlackLocator {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Slack input must be one exact HTTPS message permalink");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.endsWith(".slack.com")
  ) {
    throw new Error("Slack input must be one exact HTTPS message permalink");
  }
  const match = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
  if (!match) throw new Error("Slack permalink must identify one message");
  return {
    workspaceHost: url.hostname.toLowerCase(),
    channelId: match[1]!,
    messageTs: `${match[2]}.${match[3]}`,
  };
}

export async function acquireSlackFiles(
  permalink: string,
  fileIds: readonly string[],
  options: AcquireSlackFilesOptions,
): Promise<SlackFileAcquisition> {
  const locator = parseSlackPermalink(permalink);
  if (!options.objective.trim()) throw new Error("A file-acquisition objective is required");
  if (!/^\d{10}\.\d{6}$/.test(options.rootTs))
    throw new Error("A canonical Slack root timestamp is required");
  const selected = [...new Set(fileIds.map((fileId) => fileId.trim()).filter(Boolean))];
  if (selected.length === 0) throw new Error("Select at least one Slack file identity");
  if (selected.some((fileId) => !/^F[A-Z0-9]+$/.test(fileId)))
    throw new Error("Slack file identities must start with F and contain only letters and digits");

  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const token = options.token;
  if (!token)
    return writeUnavailableAcquisition(
      locator,
      selected,
      options,
      generatedAt,
      "SLACK_BOT_TOKEN is unavailable in the runtime",
    );
  let identity: SlackApiEnvelope;
  try {
    identity = await slackApi(fetcher, token, "auth.test", {}, sleep);
    if (!identity.url || !identity.team_id || !identity.user_id)
      throw new Error("Slack auth.test returned an incomplete identity");
    const authorizedHost = new URL(identity.url).hostname.toLowerCase();
    if (authorizedHost !== locator.workspaceHost)
      throw new Error(
        `Slack credential belongs to ${authorizedHost}, not ${locator.workspaceHost}`,
      );
  } catch (error) {
    return writeUnavailableAcquisition(locator, selected, options, generatedAt, safeError(error));
  }

  const messages = await retrieveThread(fetcher, token, locator.channelId, options.rootTs, sleep);
  const exposingMessage = messages.find((message) => message.ts === locator.messageTs);
  if (!exposingMessage) throw new Error("Slack permalink message was not returned");
  const rootTs = exposingMessage.thread_ts ?? exposingMessage.ts;
  if (rootTs !== options.rootTs)
    throw new Error("Slack permalink message does not belong to the provided canonical thread");
  const threadFileIds = new Set(
    messages.flatMap((message) => (message.files ?? []).map((file) => file.id)),
  );
  const unrelated = selected.find((fileId) => !threadFileIds.has(fileId));
  if (unrelated)
    throw new Error(`Selected Slack file ${unrelated} is not present in the canonical thread`);

  const { runDirectory, filesDirectory, manifestPath } = await createRunDirectory(
    options.artifactsDirectory,
  );

  const limits = options.limits ?? {
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  };
  let totalBytes = 0;
  const entries: SlackFileEntry[] = [];
  for (const [index, fileId] of selected.entries()) {
    let originalName: string | null = null;
    try {
      const envelope = await slackApi(fetcher, token, "files.info", { file: fileId }, sleep);
      const file = envelope.file;
      if (!file || file.id !== fileId) throw new Error("Slack files.info returned the wrong file");
      originalName = safeFilename(file.name ?? file.id);
      if (!isSupportedFileMetadata(file)) {
        entries.push({
          status: "unsupported",
          identity: fileId,
          originalName,
          error: "Slack file type is unsupported for acquisition",
        });
        continue;
      }
      let source: URL;
      try {
        source = new URL(file.url_private_download ?? file.url_private ?? "");
      } catch {
        throw new Error("Slack file download URL is invalid");
      }
      if (
        source.protocol !== "https:" ||
        source.username ||
        source.password ||
        source.port ||
        source.hostname !== "files.slack.com"
      ) {
        throw new Error("Slack file download URL is outside files.slack.com");
      }
      if (file.size !== undefined && file.size > limits.maxFileBytes)
        throw new Error("Slack file exceeds the per-file byte limit");
      if (file.size !== undefined && totalBytes + file.size > limits.maxTotalBytes)
        throw new Error("Slack files exceed the total byte limit");
      const remainingTotal = limits.maxTotalBytes - totalBytes;
      if (remainingTotal <= 0) throw new Error("Slack files exceed the total byte limit");

      let response: Response;
      try {
        response = await fetcher(source, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new Error("Slack file download request failed");
      }
      if (response.status >= 300 && response.status < 400)
        throw new Error("Slack file download returned a redirect");
      if (!response.ok) throw new Error(`Slack file download returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes)
        throw new Error("Slack file exceeds the per-file byte limit");
      const bytes = await readBounded(
        response,
        Math.min(limits.maxFileBytes, remainingTotal),
        (consumed) => (totalBytes += consumed),
      );
      const detectedMime = detectMime(bytes);
      if (detectedMime === "application/pdf" || detectedMime === "application/zip") {
        entries.push({
          status: "unsupported",
          identity: fileId,
          originalName,
          error: `Detected unsupported Slack file type: ${detectedMime}`,
        });
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const localName = `${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 12)}-${originalName}`;
      const localPath = join(filesDirectory, localName);
      await writeFile(localPath, bytes, { flag: "wx" });
      entries.push({
        status: "retrieved",
        identity: fileId,
        originalName,
        localPath: relative(runDirectory, localPath),
        declaredMime: file.mimetype ?? null,
        detectedMime,
        bytes: bytes.byteLength,
        sha256,
      });
    } catch (error) {
      entries.push({
        status: "failed",
        identity: fileId,
        originalName,
        error: safeError(error),
      });
    }
  }

  const gaps = entries
    .filter((entry): entry is UnreadSlackFile => entry.status !== "retrieved")
    .map((entry) => `file:${entry.identity}: ${entry.error}`);
  const result: SlackFileAcquisition = {
    generatedAt,
    objective: options.objective.trim(),
    workspaceHost: locator.workspaceHost,
    channelId: locator.channelId,
    messageTs: locator.messageTs,
    rootTs,
    authorizedTeamId: identity.team_id,
    authorizedUserId: identity.user_id,
    requestedFileIds: selected,
    files: entries,
    gaps,
    manifestPath,
  };
  await writeAcquisitionManifest(result);
  return result;
}

async function writeUnavailableAcquisition(
  locator: SlackLocator,
  selected: string[],
  options: AcquireSlackFilesOptions,
  generatedAt: string,
  error: string,
): Promise<SlackFileAcquisition> {
  const { manifestPath } = await createRunDirectory(options.artifactsDirectory);
  const files: UnreadSlackFile[] = selected.map((identity) => ({
    status: "unavailable",
    identity,
    originalName: null,
    error,
  }));
  const result: SlackFileAcquisition = {
    generatedAt,
    objective: options.objective.trim(),
    workspaceHost: locator.workspaceHost,
    channelId: locator.channelId,
    messageTs: locator.messageTs,
    rootTs: options.rootTs,
    authorizedTeamId: null,
    authorizedUserId: null,
    requestedFileIds: selected,
    files,
    gaps: files.map((file) => `file:${file.identity}: ${file.error}`),
    manifestPath,
  };
  await writeAcquisitionManifest(result);
  return result;
}

async function createRunDirectory(artifactsDirectory: string): Promise<{
  runDirectory: string;
  filesDirectory: string;
  manifestPath: string;
}> {
  await mkdir(artifactsDirectory, { recursive: true });
  if ((await lstat(artifactsDirectory)).isSymbolicLink())
    throw new Error("Artifacts directory must not be a symbolic link");
  const artifactsRoot = await realpath(artifactsDirectory);
  const runDirectory = await mkdtemp(join(artifactsRoot, "slack-files-"));
  const filesDirectory = join(runDirectory, "files");
  await mkdir(filesDirectory);
  return {
    runDirectory,
    filesDirectory,
    manifestPath: join(runDirectory, "slack-files.json"),
  };
}

async function writeAcquisitionManifest(result: SlackFileAcquisition): Promise<void> {
  await writeFile(
    result.manifestPath,
    `${JSON.stringify({ ...result, manifestPath: basename(result.manifestPath) }, null, 2)}\n`,
    { flag: "wx" },
  );
}

async function retrieveThread(
  fetcher: Fetcher,
  token: string,
  channel: string,
  ts: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<SlackMessage[]> {
  const messages = new Map<string, SlackMessage>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const envelope = await slackApi(
      fetcher,
      token,
      "conversations.replies",
      {
        channel,
        ts,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      },
      sleep,
    );
    for (const message of envelope.messages ?? []) {
      const existing = messages.get(message.ts);
      messages.set(message.ts, mergeMessage(existing, message));
    }
    cursor = envelope.response_metadata?.next_cursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Slack reply pagination repeated a cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...messages.values()].sort((left, right) => left.ts.localeCompare(right.ts));
}

async function slackApi(
  fetcher: Fetcher,
  token: string,
  method: "auth.test" | "conversations.replies" | "files.info",
  fields: Record<string, string>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<SlackApiEnvelope> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Slack ${method} request failed`);
    }
    if (response.status === 429) {
      await waitForRateLimit(method, response, attempt, sleep);
      continue;
    }
    let envelope: SlackApiEnvelope;
    try {
      envelope = (await response.json()) as SlackApiEnvelope;
    } catch {
      throw new Error(`Slack ${method} returned invalid JSON`);
    }
    if (envelope.error === "ratelimited") {
      await waitForRateLimit(method, response, attempt, sleep);
      continue;
    }
    if (!response.ok || !envelope.ok) {
      const code = envelope.error?.match(/^[a-z0-9_]+$/)?.[0] ?? `http_${response.status}`;
      throw new Error(`Slack ${method} failed: ${code}`);
    }
    return envelope;
  }
  throw new Error(`Slack ${method} remained rate limited`);
}

function mergeMessage(existing: SlackMessage | undefined, incoming: SlackMessage): SlackMessage {
  if (!existing) return incoming;
  const files = new Map<string, SlackFile>();
  for (const file of existing.files ?? []) files.set(file.id, file);
  for (const file of incoming.files ?? []) files.set(file.id, { ...files.get(file.id), ...file });
  return {
    ...existing,
    ...incoming,
    ...(files.size > 0 ? { files: [...files.values()] } : {}),
  };
}

async function waitForRateLimit(
  method: string,
  response: Response,
  attempt: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const retrySeconds = Number(response.headers.get("retry-after") ?? "60");
  if (attempt === 3 || !Number.isFinite(retrySeconds) || retrySeconds < 0 || retrySeconds > 60)
    throw new Error(`Slack ${method} remained rate limited`);
  await sleep(Math.max(1, retrySeconds) * 1_000);
}

export async function readBounded(
  response: Response,
  maximumBytes: number,
  account: (consumedBytes: number) => void = () => undefined,
): Promise<Uint8Array> {
  if (!response.body) throw new Error("Slack file download returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    account(part.value.byteLength);
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("Slack file exceeded the configured byte limit");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function detectMime(bytes: Uint8Array): string {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "application/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (
    ascii(bytes, 0, 3) === "ID3" ||
    (bytes.length >= 4 &&
      bytes[0] === 0xff &&
      (bytes[1] & 0xe0) === 0xe0 &&
      (bytes[1] & 0x18) !== 0x08 &&
      (bytes[1] & 0x06) === 0x02 &&
      (bytes[2] & 0xf0) !== 0xf0 &&
      (bytes[2] & 0x0c) !== 0x0c)
  )
    return "audio/mpeg";
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
  if (ascii(bytes, 0, 4) === "%PDF") return "application/pdf";
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  const sample = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 4096))
    .trimStart();
  if (sample.startsWith("<svg") || /<svg[\s>]/i.test(sample.slice(0, 512))) return "image/svg+xml";
  try {
    JSON.parse(sample);
    return "application/json";
  } catch {
    return isMostlyText(bytes) ? "text/plain" : "application/octet-stream";
  }
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.slice(offset, offset + length));
}

function isMostlyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
  }
  return controls / sample.length < 0.02;
}

function safeFilename(value: string): string {
  const sanitized = basename(value)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-120);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "slack-file";
}

function isSupportedFileMetadata(file: SlackFile): boolean {
  const mime = file.mimetype?.toLowerCase() ?? "";
  if (mime && mime !== "application/octet-stream" && mime !== "application/binary")
    return (
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      mime.startsWith("text/") ||
      ["application/json", "application/xml"].includes(mime)
    );
  return /\.(?:png|jpe?g|gif|webp|avif|heic|svg|mp4|mov|m4v|webm|txt|md|json|xml|csv|mp3|m4a|wav|ogg|flac)$/i.test(
    file.name ?? "",
  );
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bxox[a-z]-[a-z0-9-]+\b/gi, "[REDACTED_TOKEN]")
    .replace(
      /(token|secret|signature|password|credential|authorization)=([^\s&]+)/gi,
      "$1=[REDACTED]",
    );
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
