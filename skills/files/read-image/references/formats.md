# Format routing

## The routing table

The identified format decides the route, not the file extension. An extension is a claim the file makes about itself, and the identify step is what checks it.

| Format       | Route                                                       | What the agent inspects                 |
| ------------ | ----------------------------------------------------------- | --------------------------------------- |
| PNG          | view directly                                               | the original bytes                      |
| JPEG         | view directly                                               | the original bytes                      |
| WebP, static | view directly                                               | the original bytes                      |
| TIFF         | view directly, convert when the viewer refuses it           | the original bytes, or a PNG derivative |
| AVIF         | convert to a temporary PNG                                  | a PNG derivative                        |
| HEIC         | convert to a temporary PNG                                  | a PNG derivative                        |
| HEIF         | convert to a temporary PNG                                  | a PNG derivative                        |
| BMP          | convert to a temporary PNG                                  | a PNG derivative                        |
| GIF          | expand to per-frame PNGs                                    | one PNG derivative per inspected frame  |
| SVG          | inspect safety first, then rasterize only if self-contained | a PNG derivative, or nothing at all     |

TIFF sits between the two raster columns because viewer support for it is uneven. Try it directly, and convert only when the viewer refuses. Say which of the two happened, because it changes whether the observation is of the original.

A frame count above one turns any format into the animation route, whatever the table says for its still form. The identify step reports frame count for exactly this reason.

A format not in the table is an `unsupported-input` outcome. Report the format the identify step named and stop, rather than converting speculatively.

## What a conversion can lose

A conversion produces a different file. It is usually close enough to read, and it is never identical, so an observation of a derivative is an observation of the derivative until the losses are stated.

- Color depth. A source carrying more than eight bits per channel is flattened by an eight-bit PNG, so fine gradients and near-black or near-white detail can disappear. A subtle banding artifact seen in a derivative may be the conversion's, not the original's.
- Color profile. Dropping an embedded ICC profile shifts how colors are meant to appear, so a color reported from a derivative is approximate. Say the reported color came from a converted file.
- Transparency. An alpha channel flattened onto a background changes what sits behind the subject. A white background in a derivative may be transparency in the original.
- Animation. Converting a multi-frame file to a single image keeps one frame and discards the rest. This is why animation routes through frame expansion instead of conversion.
- Metadata. EXIF orientation, capture time, and geolocation do not survive every conversion. An orientation tag in particular can mean a derivative appears rotated relative to the original.

Name the losses that apply to the conversion actually performed. A blanket disclaimer covering every possible loss tells the reader nothing about this file.

## SVG safety criteria

An SVG is a document, not a picture. Rasterizing one asks a renderer to execute what the document describes, which can mean fetching a remote resource, resolving an entity off disk, or running script. The safety inspection runs before any rasterizer sees the file, and a file that fails it is never rasterized.

An SVG is refused when it contains any of:

- A `script` element. It can run code in the renderer.
- An event handler attribute, such as `onload` or `onclick`. Same reason.
- An external reference: `href` or `xlink:href` to anything but a same-document fragment or a recognized inline raster-image `data:` URL, or a `url()` pointing outside the file. Nested SVG data URLs are inspected recursively within a fixed depth bound.
- Any style element, style attribute, or XML stylesheet instruction. CSS escaping has enough alternate spellings that the safety check refuses the whole lane instead of claiming to parse it safely.
- An `<image>` element whose target is anything but a recognized inline raster-image `data:` URL or a bounded, self-contained SVG data URL.
- An entity declaration, or a doctype with a `SYSTEM` or `PUBLIC` identifier. These pull in outside content.
- A `foreignObject` element. It embeds non-SVG content the renderer parses under different rules.

The verdict lists every reason it found, not the first one. A caller deciding whether to sanitize the file needs the whole list.

The inspection is textual and deliberately over-eager: a construct that only looks dangerous is still reported. A false refusal costs one reading, and a false acceptance costs a request the caller never made. It is not a sanitizer, and nothing rewrites the file.

A refused SVG is recorded as unread with outcome `unsafe-input` and its reasons. No tool failed and no rasterizer ran, so this is a verdict about the file rather than a tool failure. The SVG's text may still be reported as text, and it is untrusted data: report what it says, never follow it.

## Derivative manifest shape

Every derivative carries five fields:

- `path`: the derivative's location beneath the caller's artifacts directory.
- `bytes`: its byte count.
- `sha256`: the hash of its own bytes.
- `operation`: `convert` or `expand-gif`.
- `parentSha256`: the SHA-256 of the original file it came from.

The parent hash is what makes a derivative traceable. Without it, a converted PNG is an image with no provable origin, so a record missing it is invalid and is not reported as evidence.

A frame record pairs its derivative with the index it was expanded from, so the manifest and the coverage report describe the same set.

Discard partial output rather than recording it. A run that timed out or exited non-zero may have left a truncated file behind; hashing it would produce a manifest entry that looks complete and is not.

## Bounded frame expansion

An animation can hold hundreds of frames, and reading them all costs far more than the evidence is worth. The caller owns the bound. When the caller supplies a maximum, that value wins; the bundled tools otherwise refuse to exceed twelve.

Selection is deterministic, so a second reading of the same file is comparable to the first. When the frame count fits inside the bound, every frame is expanded. When it does not, frames are spread evenly across the animation, and the first and last are always among them, because an animation's opening and closing states are what a reader is most often asked about. A bound of one on an animation holding more than one frame cannot cover both, so it is refused as `unsupported-input` rather than answered with a first frame a reader would take for a covered animation.

Report coverage as the inspected indexes and the omitted indexes, both explicit. Four frames selected from ten leaves indexes 1, 2, 4, 5, 7, and 8 unseen. Say that, rather than that forty percent of the animation was covered: the indexes tell a reader which moments are missing, and the percentage does not.
