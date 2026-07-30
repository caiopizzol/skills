import { describe, expect, it } from "vite-plus/test";
import { inspectSvgSafety, inspectSvgText, type SvgSafetyReasonCode } from "../src/index.ts";
import { CWD, readImageFixtureText } from "./fixtures/image-scenarios.ts";

const SVG_PATH = "/fixture/run/originals/fixture-svg.svg";
const safeSource = readImageFixtureText("fixture-svg.svg");

function wrap(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">${body}</svg>`;
}

// Every hostile case is constructed here rather than committed, so the repository never carries an
// SVG whose only purpose is to be dangerous.
const hostile: ReadonlyArray<{ label: string; code: SvgSafetyReasonCode; source: string }> = [
  {
    label: "a script element",
    code: "script-element",
    source: wrap('<script>fetch("https://example.invalid/beacon")</script>'),
  },
  {
    label: "an onload attribute",
    code: "event-handler-attribute",
    source: wrap('<rect width="10" height="10" onload="alert(1)"/>'),
  },
  {
    label: "an onclick attribute",
    code: "event-handler-attribute",
    source: wrap('<rect width="10" height="10" onclick="alert(1)"/>'),
  },
  {
    label: "an external href",
    code: "external-reference",
    source: wrap('<a href="https://example.invalid/page"><rect width="10" height="10"/></a>'),
  },
  {
    label: "an external xlink:href",
    code: "external-reference",
    source: wrap('<use xlink:href="https://example.invalid/sprite.svg#icon"/>'),
  },
  {
    label: "an external image target",
    code: "external-image",
    source: wrap('<image href="https://example.invalid/pixel.png" width="10" height="10"/>'),
  },
  {
    label: "an entity declaration",
    code: "entity-declaration",
    source:
      '<!DOCTYPE svg [<!ENTITY leak SYSTEM "file:///etc/hostname">]>' + wrap("<text>&leak;</text>"),
  },
  {
    label: "a foreignObject element",
    code: "foreign-object",
    source: wrap(
      '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
    ),
  },
  {
    label: "an external stylesheet import",
    code: "external-reference",
    source: wrap(
      '<style>@import "https://example.invalid/x.css";</style><rect width="10" height="10"/>',
    ),
  },
  {
    label: "an external stylesheet import written as a url()",
    code: "external-reference",
    source: wrap(
      '<style>@import url(https://example.invalid/x.css);</style><rect width="10" height="10"/>',
    ),
  },
];

describe("inspectSvgText", () => {
  it("accepts the committed fixture as self-contained", () => {
    const verdict = inspectSvgText(safeSource);

    expect(verdict).toEqual({ formatVersion: 1, selfContained: true, reasons: [] });
  });

  it.each(hostile)("refuses $label with its specific reason", ({ code, source }) => {
    const verdict = inspectSvgText(source);

    expect(verdict.selfContained).toBe(false);
    expect(verdict.reasons.map((reason) => reason.code)).toContain(code);
    expect(verdict.reasons.every((reason) => reason.detail.length > 0)).toBe(true);
  });

  it("returns every reason rather than stopping at the first", () => {
    const verdict = inspectSvgText(
      wrap('<script>x</script><rect onload="y"/><image href="https://example.invalid/p.png"/>'),
    );

    expect(new Set(verdict.reasons.map((reason) => reason.code))).toEqual(
      new Set([
        "script-element",
        "event-handler-attribute",
        "external-image",
        "external-reference",
      ]),
    );
  });

  it("accepts a same-document fragment reference and an inline data image", () => {
    expect(inspectSvgText(wrap('<use href="#shape"/>')).selfContained).toBe(true);
    expect(
      inspectSvgText(
        wrap('<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>'),
      ).selfContained,
    ).toBe(true);
  });

  it("refuses an inline data URL whose media type is not a known raster image", () => {
    const verdict = inspectSvgText(
      wrap('<image href="data:text/html,%3Cscript%3Ealert(1)%3C/script%3E"/>'),
    );

    expect(verdict.reasons.map((reason) => reason.code)).toContain("external-image");
  });

  it("flags an external url() reference such as a remote filter or pattern", () => {
    const verdict = inspectSvgText(
      wrap('<rect fill="url(https://example.invalid/pattern.svg#p)"/>'),
    );

    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["external-reference"]);
  });

  it("refuses a script element with a dotted namespace prefix", () => {
    const verdict = inspectSvgText(wrap("<x.y:script>alert(1)</x.y:script>"));

    expect(verdict.reasons.map((reason) => reason.code)).toContain("script-element");
  });

  it("decodes numeric character references before checking url() targets", () => {
    const verdict = inspectSvgText(wrap('<rect fill="&#117;rl(https://example.invalid/x.svg)"/>'));

    expect(verdict.reasons.map((reason) => reason.code)).toContain("external-reference");
  });

  it("refuses an encoded SVG data URL that contains an external image", () => {
    const nested = encodeURIComponent(wrap('<image href="https://example.invalid/x.png"/>'));
    const verdict = inspectSvgText(wrap(`<image href="data:image/svg+xml,${nested}"/>`));

    expect(verdict.reasons.map((reason) => reason.code)).toContain("external-image");
  });

  it("refuses a base64 SVG data URL that contains an external image", () => {
    const nested = Buffer.from(wrap('<image href="https://example.invalid/x.png"/>')).toString(
      "base64",
    );
    const verdict = inspectSvgText(wrap(`<image href="data:image/svg+xml;base64,${nested}"/>`));

    expect(verdict.reasons.map((reason) => reason.code)).toContain("external-image");
  });

  it("refuses SVG data nesting beyond the inspection bound", () => {
    let nested = wrap('<rect width="1" height="1"/>');
    for (let depth = 0; depth < 6; depth += 1) {
      nested = wrap(`<image href="data:image/svg+xml,${encodeURIComponent(nested)}"/>`);
    }

    expect(inspectSvgText(nested).selfContained).toBe(false);
  });

  it("refuses style content and XML stylesheet instructions instead of parsing CSS", () => {
    expect(inspectSvgText(wrap("<style>rect { fill: red }</style>")).selfContained).toBe(false);
    expect(inspectSvgText(wrap('<rect style="fill: red"/>')).selfContained).toBe(false);
    expect(inspectSvgText(`<?xml-stylesheet href="#safe"?>${wrap("<rect/>")}`).selfContained).toBe(
      false,
    );
  });

  it("gives the same verdict on a second inspection of the same text", () => {
    expect(inspectSvgText(hostile[0]?.source ?? "")).toEqual(
      inspectSvgText(hostile[0]?.source ?? ""),
    );
    expect(inspectSvgText(safeSource)).toEqual(inspectSvgText(safeSource));
  });
});

describe("inspectSvgSafety", () => {
  it("reports ok for the committed fixture", () => {
    const result = inspectSvgSafety({ inputPath: SVG_PATH, source: safeSource, cwd: CWD });

    expect(result).toMatchObject({ outcome: "ok", operation: "inspect-svg", inputPath: SVG_PATH });
    expect(result.verdict.selfContained).toBe(true);
  });

  it("reports unsafe-input with the reasons, which is a verdict about the file and not a tool failure", () => {
    const source = hostile.find((entry) => entry.code === "script-element")?.source ?? "";

    const result = inspectSvgSafety({ inputPath: SVG_PATH, source, cwd: CWD });

    expect(result.outcome).toBe("unsafe-input");
    expect(result.verdict.reasons).not.toHaveLength(0);
    expect(result).not.toHaveProperty("message");
  });
});
