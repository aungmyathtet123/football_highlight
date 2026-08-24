import type { EditSettings, FootballMoment, OverlayMask } from "./types";

export type RenderSegment = {
  sourceStart: number;
  sourceEnd: number;
  crop: { width: 1080; height: 1920; focusX: number; focusY: number };
  audioGain: number;
  commentary?: string;
  effects: Array<"dynamic_crop" | "highlight" | "caption" | "freeze" | "zoom" | "overlay_blur">;
  masks: OverlayMask[];
};

export function createRenderPlan(moments: FootballMoment[], settings: EditSettings, detectedMasks: OverlayMask[] = []): RenderSegment[] {
  return moments.filter((moment) => moment.selectedForFinalVideo).sort((a, b) => a.startTime - b.startTime).map((moment) => {
    const focus = moment.recommendedCrop[Math.floor(moment.recommendedCrop.length / 2)] ?? { x: 0.5, y: 0.5 };
    const effects: RenderSegment["effects"] = ["dynamic_crop"];
    if (settings.playerHighlight && moment.mainPlayerVisible) effects.push("highlight");
    if (settings.captions && settings.commentary && moment.commentary) effects.push("caption");
    const masks = settings.logoMasking ? detectedMasks.filter((mask) => mask.confidence >= 0.72 && mask.firstSeen < moment.endTime && mask.lastSeen > moment.startTime) : [];
    if (masks.length > 0) effects.push("overlay_blur");
    if (settings.intensity !== "natural" && ["goal", "save", "big_chance"].includes(moment.eventType)) effects.push("zoom");
    return { sourceStart: moment.startTime, sourceEnd: moment.endTime, crop: { width: 1080, height: 1920, focusX: focus.x, focusY: focus.y }, audioGain: settings.originalAudio === "muted" ? 0 : settings.originalAudio === "reduced" ? 0.28 : 1, commentary: settings.commentary ? moment.commentary : undefined, effects, masks };
  });
}
