// Refresh the public team-page index, not FotMob's private/disallowed API.
// Generated metadata contains identities/URLs only; badges are fetched on use.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const index='https://www.fotmob.com/sitemap/en/teams.xml';
async function get(url){const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`FotMob index HTTP ${response.status}`);
  const text=await response.text();if(text.length>4000000)throw new Error('Unexpectedly large team index');return text;}
const xml=await get(index);
const pages=[...xml.matchAll(/<loc>(https:\/\/www\.fotmob\.com\/sitemap\/en\/teams\/\d+\.xml)<\/loc>/g)].map(match=>match[1]);
if(!pages.length||pages.length>30)throw new Error('Team sitemap index is not recognized');
const teams=new Map();
for(let offset=0;offset<pages.length;offset+=3){const batch=await Promise.all(pages.slice(offset,offset+3).map(get));
  for(const text of batch)for(const match of text.matchAll(/<loc>(https:\/\/www\.fotmob\.com\/teams\/(\d+)\/overview\/([^<]+))<\/loc>/g)){
    const id=Number(match[2]);teams.set(id,{id,slug:decodeURIComponent(match[3]),pageUrl:match[1]});}}
if(teams.size<100)throw new Error('Refusing to replace catalog with an incomplete index');
const destination=resolve('assets/team-badges/fotmob-catalog.json');await mkdir(dirname(destination),{recursive:true});
await writeFile(destination,JSON.stringify({version:1,source:index,updatedAt:new Date().toISOString(),teams:[...teams.values()].sort((a,b)=>a.id-b.id)},null,2)+'\n');
console.log(JSON.stringify({destination,teams:teams.size,pages:pages.length}));
