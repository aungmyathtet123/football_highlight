import { readFile } from "node:fs/promises";
import videoIntelligence from "@google-cloud/video-intelligence";

const DEFAULT_FEATURES = ["SHOT_CHANGE_DETECTION", "OBJECT_TRACKING"];
const SUPPORTED_FEATURES = new Set([...DEFAULT_FEATURES, "PERSON_DETECTION"]);
const RELEVANT_OBJECT = /ball|football|soccer|person|player|athlete|goal/i;
let client;

export function videoIntelligenceEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.VIDEO_INTELLIGENCE_ENABLED || ""));
}

export function configuredVideoIntelligenceFeatures() {
  const requested = String(process.env.VIDEO_INTELLIGENCE_FEATURES || DEFAULT_FEATURES.join(","))
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => SUPPORTED_FEATURES.has(value));
  return requested.length ? [...new Set(requested)] : DEFAULT_FEATURES;
}

export async function analyzeVideoIntelligenceFile(path, sourceOffset = 0) {
  const inputContent = await readFile(path);
  const features = configuredVideoIntelligenceFeatures();
  const [operation] = await getClient().annotateVideo({
    inputContent,
    features,
    locationId: process.env.VIDEO_INTELLIGENCE_LOCATION || "us-east1",
    videoContext: features.includes("PERSON_DETECTION") ? {
      personDetectionConfig: {
        includeBoundingBoxes: true,
        includeAttributes: false,
        includePoseLandmarks: false,
      },
    } : undefined,
  });
  const [response] = await operation.promise();
  const result = response.annotationResults?.[0];
  if (!result) throw new Error("Video Intelligence returned no annotation results.");
  if (result.error?.message) throw new Error(result.error.message);

  const shots = (result.shotAnnotations || []).map((shot) => ({
    startTime: sourceOffset + durationToSeconds(shot.startTimeOffset),
    endTime: sourceOffset + durationToSeconds(shot.endTimeOffset),
  })).filter((shot) => shot.endTime > shot.startTime);

  const objectTracks = (result.objectAnnotations || [])
    .map((track) => normalizeObjectTrack(track, sourceOffset))
    .filter((track) => track.confidence >= 0.25 && RELEVANT_OBJECT.test(track.label) && track.samples.length)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 80);

  const personTracks = (result.personDetectionAnnotations || [])
    .flatMap((annotation) => annotation.tracks || [])
    .map((track) => normalizePersonTrack(track, sourceOffset))
    .filter((track) => track.confidence >= 0.2 && track.samples.length)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 40);

  const labels = {};
  for (const track of objectTracks) labels[track.label] = (labels[track.label] || 0) + 1;
  return {
    shots,
    objectTracks,
    personTracks,
    summary: {
      features,
      shotCount: shots.length,
      objectTrackCount: objectTracks.length,
      personTrackCount: personTracks.length,
      labels,
    },
  };
}

export function enrichMomentsWithVideoIntelligence(moments, evidence) {
  if (!evidence) return moments;
  return moments.map((moment) => {
    const ballSamples = samplesDuring(
      evidence.objectTracks.filter((track) => /ball|football|soccer/i.test(track.label)),
      moment.startTime,
      moment.endTime,
    );
    const personSamples = samplesDuring(
      [...evidence.objectTracks.filter((track) => /person|player|athlete/i.test(track.label)), ...evidence.personTracks],
      moment.startTime,
      moment.endTime,
    );
    const focusSamples = ballSamples.length ? ballSamples : personSamples;
    const focusX = focusSamples.length ? median(focusSamples.map((sample) => sample.x)) : moment.focusX;
    const overlappingShots = evidence.shots.filter((shot) => shot.startTime < moment.endTime && shot.endTime > moment.startTime).length;
    return {
      ...moment,
      focusX,
      ballVisible: moment.ballVisible || ballSamples.length > 0,
      mainPlayerVisible: moment.mainPlayerVisible || personSamples.length > 0,
      videoIntelligence: {
        ballSamples: ballSamples.length,
        personSamples: personSamples.length,
        shotCount: overlappingShots,
      },
    };
  });
}

export function compactVideoIntelligenceEvidence(evidence) {
  if (!evidence) return null;
  return {
    shots: evidence.shots.slice(0, 160),
    objectTracks: evidence.objectTracks.slice(0, 16).map(compactTrack),
    personTracks: evidence.personTracks.slice(0, 8).map(compactTrack),
    summary: evidence.summary,
  };
}

export async function verifyVideoIntelligenceConnection() {
  const currentClient = getClient();
  const projectId = await currentClient.getProjectId();
  await currentClient.initialize();
  return {
    projectId,
    location: process.env.VIDEO_INTELLIGENCE_LOCATION || "us-east1",
    features: configuredVideoIntelligenceFeatures(),
  };
}

function getClient() {
  if (!client) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT is required for Video Intelligence.");
    client = new videoIntelligence.v1.VideoIntelligenceServiceClient({ projectId });
  }
  return client;
}

function normalizeObjectTrack(track, sourceOffset) {
  const frames = sampleFrames(track.frames || [], sourceOffset, (frame) => frame.normalizedBoundingBox);
  return {
    label: String(track.entity?.description || "object").toLowerCase(),
    confidence: Number(track.confidence || 0),
    startTime: sourceOffset + durationToSeconds(track.segment?.startTimeOffset),
    endTime: sourceOffset + durationToSeconds(track.segment?.endTimeOffset),
    samples: frames,
  };
}

function normalizePersonTrack(track, sourceOffset) {
  return {
    label: "person",
    confidence: Number(track.confidence || 0),
    startTime: sourceOffset + durationToSeconds(track.segment?.startTimeOffset),
    endTime: sourceOffset + durationToSeconds(track.segment?.endTimeOffset),
    samples: sampleFrames(track.timestampedObjects || [], sourceOffset, (frame) => frame.normalizedBoundingBox),
  };
}

function sampleFrames(frames, sourceOffset, getBox) {
  if (!frames.length) return [];
  const step = Math.max(1, Math.ceil(frames.length / 12));
  return frames.filter((_, index) => index % step === 0 || index === frames.length - 1).map((frame) => {
    const box = getBox(frame) || {};
    const left = Number(box.left || 0);
    const right = Number(box.right || left);
    const top = Number(box.top || 0);
    const bottom = Number(box.bottom || top);
    return {
      time: sourceOffset + durationToSeconds(frame.timeOffset),
      x: clamp((left + right) / 2, 0, 1),
      y: clamp((top + bottom) / 2, 0, 1),
      width: clamp(right - left, 0, 1),
      height: clamp(bottom - top, 0, 1),
    };
  });
}

function samplesDuring(tracks, startTime, endTime) {
  return tracks.flatMap((track) => track.samples.filter((sample) => sample.time >= startTime && sample.time <= endTime));
}

function compactTrack(track) {
  const step = Math.max(1, Math.ceil(track.samples.length / 6));
  return {
    ...track,
    samples: track.samples.filter((_, index) => index % step === 0 || index === track.samples.length - 1).slice(0, 7),
  };
}

function durationToSeconds(duration) {
  if (!duration) return 0;
  return Number(duration.seconds?.toString?.() ?? duration.seconds ?? 0) + Number(duration.nanos || 0) / 1e9;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0.5;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
