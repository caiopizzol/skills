export {
  execWithBun,
  isToolUnavailableError,
  isToolUnavailableResult,
  type ExecBoundary,
  type ExecRequest,
  type ExecResult,
} from "@caiopizzol/media-exec";
export {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE_HZ,
  FFMPEG_COMMAND,
  buildExtractAudioArgs,
  extractAudio,
  planAudioStreams,
  type ExtractAudioOptions,
} from "./extract-audio.ts";
export {
  buildExtractFrameArgs,
  extractFrames,
  frameFilename,
  type ExtractFramesOptions,
} from "./extract-frames.ts";
export {
  FFPROBE_COMMAND,
  buildProbeArgs,
  parseProbeOutput,
  probeVideo,
  type ProbeVideoOptions,
} from "./probe-video.ts";
export {
  DEFAULT_TIMEOUT_MS,
  type DiscardOutputBoundary,
  type PrepareOutputBoundary,
  type ReadOutputBoundary,
} from "@caiopizzol/media-exec";
export { DEFAULT_MAX_FRAMES, planFrameSampling, type FrameSamplingInput } from "./sample-frames.ts";
export {
  VIDEO_TOOLS_FORMAT_VERSION,
  type AudioDerivative,
  type AudioStreamSelection,
  type ExtractAudioResult,
  type ExtractAudioSuccess,
  type ExtractFramesResult,
  type ExtractFramesSuccess,
  type ExtractedFrame,
  type FrameSamplingPlan,
  type ProbeVideoResult,
  type ProbeVideoSuccess,
  type SampledInterval,
  type VideoDerivative,
  type VideoFailure,
  type VideoFailureOutcome,
  type VideoOperation,
  type VideoOutcome,
  type VideoProbe,
  type VideoStream,
  type VideoStreamKind,
} from "./types.ts";
export { resolveWriteTarget } from "@caiopizzol/media-exec";
