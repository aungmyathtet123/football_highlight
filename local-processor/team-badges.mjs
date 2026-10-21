import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const catalogUrl=new URL('../assets/team-badges/fotmob-catalog.json',import.meta.url);
const officialSourcesUrl=new URL('../assets/team-badges/official-sources.json',import.meta.url);
export function normalizedBadgeTeamName(value){return String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
export function findFotmobTeam(name,teams){const key=normalizedBadgeTeamName(name);
  if(!key)return null;const matches=(teams||[]).filter(team=>normalizedBadgeTeamName(team.slug)===key);
  return matches.length===1?matches[0]:null;}
export function fotmobTeamCandidates(name,teams){
  // Men's and women's teams may share a sitemap slug. Resolve by the full
  // page identity (including W/U21 suffixes), never by the first search hit.
  const key=normalizedBadgeTeamName(String(name||'').replace(/\s*\(W\)\s*$/i,''));
  return key?(teams||[]).filter(team=>normalizedBadgeTeamName(team.slug)===key).slice(0,6):[];
}
export function verifiedFotmobTeamDetails(html,team,name){
  try{const data=JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1]||'{}');
    const details=data.props?.pageProps?.fallback?.[`team-${team.id}`]?.details;
    if(Number(details?.id)!==team.id||details.type!=='team'||normalizedBadgeTeamName(details.name)!==normalizedBadgeTeamName(name))return null;
    return {id:team.id,name:details.name,gender:details.gender||null};
  }catch{return null;}}
export function badgePngIsUsable(bytes){return Buffer.isBuffer(bytes)&&bytes.length>=45&&bytes.length<=1048576
  &&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.toString('ascii',12,16)==='IHDR'
  &&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(16)<=1024&&bytes.readUInt32BE(20)>0&&bytes.readUInt32BE(20)<=1024
  &&bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND';}
async function boundedResponse(url,fetchImpl,limit){const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{'User-Agent':'TouchlineAI/1.0 team-badge-verifier'}});
  if(!response.ok)throw new Error(`Badge source HTTP ${response.status}`);
  if(Number(response.headers.get('content-length')||0)>limit)throw new Error('Badge source too large');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('Badge source too large');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks);}

export function secondaryBadgeLeagues(context){const competition=String(context?.competition||'').toLowerCase();
  if(/women|female/.test(competition))return /world cup/.test(competition)?['fifa.wwc']:[];
  if(/nations league/.test(competition))return ['uefa.nations','fifa.world'];
  if(/world cup|international|euro\b/.test(competition))return ['fifa.world','uefa.euro'];
  for(const [pattern,leagues] of [[/premier league|fa cup|efl cup/,['eng.1','eng.2']],
    [/championship/,['eng.2','eng.1']],[/la liga/,['esp.1']],[/bundesliga/,['ger.1']],
    [/ligue 1/,['fra.1']],[/serie a/,['ita.1']],[/champions league/,['uefa.champions']]])
    if(pattern.test(competition))return leagues;
  return [];
}
export function exactSecondaryBadgeTeam(data,name){const teams=data?.sports?.[0]?.leagues?.[0]?.teams||[];
  const matched=teams.map(entry=>entry.team).filter(team=>normalizedBadgeTeamName(team?.displayName)===normalizedBadgeTeamName(name));
  if(matched.length!==1)return null;
  const team=matched[0];
  const imageUrl=team.logos?.find(logo=>logo.rel?.includes('default'))?.href;
  const pageUrl=team.links?.find(link=>link.rel?.includes('clubhouse'))?.href;
  if(!/^\d{1,10}$/.test(String(team.id))||!/^https:\/\/a\.espncdn\.com\/i\/teamlogos\/(?:countries|soccer)\/500\/[a-z0-9_-]+\.png$/i.test(imageUrl||'')
    ||!/^https:\/\/www\.espn\.com\/soccer\/(?:team|club)\/_\/id\/\d+\//.test(pageUrl||''))return null;
  return {id:String(team.id),name:team.displayName,imageUrl,pageUrl,provider:'espn'};
}

// Exact identity precedes display. Try verified alternate sources instead of
// silently dropping a badge after the first provider fails. Save unresolved
// identity explicitly if every source is unavailable; never substitute a guess.
export async function prepareMatchTeamBadges(context,directory,{fetchImpl=fetch,teams=null,secondary=true,official=true}={}){
  if(context?.status!=='verified')return {home:null,away:null};
  try{teams ||= JSON.parse(await readFile(catalogUrl,'utf8')).teams;}catch{teams=[];}
  await mkdir(directory,{recursive:true});
  async function cachedOrDownload(saved,key){const path=join(directory,`${key}.png`),metadataPath=join(directory,`${key}.json`);
    try{const bytes=await readFile(path),cached=JSON.parse(await readFile(metadataPath,'utf8'));
      if(cached.id===saved.id&&normalizedBadgeTeamName(cached.name)===normalizedBadgeTeamName(saved.name)
        &&cached.pageUrl===saved.pageUrl&&cached.imageUrl===saved.imageUrl&&badgePngIsUsable(bytes)
        &&cached.sha256===createHash('sha256').update(bytes).digest('hex'))return {...cached,path};
    }catch{}
    const bytes=await boundedResponse(saved.imageUrl,fetchImpl,1048576);if(!badgePngIsUsable(bytes))return null;
    saved={...saved,sha256:createHash('sha256').update(bytes).digest('hex')};
    await writeFile(path,bytes);await writeFile(metadataPath,JSON.stringify(saved,null,2));return {...saved,path};
  }
  async function loadFotmob(name){try{
    const candidates=fotmobTeamCandidates(name,teams);const identities=[];
    // Inspect all exact cached candidates first. A women's sitemap entry
    // appearing before the approved men's entry must not cause a network call.
    for(const team of candidates){if(!Number.isSafeInteger(team.id)||team.id<=0)continue;
      try{const path=join(directory,`${team.id}.png`),bytes=await readFile(path),saved=JSON.parse(await readFile(join(directory,`${team.id}.json`),'utf8'));
        if(saved.id===team.id&&normalizedBadgeTeamName(saved.name)===normalizedBadgeTeamName(name)
          &&saved.pageUrl===`https://www.fotmob.com/teams/${team.id}/overview/${encodeURIComponent(team.slug)}`
          &&saved.imageUrl===`https://images.fotmob.com/image_resources/logo/teamlogo/${team.id}.png`
          &&badgePngIsUsable(bytes)&&saved.sha256===createHash('sha256').update(bytes).digest('hex'))return {...saved,path};
      }catch{}
    }
    for(const team of candidates){if(!Number.isSafeInteger(team.id)||team.id<=0)continue;
    const pageUrl=`https://www.fotmob.com/teams/${team.id}/overview/${encodeURIComponent(team.slug)}`;
    const imageUrl=`https://images.fotmob.com/image_resources/logo/teamlogo/${team.id}.png`;
    const path=join(directory,`${team.id}.png`),metadataPath=join(directory,`${team.id}.json`);
    try{const bytes=await readFile(path),saved=JSON.parse(await readFile(metadataPath,'utf8'));
      if(saved.id===team.id&&normalizedBadgeTeamName(saved.name)===normalizedBadgeTeamName(name)
        &&saved.pageUrl===pageUrl&&saved.imageUrl===imageUrl&&badgePngIsUsable(bytes)
        &&saved.sha256===createHash('sha256').update(bytes).digest('hex'))return {...saved,path};
    }catch{}
    try{const html=(await boundedResponse(pageUrl,fetchImpl,3000000)).toString('utf8');
      const identity=verifiedFotmobTeamDetails(html,team,name);if(identity)identities.push({...identity,pageUrl,imageUrl,provider:'fotmob'});
    }catch{}
    }
    if(identities.length!==1)return null;
    return await cachedOrDownload(identities[0],String(identities[0].id));
  }catch{return null;}}
  const secondaryResponses=new Map();
  async function loadSecondary(name){if(!secondary)return null;
    for(const league of secondaryBadgeLeagues(context))try{
      if(!secondaryResponses.has(league))secondaryResponses.set(league,boundedResponse(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams?limit=1000`,fetchImpl,2000000).then(bytes=>JSON.parse(bytes.toString('utf8'))));
      const identity=exactSecondaryBadgeTeam(await secondaryResponses.get(league),name);
      if(identity)return await cachedOrDownload(identity,`espn-${identity.id}`);
    }catch{}
    return null;
  }
  async function loadOfficial(name){if(!official)return null;
    try{const sources=JSON.parse(await readFile(officialSourcesUrl,'utf8')).teams;
      const matches=sources.filter(source=>normalizedBadgeTeamName(source.name)===normalizedBadgeTeamName(name));
      if(matches.length!==1||!/^official-[a-z-]+\.png$/.test(matches[0].file))return null;
      const source=matches[0],bytes=await readFile(new URL(`../assets/team-badges/${source.file}`,import.meta.url));
      if(!badgePngIsUsable(bytes))return null;
      const path=join(directory,source.file);await writeFile(path,bytes);
      return {...source,path,sha256:createHash('sha256').update(bytes).digest('hex')};
    }catch{return null;}}
  async function load(name){return await loadFotmob(name)||await loadOfficial(name)||await loadSecondary(name);}
  const [home,away]=await Promise.all([load(context.homeTeam),load(context.awayTeam)]);
  await writeFile(join(directory,'resolution.json'),JSON.stringify({home,away,unresolved:[!home&&context.homeTeam,!away&&context.awayTeam].filter(Boolean)},null,2));
  return {home,away};
}
