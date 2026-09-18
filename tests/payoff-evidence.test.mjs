import test from "node:test";
import assert from "node:assert/strict";
import { normalizePayoffEvidence, verifiedPayoffWindow } from "../local-processor/payoff-evidence.mjs";
const evidence = { verified: true, eventType: "goal", startTime: 12, endTime: 13.2, targetBox: [.5,.2,.6,.7] };
const moment = { eventType: "goal", startTime: 10, endTime: 15, trackingBrief: { payoffEvidence: evidence } };
const tracked = { keyframes: Array.from({length: 13}, (_, i) => ({time: 2+i/10, cropBox:[.4,0,.7,1], directBall:true, ballInFrame:true, ballConfidence:.7})) };
test("a goal label and guessed time cannot create a payoff cue", () => {
  assert.equal(verifiedPayoffWindow({...moment,trackingBrief:{payoffStartTime:12}}, tracked), null);
});
test("walking players and predicted balls cannot verify a goal cue", () => {
  for (const property of ["directBall", "ballInFrame"]) {
    assert.equal(verifiedPayoffWindow(moment, {keyframes:tracked.keyframes.map(f=>({...f,[property]:false}))}), null);
  }
});
test("goal outside final crop cannot trigger a goal cue", () => {
  assert.equal(verifiedPayoffWindow(moment,{keyframes:tracked.keyframes.map(f=>({...f,cropBox:[.1,0,.4,1]}))}), null);
});
test("verified visible payoff is retimed with slow motion and freeze", () => {
  assert.deepEqual(verifiedPayoffWindow(moment,tracked,.5,{duration:.8,outputTime:1}),{start:4.8,end:5.8,verified:true});
});
test("invalid rectangles or timestamps are not evidence", () => {
  assert.equal(normalizePayoffEvidence({...evidence,startTime:null},"goal",10,15),null);
  assert.equal(normalizePayoffEvidence({...evidence,targetBox:[.6,0,.5,1]},"goal",10,15),null);
});
test("cuts and sparse frames cannot form a continuous proof interval", () => {
  assert.equal(verifiedPayoffWindow(moment,{keyframes:tracked.keyframes.filter((_,i)=>i%3===0)}),null);
  assert.equal(verifiedPayoffWindow(moment,{keyframes:tracked.keyframes.map(f=>({...f,sceneCut:true}))}),null);
});
