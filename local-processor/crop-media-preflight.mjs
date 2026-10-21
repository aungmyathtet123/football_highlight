// Check the file, not a model's opinion of its length. A truncated render must
// never be sent for visual approval as though it contained the locked scene.
export function cropMediaPreflight(scene, media, fps=12) {
  const expected=Number(scene.endTime)-Number(scene.startTime);
  const actual=Number(media?.duration);
  const tolerance=Math.max(.1,2/Math.max(1,Number(fps)||12));
  if(!Number.isFinite(expected)||expected<=0)return {usable:false,issue:'invalid_locked_scene_clock'};
  if(!Number.isFinite(actual)||actual<=0||!(media.width>0&&media.height>0))
    return {usable:false,issue:'invalid_rendered_crop_media',expectedDuration:expected};
  return {usable:Math.abs(actual-expected)<=tolerance,
    ...(Math.abs(actual-expected)>tolerance?{issue:'rendered_crop_duration_mismatch'}:{}),
    expectedDuration:expected,actualDuration:actual,tolerance};
}
