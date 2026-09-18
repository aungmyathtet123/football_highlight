import test from "node:test";
import assert from "node:assert/strict";
import {trackedPositionExpression} from "../local-processor/tracked-position.mjs";
function valueAt(expression,t){return Function("t","clip","gte",`return ${expression};`)(t,(x,a,b)=>Math.min(b,Math.max(a,x)),(a,b)=>Number(a>=b));}
test("dense camera evidence becomes a sparse stable render path",()=>{
  const frames=Array.from({length:100},(_,i)=>({time:i/10,cameraX:.5+Math.sin(i/3)*.02}));
  const expression=trackedPositionExpression(frames,"cameraX",.5);
  for(const frame of frames) assert.ok(Math.abs(valueAt(expression,frame.time)-frame.cameraX)<=.00601);
  assert.ok(expression.length < 3000);
});
test("collinear camera samples render as one deliberate pan",()=>{
  const frames=Array.from({length:100},(_,i)=>({time:i/10,cameraX:.25+i*.004}));
  const expression=trackedPositionExpression(frames,"cameraX",.5);
  assert.ok(expression.length < 180);
  assert.ok(Math.abs(valueAt(expression,4.95)-.448)<.00001);
});
test("tracking interpolates linearly without stop-start easing",()=>{
  const expression=trackedPositionExpression([{time:0,cameraX:.3},{time:1,cameraX:.7}],"cameraX",.5);
  assert.ok(Math.abs(valueAt(expression,.25)-.4)<.000001);
});
test("source cuts do not pan across unrelated shots",()=>{
  const expression=trackedPositionExpression([{time:0,cameraX:.2},{time:1,cameraX:.8,sceneCut:1}],"cameraX",.5);
  assert.equal(valueAt(expression,.99),.2);
  assert.equal(valueAt(expression,1),.8);
});
test("verified outcome camera cuts do not pan through unrelated space",()=>{
  const expression=trackedPositionExpression([{time:0,cameraX:.2},{time:1,cameraX:.8,cameraCut:1}],"cameraX",.5);
  assert.equal(valueAt(expression,.99),.2);
  assert.equal(valueAt(expression,1),.8);
});
