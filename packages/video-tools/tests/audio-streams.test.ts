import { describe, expect, it } from "vitest";
import { VIDEO_TOOLS_FORMAT_VERSION, planAudioStreams, type VideoProbe, type VideoStream } from "../src/index.ts";

function stream(index: number, codecType: VideoStream["codecType"]): VideoStream {
  return { index, codecType, codecName: codecType === "audio" ? "aac" : "h264", width: null, height: null, channels: null };
}

function probe(streams: VideoStream[]): VideoProbe {
  return {
    formatVersion: VIDEO_TOOLS_FORMAT_VERSION,
    formatName: "mov,mp4",
    containers: ["mp4"],
    durationSeconds: 6,
    streams,
    hasVideoStream: streams.some((s) => s.codecType === "video"),
    hasAudioStream: streams.some((s) => s.codecType === "audio"),
  };
}

// A source can carry several audio tracks: a second language, a commentary, an isolated
// microphone. Reading one of them and calling the lane complete is the same overclaim the frame
// lane already refuses to make.
describe("audio stream selection", () => {
  it("reports a single stream as fully covered", () => {
    expect(planAudioStreams(probe([stream(0, "video"), stream(1, "audio")]))).toEqual({
      availableStreamIndexes: [1],
      selectedStreamIndexes: [1],
      omittedStreamIndexes: [],
    });
  });

  it("names every omitted stream when a source carries several", () => {
    expect(planAudioStreams(probe([stream(0, "video"), stream(1, "audio"), stream(2, "audio"), stream(3, "audio")]))).toEqual({
      availableStreamIndexes: [1, 2, 3],
      selectedStreamIndexes: [1],
      omittedStreamIndexes: [2, 3],
    });
  });

  it("uses the real stream index rather than a position", () => {
    // ffprobe numbers streams across the whole file, so the first audio stream is rarely index 0.
    expect(planAudioStreams(probe([stream(0, "video"), stream(1, "other"), stream(2, "audio")])).selectedStreamIndexes)
      .toEqual([2]);
  });

  it("honors an explicit stream choice", () => {
    const selection = planAudioStreams(probe([stream(0, "video"), stream(1, "audio"), stream(2, "audio")]), 2);

    expect(selection.selectedStreamIndexes).toEqual([2]);
    expect(selection.omittedStreamIndexes).toEqual([1]);
  });

  it("selects nothing when the requested stream is not an audio stream", () => {
    const selection = planAudioStreams(probe([stream(0, "video"), stream(1, "audio")]), 9);

    expect(selection.selectedStreamIndexes).toEqual([]);
    expect(selection.omittedStreamIndexes).toEqual([1]);
  });

  it("reports an empty selection for a source with no audio", () => {
    expect(planAudioStreams(probe([stream(0, "video")]))).toEqual({
      availableStreamIndexes: [],
      selectedStreamIndexes: [],
      omittedStreamIndexes: [],
    });
  });
});
