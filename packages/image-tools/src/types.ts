export const IMAGE_TOOLS_FORMAT_VERSION = 1 as const;

export type ImageOperation = "identify" | "convert" | "expand-gif" | "inspect-svg";

export type ImageOutcome =
  | "ok"
  | "tool-unavailable"
  | "identify-failed"
  | "convert-failed"
  | "unsupported-input"
  | "unsafe-input"
  | "timeout";

// What the fallible pre-identification classifier concluded. It routes work and bounds parser
// exposure; it never decides safety on its own. See classify-input.ts.
export type InputKind = "known-raster" | "textual-svg-candidate" | "compressed-input" | "unknown";

export interface InputClassification {
  formatVersion: typeof IMAGE_TOOLS_FORMAT_VERSION;
  kind: InputKind;
  reason: string;
}

export type ImageFailureOutcome = Exclude<ImageOutcome, "ok">;

export interface ImageIdentity {
  formatVersion: typeof IMAGE_TOOLS_FORMAT_VERSION;
  format: string;
  width: number;
  height: number;
  // Frame count is reported for every format, not only for GIF. Routing depends on it: a single
  // frame is viewable directly, and more than one means the file holds an animation whose frames
  // have to be expanded and counted before any of them can be called inspected.
  frameCount: number;
}

export interface ImageDerivative {
  path: string;
  bytes: number;
  sha256: string;
  operation: "convert" | "expand-gif";
  parentSha256: string;
}

export interface ImageFailure<TOperation extends ImageOperation> {
  outcome: ImageFailureOutcome;
  operation: TOperation;
  inputPath: string;
  message: string;
}

export interface IdentifyImageSuccess {
  outcome: "ok";
  operation: "identify";
  inputPath: string;
  identity: ImageIdentity;
}

export type IdentifyImageResult = IdentifyImageSuccess | ImageFailure<"identify">;

export interface ConvertImageSuccess {
  outcome: "ok";
  operation: "convert";
  inputPath: string;
  derivative: ImageDerivative;
}

export type ConvertImageResult = ConvertImageSuccess | ImageFailure<"convert">;

export interface GifFramePlan {
  frameCount: number;
  maxFrames: number;
  boundedBy: "frame-count" | "max-frames";
  selectedIndexes: number[];
  omittedIndexes: number[];
}

export interface ExpandedGifFrame {
  frameIndex: number;
  derivative: ImageDerivative;
}

export interface ExpandGifFramesSuccess {
  outcome: "ok";
  operation: "expand-gif";
  inputPath: string;
  sampling: GifFramePlan;
  frames: ExpandedGifFrame[];
}

export type ExpandGifFramesResult = ExpandGifFramesSuccess | ImageFailure<"expand-gif">;

export type SvgSafetyReasonCode =
  | "script-element"
  | "event-handler-attribute"
  | "external-reference"
  | "external-image"
  | "entity-declaration"
  | "foreign-object"
  // Refusals that come from routing rather than from a construct found in the text. A compressed
  // or undecodable candidate cannot be inspected at all, and `unverified-svg` is the invariant
  // firing: the renderer called it SVG and no inspection had cleared it.
  | "compressed-input"
  | "undecodable-candidate"
  | "unverified-svg";

export interface SvgSafetyReason {
  code: SvgSafetyReasonCode;
  detail: string;
}

export interface SvgSafetyVerdict {
  formatVersion: typeof IMAGE_TOOLS_FORMAT_VERSION;
  selfContained: boolean;
  reasons: SvgSafetyReason[];
}

// A refused SVG is not a tool failure, so this result carries the verdict on both outcomes rather
// than splitting into a success shape and a failure shape with a message. The reasons are the
// report either way, and the caller needs them most when the outcome is `unsafe-input`.
export interface InspectSvgSafetyResult {
  outcome: "ok" | "unsafe-input";
  operation: "inspect-svg";
  inputPath: string;
  verdict: SvgSafetyVerdict;
}
