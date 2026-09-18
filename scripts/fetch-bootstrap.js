#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const OUT = path.resolve(process.argv[2] || 'mihomo/bootstrap.yaml');
const LOCAL_FALLBACK = path.resolve('sub.yaml');
const SOURCES = [
  'https://raw.githubusercontent.com/mfuu/v2ray/master/clash.yaml',
  'https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/clash.yml',
  'https://raw.githubusercontent.com/ripaojiedian/freenode/main/clash',
];

async function download(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'wula-reg/bootstrap/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}
function parse(text) {
  const doc = yaml.load(text);
  return (Array.isArray(doc?.proxies) ? doc.proxies : [])
    .filter(p => p && typeof p === 'object' && p.name && p.type && p.server && p.port);
}
function key(p) {
  return JSON.stringify({type:p.type,server:p.server,port:p.port,uuid:p.uuid,password:p.password,cipher:p.cipher,sni:p.sni,network:p.network});
}
(async () => {
  const merged=[], seen=new Set();
  const add=(proxies,tag)=>proxies.forEach((p,i)=>{
    const k=key(p); if(seen.has(k)) return;
    seen.add(k); merged.push({...p,name:`${String(p.name).slice(0,180)} | src-${tag}-${i+1}`});
  });
  for(let i=0;i<SOURCES.length;i++){
    try { const p=parse(await download(SOURCES[i])); add(p,i+1); console.log(`✓ source ${i+1}: ${p.length} nodes`); }
    catch(e){ console.log(`⚠ source ${i+1} unavailable: ${e.message}`); }
  }
  if(fs.existsSync(LOCAL_FALLBACK) && fs.statSync(LOCAL_FALLBACK).size>1000){
    try { const p=parse(fs.readFileSync(LOCAL_FALLBACK,'utf8')); add(p,'local'); console.log(`✓ local fallback: ${p.length} nodes`); }
    catch(e){ console.log(`⚠ local fallback invalid: ${e.message}`); }
  }
  if(!merged.length) throw new Error('没有任何 bootstrap 节点');
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT,yaml.dump({'mixed-port':7890,'allow-lan':false,mode:'rule','log-level':'warning',ipv6:false,proxies:merged},{lineWidth:-1,noRefs:true}));
  console.log(`Bootstrap pool: ${merged.length} unique nodes -> ${OUT}`);
})().catch(e=>{console.error(e);process.exit(1);});
