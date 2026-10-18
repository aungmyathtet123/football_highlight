import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export async function recomposeNativeCamera({scene,evidence,media,dimensions,strategy,directory,python,run}) {
  await mkdir(directory,{recursive:true});
  const key=randomUUID(),input=join(directory,`actor-${key}.input.json`),output=join(directory,`actor-${key}.output.json`);
  try {
    await writeFile(input,JSON.stringify({scene,evidence,media,width:dimensions.width,height:dimensions.height,strategy}));
    await run(python,[fileURLToPath(new URL('./action-camera-subject.py',import.meta.url)),
      '--input',input,'--output',output]);
    return JSON.parse(await readFile(output,'utf8'));
  } finally {await Promise.all([input,output].map(path=>rm(path,{force:true}).catch(()=>{})));}
}
