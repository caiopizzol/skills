export const VIDEO_TOOLS_FORMAT_VERSION = 1 as const;

export type VideoOperation = "probe" | "extract-audio" | "extract-frames";

export type VideoOutcome =
  | "ok"
  | "tool-unavailable"
  | "probe-failed"
  | "extract-failed"
  | "unsupported-input"
  | "timeout";

export type VideoFailureOutcome = Exclude<VideoOutcome, "ok">;

export type VideoStreamKind = "video" | "audio" | "other";

export interface VideoStream {
  index: number;
  codecType: VideoStreamKind;
  codecName: string | null;
  width: number | null;
  height: number | null;
  channels: number | null;
}

export interface VideoProbe {
  formatVersion: typeof VIDEO_TOOLS_FORMAT_VERSION;
  formatName: string;
  containers: string[];
  durationSeconds: number;
  streams: VideoStream[];
  hasVideoStream: boolean;
  hasAudioStream: boolean;
}

export interface VideoDerivative {
  path: string;
  bytes: number;
  sha256: string;
  operation: "extract-audio" | "extract-frames";
  parentSha256: string;
}

export interface VideoFailure<TOperation extends VideoOperation> {
  outcome: VideoFailureOutcome;
  operation: TOperation;
  inputPath: string;
  message: string;
}

export interface ProbeVideoSuccess {
  outcome: "ok";
  operation: "probe";
  inputPath: string;
  probe: VideoProbe;
}

export type ProbeVideoResult = ProbeVideoSuccess | VideoFailure<"probe">;

// Which audio streams a run actually read. A source can carry several, and extracting one of them
// is not complete audio coverage. This mirrors the frame lane, which already reports selected and
// omitted indexes rather than implying it saw everything.
export interface AudioStreamSelection {
  availableStreamIndexes: number[];
  selectedStreamIndexes: number[];
  omittedStreamIndexes: number[];
}

export interface AudioDerivative extends VideoDerivative {
  // Which stream these bytes came from, so a transcript can be attributed to one lane of a
  // multi-language or multi-track source rather than to the file as a whole.
  sourceStreamIndex: number;
}

export interface ExtractAudioSuccess {
  outcome: "ok";
  operation: "extract-audio";
  inputPath: string;
  selection: AudioStreamSelection;
  derivative: AudioDerivative;
}

export type ExtractAudioResult = ExtractAudioSuccess | VideoFailure<"extract-audio">;

export interface SampledInterval {
  startSeconds: number;
  endSeconds: number;
}

export interface FrameSamplingPlan {
  durationSeconds: number;
  requestedCount: number;
  maxFrames: number;
  boundedBy: "requested" | "max-frames" | "duration" | "explicit";
  timestampsSeconds: number[];
  rejectedTimestampsSeconds: number[];
  omittedIntervalsSeconds: SampledInterval[];
}

export interface ExtractedFrame {
  timestampSeconds: number;
  derivative: VideoDerivative;
}

export interface ExtractFramesSuccess {
  outcome: "ok";
  operation: "extract-frames";
  inputPath: string;
  sampling: FrameSamplingPlan;
  frames: ExtractedFrame[];
}

export type ExtractFramesResult = ExtractFramesSuccess | VideoFailure<"extract-frames">;
