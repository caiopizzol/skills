import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const DEFAULT_API_URL = "https://api.usepylon.com";
const MESSAGE_PAGE_SIZE = 1_000;
const MAX_FILES = 25;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const ASSET_HOST = "assets.usepylon.com";
const REQUIRED_ASSET_QUERY = ["Expires", "Key-Pair-Id", "Signature"] as const;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PylonLocator {
  readonly kind: "id" | "number";
  readonly value: string;
}

interface SourceLocation {
  readonly container: "issue" | "message";
  readonly id: string;
}

interface PendingFile {
  readonly identity: string;
  readonly locations: SourceLocation[];
  readonly url: string;
}

export interface RetrievedFile {
  readonly status: "retrieved";
  readonly identity: string;
  readonly locations: SourceLocation[];
  readonly originalName: string;
  readonly localPath: string;
  readonly declaredMime: string | null;
  readonly detectedMime: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FailedFile {
  readonly status: "failed";
  readonly identity: string;
  readonly locations: SourceLocation[];
  readonly error: string;
}

export type PylonFile = RetrievedFile | FailedFile;

export interface PylonCollection {
  readonly runDirectory: string;
  readonly contextPath: string;
  readonly manifestPath: string;
  readonly issueId: string;
  readonly issueNumber: number;
  readonly files: PylonFile[];
  readonly gaps: string[];
}

interface CollectOptions {
  readonly apiUrl: string;
  readonly artifactsDirectory: string;
  readonly token: string;
  readonly fetcher?: Fetcher;
  readonly now?: () => Date;
}

interface MessagePage {
  readonly messages: Record<string, unknown>[];
  readonly cursor: string | null;
  readonly hasNextPage: boolean;
}

export function parsePylonLocator(input: string): PylonLocator {
  const value = input.trim();
  if (/^[1-9]\d*$/u.test(value)) return { kind: "number", value };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    return { kind: "id", value: value.toLowerCase() };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Require one exact Pylon issue ID, number, or URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "app.usepylon.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/issues" && url.pathname !== "/issues/") ||
    [...url.searchParams.keys()].length !== 1
  ) {
    throw new Error("Require one exact Pylon issue ID, number, or URL");
  }
  const number = url.searchParams.get("issueNumber");
  if (number === null || !/^[1-9]\d*$/u.test(number)) {
    throw new Error("Pylon issue URL must contain one issueNumber");
  }
  return { kind: "number", value: number };
}

export function resolvePylonApiUrl(input: string | undefined): string {
  const value = input?.trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PYLON_API_URL must be a Pylon API origin");
  }
  const official =
    url.protocol === "https:" &&
    (url.hostname === "api.usepylon.com" || url.hostname === "api.eu.usepylon.com") &&
    url.port === "";
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (
    (!official && !loopback) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("PYLON_API_URL must be a Pylon API origin");
  }
  return url.href.replace(/\/$/u, "");
}

export function parsePylonAssetUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Pylon attachment URL is invalid");
  }
  const keys = [...url.searchParams.keys()].sort();
  if (
    url.protocol !== "https:" ||
    url.hostname !== ASSET_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !/^\/[^/]+$/u.test(url.pathname) ||
    keys.length !== REQUIRED_ASSET_QUERY.length ||
    !REQUIRED_ASSET_QUERY.every(
      (key) =>
        url.searchParams.getAll(key).length === 1 && url.searchParams.get(key)?.trim() !== "",
    ) ||
    keys.some(
      (key) => !REQUIRED_ASSET_QUERY.includes(key as (typeof REQUIRED_ASSET_QUERY)[number]),
    ) ||
    !/^\d+$/u.test(url.searchParams.get("Expires") ?? "")
  ) {
    throw new Error("Pylon attachment URL is invalid");
  }
  return url;
}

export async function collectPylonIssue(
  locatorInput: string,
  options: CollectOptions,
): Promise<PylonCollection> {
  const locator = parsePylonLocator(locatorInput);
  const apiUrl = resolvePylonApiUrl(options.apiUrl);
  const token = options.token.trim();
  if (!token) throw new Error("A Pylon API token is required");
  const fetcher = options.fetcher ?? fetch;
  const request = async (path: string, search?: URLSearchParams): Promise<unknown> => {
    const url = new URL(path, `${apiUrl}/`);
    if (search !== undefined) url.search = search.toString();
    const response = await fetcher(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Pylon API returned HTTP ${response.status}`);
    return response.json();
  };

  const access = object(object(await request("me"), "Pylon /me response").data, "Pylon /me data");
  const issuePath = `issues/${encodeURIComponent(locator.value)}`;
  const issue = object(
    object(await request(issuePath), "Pylon issue response").data,
    "Pylon issue",
  );
  const issueId = string(issue.id, "Pylon issue ID");
  const issueNumber = integer(issue.number, "Pylon issue number");
  if (
    (locator.kind === "id" && issueId.toLowerCase() !== locator.value) ||
    (locator.kind === "number" && String(issueNumber) !== locator.value)
  ) {
    throw new Error("Pylon returned a different issue than requested");
  }

  const threadsValue = object(await request(`${issuePath}/threads`), "Pylon threads response").data;
  const threads =
    threadsValue === null
      ? []
      : array(threadsValue, "Pylon threads").map((entry) => object(entry, "Pylon thread"));
  const messages: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let messagePages = 0;
  do {
    const search = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
    if (cursor !== null) search.set("cursor", cursor);
    const page = parseMessagePage(await request(`${issuePath}/messages`, search));
    messages.push(...page.messages);
    messagePages += 1;
    if (page.hasNextPage && page.cursor === null) {
      throw new Error("Pylon messages returned another page without a cursor");
    }
    if (page.cursor !== null && seenCursors.has(page.cursor)) {
      throw new Error("Pylon messages repeated a pagination cursor");
    }
    if (page.cursor !== null) seenCursors.add(page.cursor);
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor !== null);

  const pending = discoverFiles(issueId, issue, messages);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  await mkdir(options.artifactsDirectory, { recursive: true });
  const runDirectory = await mkdtemp(join(options.artifactsDirectory, `pylon-${issueNumber}-`));
  const filesDirectory = join(runDirectory, "files");
  await mkdir(filesDirectory);
  const files = await downloadFiles(pending, filesDirectory, runDirectory, fetcher);
  const threadIds = new Set(threads.map((thread) => string(thread.id, "Pylon thread ID")));
  const unknownThreadIds = new Set(
    messages
      .map((message) => optionalString(message.thread_id))
      .filter((threadId): threadId is string => threadId !== undefined && !threadIds.has(threadId)),
  );
  const refreshedIssue = object(
    object(await request(issuePath), "Pylon refreshed issue response").data,
    "Pylon refreshed issue",
  );
  const beforeUpdatedAt = optionalString(issue.updated_at) ?? null;
  const afterUpdatedAt = optionalString(refreshedIssue.updated_at) ?? null;
  const stable = beforeUpdatedAt === afterUpdatedAt;
  const gaps = [
    ...files
      .filter((file): file is FailedFile => file.status === "failed")
      .map((file) => `file:${file.identity}: ${file.error}`),
    ...[...unknownThreadIds].map(
      (threadId) => `message thread ${threadId} was not returned by Pylon`,
    ),
    ...(stable ? [] : ["input-changed: the Pylon issue changed during collection"]),
  ];
  const fileIdentities = new Map(pending.map((file) => [assetIdentity(file.url), file.identity]));
  const context = sanitize({
    schemaVersion: 1,
    generatedAt,
    requested: locator,
    access: {
      organization: {
        id: string(access.id, "Pylon organization ID"),
        name: optionalString(access.name) ?? null,
      },
    },
    issue: replaceFileUrls(issue, fileIdentities),
    messages: messages.map((message) => replaceFileUrls(message, fileIdentities)),
    threads,
    completeness: { messagePages, messagesComplete: true },
    freshness: { beforeUpdatedAt, afterUpdatedAt, stable },
  });
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    issueId,
    issueNumber,
    externalReferences: discoverReferences(issue, messages),
    files,
    gaps,
  };
  const contextPath = join(runDirectory, "pylon-context.json");
  const manifestPath = join(runDirectory, "pylon-manifest.json");
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, { flag: "wx" });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { runDirectory, contextPath, manifestPath, issueId, issueNumber, files, gaps };
}

function parseMessagePage(value: unknown): MessagePage {
  const response = object(value, "Pylon messages response");
  const messages = array(response.data, "Pylon messages").map((entry) =>
    object(entry, "Pylon message"),
  );
  if (response.pagination === null || response.pagination === undefined) {
    return { messages, cursor: null, hasNextPage: false };
  }
  const pagination = object(response.pagination, "Pylon message pagination");
  return {
    messages,
    cursor: pagination.cursor === null ? null : (optionalString(pagination.cursor) ?? null),
    hasNextPage: boolean(pagination.has_next_page, "Pylon message pagination flag"),
  };
}

function discoverFiles(
  issueId: string,
  issue: Record<string, unknown>,
  messages: readonly Record<string, unknown>[],
): PendingFile[] {
  const found = new Map<string, PendingFile>();
  const add = (value: unknown, location: SourceLocation) => {
    for (const entry of optionalArray(value)) {
      const url = string(entry, "Pylon attachment URL");
      parsePylonAssetUrl(url);
      const key = assetIdentity(url);
      const existing = found.get(key);
      if (existing === undefined) {
        found.set(key, { identity: key, locations: [location], url });
      } else {
        existing.locations.push(location);
      }
    }
  };
  add(issue.attachment_urls, { container: "issue", id: issueId });
  for (const message of messages) {
    add(message.file_urls, {
      container: "message",
      id: string(message.id, "Pylon message ID"),
    });
  }
  return [...found.values()];
}

function replaceFileUrls(
  value: Record<string, unknown>,
  identities: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const output = { ...value };
  for (const field of ["attachment_urls", "file_urls"] as const) {
    if (output[field] === null || output[field] === undefined) continue;
    output[field] = optionalArray(output[field]).map(
      (entry) => identities.get(assetIdentity(string(entry, "Pylon attachment URL"))) ?? "unknown",
    );
  }
  return output;
}

async function downloadFiles(
  pending: readonly PendingFile[],
  filesDirectory: string,
  runDirectory: string,
  fetcher: Fetcher,
): Promise<PylonFile[]> {
  const files: PylonFile[] = [];
  let totalBytes = 0;
  for (const [index, file] of pending.entries()) {
    if (index >= MAX_FILES) {
      files.push({
        status: "failed",
        identity: file.identity,
        locations: file.locations,
        error: "attachment count exceeds 25 files",
      });
      continue;
    }
    try {
      const url = parsePylonAssetUrl(file.url);
      const response = await fetcher(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("attachment download returned a redirect");
      }
      if (!response.ok) throw new Error(`attachment download returned HTTP ${response.status}`);
      if (response.url && new URL(response.url).hostname !== ASSET_HOST) {
        throw new Error("attachment response escaped assets.usepylon.com");
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
        throw new Error("attachment exceeds 50 MiB");
      }
      const remaining = MAX_TOTAL_BYTES - totalBytes;
      if (remaining <= 0) throw new Error("attachments exceed 250 MiB total");
      const content = await readBounded(response, Math.min(MAX_FILE_BYTES, remaining));
      totalBytes += content.byteLength;
      if (content.byteLength === 0) throw new Error("attachment is empty");
      const sha256 = createHash("sha256").update(content).digest("hex");
      const originalName = fileName(response.headers.get("content-disposition"), index);
      const localName = `${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 12)}-${originalName}`;
      const localPath = join(filesDirectory, localName);
      await writeFile(localPath, content, { flag: "wx" });
      files.push({
        status: "retrieved",
        identity: file.identity,
        locations: file.locations,
        originalName,
        localPath: relative(runDirectory, localPath),
        declaredMime: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || null,
        detectedMime: detectMime(content),
        bytes: content.byteLength,
        sha256,
      });
    } catch (error) {
      files.push({
        status: "failed",
        identity: file.identity,
        locations: file.locations,
        error: safeError(error),
      });
    }
  }
  return files;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (response.body === null) throw new Error("attachment has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("attachment exceeded its byte limit");
    }
    chunks.push(part.value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function discoverReferences(
  issue: Record<string, unknown>,
  messages: readonly Record<string, unknown>[],
): string[] {
  const references = new Set<string>();
  for (const value of [issue.body_html, ...messages.map((message) => message.message_html)]) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(/https?:\/\/[^\s<>()[\]{}"']+/gu)) {
      const safe = safeExternalUrl(match[0].replace(/[.,;:!?]+$/u, ""));
      if (safe !== null && new URL(safe).hostname !== ASSET_HOST) references.add(safe);
    }
  }
  for (const entry of optionalArray(issue.external_issues)) {
    const link = optionalString(object(entry, "Pylon external issue").link);
    const safe = link === undefined ? null : safeExternalUrl(link);
    if (safe !== null) references.add(safe);
  }
  return [...references].sort();
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactUrls(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
  }
  return value;
}

function redactUrls(value: string): string {
  return value.replace(
    /https?:\/\/[^\s<>"')\]]+/gu,
    (match) => safeExternalUrl(match) ?? "URL [REDACTED]",
  );
}

function safeExternalUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    if (url.hostname === ASSET_HOST) {
      url.search = "?signed=[REDACTED]";
      return url.toString();
    }
    for (const key of url.searchParams.keys()) {
      if (isSensitiveQuery(key, url.searchParams.get(key) ?? "")) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isSensitiveQuery(key: string, value: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
  return (
    /(?:^|[-_])(signature|sig|token|secret|key|credential|authorization|auth|jwt|password)(?:$|[-_])/u.test(
      normalized,
    ) ||
    normalized === "expires" ||
    normalized.startsWith("x-amz-") ||
    value.length > 64
  );
}

function assetIdentity(input: string): string {
  const url = parsePylonAssetUrl(input);
  return `pylon-asset-${createHash("sha256")
    .update(`${url.origin}${url.pathname}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function fileName(contentDisposition: string | null, index: number): string {
  const declared =
    contentDisposition?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1] ??
    contentDisposition?.match(/filename="?([^";]+)"?/iu)?.[1];
  const decoded = declared === undefined ? `attachment-${index + 1}` : decodeURIComponent(declared);
  const safe = basename(decoded)
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replaceAll(/^[.-]+|[.-]+$/gu, "");
  return (safe || `attachment-${index + 1}`).slice(0, 100);
}

function detectMime(content: Uint8Array): string {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...content.subarray(offset, offset + length));
  if (content[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "%PDF") return "application/pdf";
  if (ascii(0, 2) === "PK") return "application/zip";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(4, 4) === "ftyp") return "video/mp4";
  const text = decodeUtf8(content);
  if (text !== null) {
    try {
      JSON.parse(text);
      return "application/json";
    } catch {
      return "text/plain";
    }
  }
  return "application/octet-stream";
}

function decodeUtf8(content: Uint8Array): string | null {
  if (content.subarray(0, 8_192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, 8_192));
  } catch {
    return null;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function optionalArray(value: unknown): unknown[] {
  return value === null || value === undefined ? [] : array(value, "Pylon array");
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is invalid`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} is invalid`);
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}
