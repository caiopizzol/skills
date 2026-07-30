export {
  MAGICK_COMMAND,
  buildConvertArgs,
  convertImage,
  type ConvertImageOptions,
} from "./convert-image.ts";
export {
  execWithBun,
  isToolUnavailableError,
  isToolUnavailableResult,
  type ExecBoundary,
  type ExecRequest,
  type ExecResult,
} from "@caiopizzol/media-exec";
export {
  DEFAULT_MAX_GIF_FRAMES,
  buildExpandGifFrameArgs,
  expandGifFrames,
  gifFrameFilename,
  planGifFrames,
  type ExpandGifFramesOptions,
} from "./expand-gif-frames.ts";
export {
  IDENTIFY_COMMAND,
  IDENTIFY_FORMAT,
  buildIdentifyArgs,
  identifyImage,
  parseIdentifyOutput,
  type IdentifyImageOptions,
} from "./identify-image.ts";
export {
  inspectSvgSafety,
  inspectSvgText,
  type InspectSvgSafetyOptions,
} from "./inspect-svg-safety.ts";
export { classifyInput, isSvgCandidate } from "./classify-input.ts";
export {
  DEFAULT_TIMEOUT_MS,
  type DiscardOutputBoundary,
  type PrepareOutputBoundary,
  type ReadOutputBoundary,
} from "@caiopizzol/media-exec";
export {
  IMAGE_TOOLS_FORMAT_VERSION,
  type InputClassification,
  type InputKind,
  type ConvertImageResult,
  type ConvertImageSuccess,
  type ExpandGifFramesResult,
  type ExpandGifFramesSuccess,
  type ExpandedGifFrame,
  type GifFramePlan,
  type IdentifyImageResult,
  type IdentifyImageSuccess,
  type ImageDerivative,
  type ImageFailure,
  type ImageFailureOutcome,
  type ImageIdentity,
  type ImageOperation,
  type ImageOutcome,
  type InspectSvgSafetyResult,
  type SvgSafetyReason,
  type SvgSafetyReasonCode,
  type SvgSafetyVerdict,
} from "./types.ts";
export { resolveWriteTarget } from "@caiopizzol/media-exec";
