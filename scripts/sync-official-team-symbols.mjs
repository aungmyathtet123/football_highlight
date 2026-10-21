// Rasterize the reviewed official federation symbols during asset preparation,
// not inside a video worker. Runtime rendering needs no SVG/network dependency.
import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const directory=resolve('assets/team-badges');
const sources=JSON.parse(await readFile(resolve(directory,'official-sources.json'),'utf8'));
for(const team of sources.teams){
  const response=await fetch(team.imageUrl,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(`Official symbol HTTP ${response.status}`);
  const svg=Buffer.from(await response.arrayBuffer());
  if(svg.length>200000)throw new Error('Unexpected official symbol size');
  const png=await sharp(svg).resize({width:160,height:160,fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
  await writeFile(resolve(directory,team.file),png);
  console.log(JSON.stringify({name:team.name,source:team.imageUrl,bytes:png.length}));
}
