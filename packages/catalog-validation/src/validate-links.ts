export interface MarkdownLink {
  /** Link target with any fragment and angle brackets removed, or null when it could not be decoded. */
  target: string | null;
  raw: string;
}

// Repository-local links only. An external URL is somebody else's uptime, and a fragment names a
// heading inside a file this check has already confirmed exists.
export function localLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let raw = (match[1] ?? "").trim();
    if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
    if (raw === "" || raw.startsWith("#") || /^(?:https?:|mailto:)/i.test(raw)) continue;
    const path = raw.split("#", 1)[0] ?? "";
    try {
      links.push({ target: decodeURIComponent(path), raw });
    } catch {
      links.push({ target: null, raw });
    }
  }
  return links;
}
