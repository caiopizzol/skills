import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface RetrievedLane {
  status: "retrieved";
  pages: number;
  complete: true;
  nodes: Record<string, unknown>[];
}

export interface FailedLane {
  status: "failed";
  pages: number;
  complete: false;
  nodes: Record<string, unknown>[];
  error: string;
}

export type Lane = RetrievedLane | FailedLane;

export interface SourceLocation {
  container: string;
  field: string;
  label?: string;
}

export interface EvidenceSource extends SourceLocation {
  text: string;
}

export interface UploadReference {
  kind: "linear-upload";
  identity: string;
  url: string;
  label?: string;
  locations: SourceLocation[];
}

export interface ExternalReference {
  kind: "external";
  url: string;
  queryRedacted?: true;
  label?: string;
  locations: SourceLocation[];
}

export type DiscoveredReference = UploadReference | ExternalReference;

export interface RetrievedFile {
  status: "retrieved";
  identity: string;
  locations: SourceLocation[];
  originalName: string;
  localPath: string;
  declaredMime: string | null;
  detectedMime: string;
  bytes: number;
  sha256: string;
}

export interface FailedFile {
  status: "failed";
  identity: string;
  locations: SourceLocation[];
  originalName: string;
  error: string;
}

export type FileEntry = RetrievedFile | FailedFile;

export interface CollectionResult {
  runDirectory: string;
  contextPath: string;
  manifestPath: string;
  issueIdentifier: string;
  laneCount: number;
  files: FileEntry[];
  externalReferences: ExternalReference[];
  gaps: string[];
}

interface GraphqlEnvelope {
  data?: unknown;
  errors?: unknown;
}

interface ConnectionPage {
  nodes: Record<string, unknown>[];
  pageInfo: PageInfo;
}

interface CollectorOptions {
  apiKey: string;
  artifactsDirectory: string;
  fetcher?: Fetcher;
  now?: () => Date;
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ISSUE_FIELDS = `
  id identifier number title description url branchName previousIdentifiers
  createdAt updatedAt archivedAt startedAt completedAt canceledAt dueDate priority priorityLabel estimate
  team { id key name }
  state { id name type }
  assignee { id name }
  delegate { id name }
  creator { id name }
  project { id }
  projectMilestone { id name description targetDate }
  cycle { id number name startsAt endsAt }
  parent { id identifier title description url }
  syncedWith { id service }
`;

const COMMENT_FIELDS = `
  id body createdAt updatedAt editedAt resolvedAt archivedAt parentId quotedText url
  user { id name }
  externalUser { id name }
  botActor { id name }
  onBehalfOf { id name }
  syncedWith { id service }
`;

const RELATED_ISSUE_FIELDS = `
  id identifier title description url createdAt updatedAt archivedAt
  state { id name type }
`;

const ATTACHMENT_FIELDS = `
  id title subtitle url sourceType createdAt updatedAt metadata
  creator { id name }
`;

const NEED_FIELDS = `
  id priority body content url createdAt updatedAt archivedAt
  creator { id name }
  customer { id name url }
  comment { id body }
  attachment { ${ATTACHMENT_FIELDS} }
`;

const DOCUMENT_FIELDS = `
  id title summary content url slugId createdAt updatedAt archivedAt
  creator { id name }
  owner { id name }
`;

const HISTORY_FIELDS = `
  id createdAt updatedAt updatedDescription fromTitle toTitle fromPriority toPriority
  fromEstimate toEstimate fromDueDate toDueDate archived trashed customerNeedId
  actor { id name }
  fromAssignee { id name }
  toAssignee { id name }
  fromState { id name type }
  toState { id name type }
  fromProject { id name }
  toProject { id name }
  fromParent { id identifier title }
  toParent { id identifier title }
  addedLabels { id name }
  removedLabels { id name }
  attachment { ${ATTACHMENT_FIELDS} }
`;

const STATE_HISTORY_FIELDS = `id stateId startedAt endedAt state { id name type }`;

const ISSUE_CONNECTIONS: ReadonlyArray<[string, string, string?]> = [
  ["comments", COMMENT_FIELDS],
  ["labels", "id name description color isGroup parent { id name }"],
  ["children", RELATED_ISSUE_FIELDS],
  ["relations", `id type createdAt updatedAt relatedIssue { ${RELATED_ISSUE_FIELDS} }`],
  ["inverseRelations", `id type createdAt updatedAt issue { ${RELATED_ISSUE_FIELDS} }`],
  ["attachments", ATTACHMENT_FIELDS],
  ["formerAttachments", ATTACHMENT_FIELDS],
  ["needs", NEED_FIELDS],
  ["formerNeeds", NEED_FIELDS],
  ["documents", DOCUMENT_FIELDS, "includeArchived: true"],
  ["history", HISTORY_FIELDS],
  ["stateHistory", STATE_HISTORY_FIELDS],
];

export function parseIssueLocator(locator: string): string {
  const trimmed = locator.trim();
  if (/^[A-Z][A-Z0-9]*-\d+$/i.test(trimmed)) return trimmed.toUpperCase();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Require one exact Linear issue identifier or URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "linear.app" ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Only exact https://linear.app issue URLs are supported");
  }
  const identifiers = [
    ...new Set(
      parsed.pathname.match(/[A-Z][A-Z0-9]*-\d+/gi)?.map((value) => value.toUpperCase()) ?? [],
    ),
  ];
  if (identifiers.length !== 1)
    throw new Error("Linear issue URL must contain exactly one issue identifier");
  return identifiers[0]!;
}

class GraphqlClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher,
  ) {}

  async request(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Linear GraphQL returned HTTP ${response.status}`);
    const payload = (await response.json()) as GraphqlEnvelope;
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const messages = payload.errors.map((error) =>
        isRecord(error) && typeof error.message === "string"
          ? error.message
          : "Unknown GraphQL error",
      );
      throw new Error(`Linear GraphQL error: ${messages.join("; ")}`);
    }
    return requireRecord(payload.data, "GraphQL data");
  }

  async connection(
    owner: "issue" | "document" | "project",
    id: string,
    field: string,
    selection: string,
    extraArguments?: string,
  ): Promise<Lane> {
    const nodes: Record<string, unknown>[] = [];
    let after: string | null = null;
    let pages = 0;
    try {
      do {
        const query = `query Connection($id: String!, $first: Int!, $after: String) {
          ${owner}(id: $id) {
            ${field}(first: $first, after: $after${extraArguments ? `, ${extraArguments}` : ""}) {
              nodes { ${selection} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`;
        const data = await this.request(query, { id, first: PAGE_SIZE, after });
        const ownerRecord = requireRecord(data[owner], owner);
        const page = parsePage(ownerRecord[field], `${owner}.${field}`);
        nodes.push(...page.nodes);
        pages += 1;
        if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === null) {
          throw new Error(`${owner}.${field} returned hasNextPage without endCursor`);
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after !== null);
      return { status: "retrieved", pages, complete: true, nodes };
    } catch (error) {
      return { status: "failed", pages, complete: false, nodes, error: messageOf(error) };
    }
  }
}

export async function collectLinearIssue(
  locator: string,
  options: CollectorOptions,
): Promise<CollectionResult> {
  const issueIdentifier = parseIssueLocator(locator);
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const client = new GraphqlClient(options.apiKey, fetcher);
  const generatedAt = now().toISOString();
  const baseData = await client.request(
    `query Issue($id: String!) {
      organization { id name urlKey }
      issue(id: $id) { ${ISSUE_FIELDS} }
    }`,
    { id: issueIdentifier },
  );
  const issue = requireRecord(baseData.issue, "issue");
  const issueId = requireString(issue, "id");
  const canonicalIdentifier = requireString(issue, "identifier");
  const organization = requireRecord(baseData.organization, "organization");
  const lanes: Record<string, Lane> = {};
  await Promise.all(
    ISSUE_CONNECTIONS.map(async ([field, selection, extraArguments]) => {
      lanes[field] = await client.connection("issue", issueId, field, selection, extraArguments);
    }),
  );

  const documents = retrievedNodes(lanes.documents);
  const documentComments: Record<string, Lane> = {};
  await Promise.all(
    documents.map(async (document) => {
      const documentId = requireString(document, "id");
      documentComments[documentId] = await client.connection(
        "document",
        documentId,
        "comments",
        COMMENT_FIELDS,
      );
    }),
  );

  const projectContext = await retrieveProject(issue.project, client);
  const sources = contextSources(issue, lanes, documents, documentComments, projectContext);
  const references = discoverReferences(sources);

  const runDirectory = join(
    options.artifactsDirectory,
    `linear-${safeSegment(canonicalIdentifier)}-${generatedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  const filesDirectory = join(runDirectory, "files");
  await mkdir(options.artifactsDirectory, { recursive: true });
  await mkdir(runDirectory);
  await mkdir(filesDirectory);
  const fileEntries = await downloadUploads(
    references.filter(
      (reference): reference is UploadReference => reference.kind === "linear-upload",
    ),
    filesDirectory,
    runDirectory,
    options.apiKey,
    fetcher,
  );
  const externalReferences = references.filter(
    (reference): reference is ExternalReference => reference.kind === "external",
  );
  const gaps = [
    ...Object.entries(lanes)
      .filter(([, lane]) => lane.status === "failed")
      .map(([name, lane]) => `${name}: ${lane.status === "failed" ? lane.error : "failed"}`),
    ...Object.entries(documentComments)
      .filter(([, lane]) => lane.status === "failed")
      .map(
        ([id, lane]) =>
          `document-comments:${id}: ${lane.status === "failed" ? lane.error : "failed"}`,
      ),
    ...fileEntries
      .filter((entry): entry is FailedFile => entry.status === "failed")
      .map((entry) => `file:${entry.identity}: ${entry.error}`),
    ...projectGaps(projectContext),
  ];
  const contextPath = join(runDirectory, "linear-context.json");
  const manifestPath = join(runDirectory, "linear-manifest.json");
  await Bun.write(
    contextPath,
    JSON.stringify(
      sanitize({
        schemaVersion: 1,
        generatedAt,
        requestedLocator: safeRequestedLocator(locator),
        organization,
        issue,
        lanes,
        documentComments,
        project: projectContext,
      }),
      null,
      2,
    ),
  );
  await Bun.write(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt,
        issueIdentifier: canonicalIdentifier,
        files: fileEntries,
        externalReferences,
        gaps,
      },
      null,
      2,
    ),
  );
  return {
    runDirectory,
    contextPath,
    manifestPath,
    issueIdentifier: canonicalIdentifier,
    laneCount: Object.keys(lanes).length,
    files: fileEntries,
    externalReferences,
    gaps,
  };
}

async function retrieveProject(
  value: unknown,
  client: GraphqlClient,
): Promise<Record<string, unknown> | null> {
  if (value === null || value === undefined) return null;
  const projectId = requireString(requireRecord(value, "issue.project"), "id");
  try {
    const data = await client.request(
      `query Project($id: String!) {
        project(id: $id) {
          id name description content url createdAt updatedAt completedAt canceledAt archivedAt startDate targetDate
          status { id name type }
          lead { id name }
          creator { id name }
        }
      }`,
      { id: projectId },
    );
    const project = requireRecord(data.project, "project");
    const [comments, attachments] = await Promise.all([
      client.connection("project", projectId, "comments", COMMENT_FIELDS),
      client.connection("project", projectId, "attachments", "id title url createdAt updatedAt"),
    ]);
    return { ...project, retrievalStatus: "retrieved", comments, attachments };
  } catch (error) {
    return { id: projectId, retrievalStatus: "failed", error: messageOf(error) };
  }
}

function contextSources(
  issue: Record<string, unknown>,
  lanes: Record<string, Lane>,
  documents: Record<string, unknown>[],
  documentComments: Record<string, Lane>,
  project: Record<string, unknown> | null,
): EvidenceSource[] {
  const sources: EvidenceSource[] = [];
  addText(sources, "issue", "description", issue.description);
  for (const comment of retrievedNodes(lanes.comments)) {
    addText(sources, `comment:${stringOr(comment.id, "unknown")}`, "body", comment.body);
  }
  const parent = isRecord(issue.parent) ? issue.parent : null;
  if (parent)
    addText(sources, `parent:${stringOr(parent.id, "unknown")}`, "description", parent.description);
  for (const child of retrievedNodes(lanes.children)) {
    addText(sources, `child:${stringOr(child.id, "unknown")}`, "description", child.description);
  }
  for (const relation of retrievedNodes(lanes.relations)) {
    const related = isRecord(relation.relatedIssue) ? relation.relatedIssue : null;
    if (related)
      addText(
        sources,
        `related-issue:${stringOr(related.id, "unknown")}`,
        "description",
        related.description,
      );
  }
  for (const relation of retrievedNodes(lanes.inverseRelations)) {
    const related = isRecord(relation.issue) ? relation.issue : null;
    if (related)
      addText(
        sources,
        `inverse-related-issue:${stringOr(related.id, "unknown")}`,
        "description",
        related.description,
      );
  }
  for (const need of [...retrievedNodes(lanes.needs), ...retrievedNodes(lanes.formerNeeds)]) {
    const container = `customer-need:${stringOr(need.id, "unknown")}`;
    addText(sources, container, "body", need.body);
    addText(sources, container, "content", need.content);
    const comment = isRecord(need.comment) ? need.comment : null;
    if (comment)
      addText(
        sources,
        `${container}:comment:${stringOr(comment.id, "unknown")}`,
        "body",
        comment.body,
      );
    const attachment = isRecord(need.attachment) ? need.attachment : null;
    if (attachment) {
      addDirectUrl(
        sources,
        container,
        "attachment.url",
        attachment.url,
        stringOr(attachment.title, undefined),
      );
    }
  }
  for (const document of documents) {
    const documentId = stringOr(document.id, "unknown") ?? "unknown";
    addText(sources, `document:${documentId}`, "summary", document.summary);
    addText(sources, `document:${documentId}`, "content", document.content);
    for (const comment of retrievedNodes(documentComments[documentId])) {
      addText(sources, `document-comment:${stringOr(comment.id, "unknown")}`, "body", comment.body);
    }
  }
  for (const attachment of [
    ...retrievedNodes(lanes.attachments),
    ...retrievedNodes(lanes.formerAttachments),
  ]) {
    addDirectUrl(
      sources,
      `resource:${stringOr(attachment.id, "unknown")}`,
      "url",
      attachment.url,
      stringOr(attachment.title, undefined),
    );
  }
  for (const history of retrievedNodes(lanes.history)) {
    const attachment = isRecord(history.attachment) ? history.attachment : null;
    if (attachment) {
      addDirectUrl(
        sources,
        `history:${stringOr(history.id, "unknown")}`,
        "attachment.url",
        attachment.url,
        stringOr(attachment.title, undefined),
      );
    }
  }
  if (project) {
    addText(
      sources,
      `project:${stringOr(project.id, "unknown")}`,
      "description",
      project.description,
    );
    addText(sources, `project:${stringOr(project.id, "unknown")}`, "content", project.content);
    for (const comment of retrievedNodes(project.comments as Lane | undefined)) {
      addText(sources, `project-comment:${stringOr(comment.id, "unknown")}`, "body", comment.body);
    }
    for (const attachment of retrievedNodes(project.attachments as Lane | undefined)) {
      addDirectUrl(
        sources,
        `project-resource:${stringOr(attachment.id, "unknown")}`,
        "url",
        attachment.url,
        stringOr(attachment.title, undefined),
      );
    }
  }
  return sources;
}

function addText(
  sources: EvidenceSource[],
  container: string,
  field: string,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0)
    sources.push({ container, field, text: value });
}

function addDirectUrl(
  sources: EvidenceSource[],
  container: string,
  field: string,
  value: unknown,
  label: string | undefined,
): void {
  if (typeof value === "string" && value.length > 0)
    sources.push({ container, field, text: label ? `[${label}](${value})` : value });
}

export function discoverReferences(sources: readonly EvidenceSource[]): DiscoveredReference[] {
  const found = new Map<string, DiscoveredReference>();
  for (const source of sources) {
    const labeled = new Map<string, string>();
    for (const match of source.text.matchAll(
      /!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g,
    )) {
      if (match[2]) labeled.set(trimUrl(match[2]), match[1]?.trim() || "");
    }
    const candidates = new Set<string>([
      ...labeled.keys(),
      ...[...source.text.matchAll(/https?:\/\/[^\s<>"']+/g)].flatMap((match) =>
        match[0] ? [trimUrl(match[0])] : [],
      ),
    ]);
    for (const candidate of candidates) {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" || url.username || url.password) continue;
      const location: SourceLocation = { container: source.container, field: source.field };
      const label = labeled.get(candidate) || source.label;
      if (url.hostname === "uploads.linear.app") {
        const canonical = `${url.origin}${url.pathname}`;
        const key = `upload:${canonical}`;
        const existing = found.get(key);
        if (existing?.kind === "linear-upload") existing.locations.push(location);
        else
          found.set(key, {
            kind: "linear-upload",
            identity: hashText(canonical),
            url: candidate,
            ...(label ? { label } : {}),
            locations: [location],
          });
      } else {
        const safe = safeExternalUrl(url);
        const key = `external:${safe.url}`;
        const existing = found.get(key);
        if (existing?.kind === "external") existing.locations.push(location);
        else
          found.set(key, {
            kind: "external",
            url: safe.url,
            ...(safe.queryRedacted ? { queryRedacted: true } : {}),
            ...(label ? { label } : {}),
            locations: [location],
          });
      }
    }
  }
  return [...found.values()];
}

async function downloadUploads(
  uploads: readonly UploadReference[],
  filesDirectory: string,
  runDirectory: string,
  apiKey: string,
  fetcher: Fetcher,
): Promise<FileEntry[]> {
  const output: FileEntry[] = [];
  let totalBytes = 0;
  for (const [index, upload] of uploads.entries()) {
    const originalName = safeFilename(
      upload.label || basename(new URL(upload.url).pathname) || `upload-${index + 1}`,
    );
    try {
      const response = await fetcher(upload.url, {
        headers: { Authorization: apiKey },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.redirected) throw new Error("upload download redirected unexpectedly");
      if (response.url && new URL(response.url).hostname !== "uploads.linear.app") {
        throw new Error("upload response escaped uploads.linear.app");
      }
      if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES)
        throw new Error("file exceeds 50 MiB limit");
      const remainingTotal = MAX_TOTAL_BYTES - totalBytes;
      if (remainingTotal <= 0) throw new Error("collection exceeds 250 MiB total limit");
      const bytes = await readBounded(
        response,
        Math.min(MAX_FILE_BYTES, remainingTotal),
        (consumed) => {
          totalBytes += consumed;
        },
      );
      const sha256 = hashBytes(bytes);
      const localName = `${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 12)}-${originalName}`;
      const localPath = join(filesDirectory, localName);
      await Bun.write(localPath, bytes);
      output.push({
        status: "retrieved",
        identity: upload.identity,
        locations: upload.locations,
        originalName,
        localPath: relativePath(runDirectory, localPath),
        declaredMime: response.headers.get("content-type")?.split(";", 1)[0] ?? null,
        detectedMime: detectMime(bytes),
        bytes: bytes.byteLength,
        sha256,
      });
    } catch (error) {
      output.push({
        status: "failed",
        identity: upload.identity,
        locations: upload.locations,
        originalName,
        error: messageOf(error),
      });
    }
  }
  return output;
}

export async function readBounded(
  response: Response,
  maximumBytes: number,
  account: (consumedBytes: number) => void = () => undefined,
): Promise<Uint8Array> {
  if (!response.body) throw new Error("download returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    account(part.value.byteLength);
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("download exceeded configured byte limit");
    }
    chunks.push(part.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function detectMime(bytes: Uint8Array): string {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "%PDF") return "application/pdf";
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp";
  if (starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return "image/tiff";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (
    ascii(bytes, 0, 3) === "ID3" ||
    (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
  ) {
    return "audio/mpeg";
  }
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 8);
    if (brand.includes("avif") || brand.includes("avis")) return "image/avif";
    if (brand.includes("heic") || brand.includes("heix") || brand.includes("mif1"))
      return "image/heic";
    if (brand.includes("M4A ") || brand.includes("M4B ") || brand.includes("M4P "))
      return "audio/mp4";
    if (brand.includes("qt  ")) return "video/quicktime";
    return "video/mp4";
  }
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (
      contains(bytes, new TextEncoder().encode("word/")) &&
      contains(bytes, new TextEncoder().encode("[Content_Types].xml"))
    ) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    return "application/zip";
  }
  const sample = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 4096))
    .trimStart();
  if (sample.startsWith("<svg") || /<svg[\s>]/i.test(sample.slice(0, 512))) return "image/svg+xml";
  if (sample.startsWith("<?xml") || /^<[^>]+>/.test(sample)) return "application/xml";
  try {
    JSON.parse(sample);
    return "application/json";
  } catch {
    return isMostlyText(bytes) ? "text/plain" : "application/octet-stream";
  }
}

function parsePage(value: unknown, label: string): ConnectionPage {
  const page = requireRecord(value, label);
  if (!Array.isArray(page.nodes)) throw new Error(`${label}.nodes is not an array`);
  const nodes = page.nodes.map((node, index) => requireRecord(node, `${label}.nodes[${index}]`));
  const pageInfo = requireRecord(page.pageInfo, `${label}.pageInfo`);
  if (typeof pageInfo.hasNextPage !== "boolean")
    throw new Error(`${label}.pageInfo.hasNextPage is invalid`);
  if (
    pageInfo.endCursor !== null &&
    pageInfo.endCursor !== undefined &&
    typeof pageInfo.endCursor !== "string"
  ) {
    throw new Error(`${label}.pageInfo.endCursor is invalid`);
  }
  return {
    nodes,
    pageInfo: { hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor ?? null },
  };
}

function retrievedNodes(lane: Lane | undefined): Record<string, unknown>[] {
  return lane?.nodes ?? [];
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactSignedUrls(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
  return value;
}

export function redactSignedUrls(value: string): string {
  return value.replace(/https:\/\/[^\s<>"')\]]+/g, (match) => {
    const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
    const clean = trailing ? match.slice(0, -trailing.length) : match;
    try {
      const url = new URL(clean);
      if (url.hostname === "uploads.linear.app") {
        return `${url.origin}${url.pathname}${url.search ? "?signature=[REDACTED]" : ""}${trailing}`;
      }
      return `${safeExternalUrl(url).url}${trailing}`;
    } catch {
      return "HTTPS URL [REDACTED]";
    }
  });
}

function safeRequestedLocator(locator: string): string {
  const trimmed = locator.trim();
  if (/^[A-Z][A-Z0-9]*-\d+$/i.test(trimmed)) return trimmed.toUpperCase();
  const url = new URL(trimmed);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safeExternalUrl(input: URL): { url: string; queryRedacted: boolean } {
  const url = new URL(input);
  let queryRedacted = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    queryRedacted = true;
  }
  for (const key of url.searchParams.keys()) {
    const value = url.searchParams.get(key) ?? "";
    if (isSensitiveQuery(key, value)) {
      url.searchParams.set(key, "[REDACTED]");
      queryRedacted = true;
    }
  }
  if (url.hash) {
    url.hash = "";
    queryRedacted = true;
  }
  return { url: url.toString(), queryRedacted };
}

function isSensitiveQuery(key: string, value: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return (
    /(?:^|[-_])(signature|sig|token|secret|key|credential|authorization|auth|jwt|password|passwd)(?:$|[-_])/.test(
      normalized,
    ) ||
    normalized === "expires" ||
    normalized.startsWith("x-amz-") ||
    normalized.startsWith("x-goog-") ||
    value.length > 64 ||
    value.split(".").length === 3
  );
}

function projectGaps(project: Record<string, unknown> | null): string[] {
  if (!project) return [];
  if (project.retrievalStatus === "failed")
    return [`project: ${stringOr(project.error, "retrieval failed")}`];
  const gaps: string[] = [];
  for (const field of ["comments", "attachments"] as const) {
    const lane = project[field];
    if (isRecord(lane) && lane.status === "failed")
      gaps.push(`project-${field}: ${stringOr(lane.error, "retrieval failed")}`);
  }
  return gaps;
}

function trimUrl(value: string): string {
  return value.replace(/[\])}.,;:!?]+$/, "");
}

function safeFilename(value: string): string {
  let cleaned = "";
  for (const character of value.normalize("NFKC")) {
    const codePoint = character.codePointAt(0) ?? 0;
    cleaned +=
      codePoint < 0x20 || character === "/" || character === "\\" || character === ":"
        ? "-"
        : character;
  }
  const normalized = cleaned.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 160) || "upload";
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function relativePath(root: string, target: string): string {
  const candidate = relative(root, target);
  if (candidate === "" || isAbsolute(candidate) || candidate.split(sep).includes("..")) {
    throw new Error("download target escaped the run directory");
  }
  return candidate;
}

function hashText(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    for (let inner = 0; inner < needle.length; inner += 1)
      if (bytes[index + inner] !== needle[inner]) continue outer;
    return true;
  }
  return false;
}

function isMostlyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  let control = 0;
  for (const byte of sample) if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  return control / sample.length < 0.02;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${key} is not a non-empty string`);
  return value;
}

function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
