#!/usr/bin/env node
'use strict';
const fs=require('fs'), path=require('path'), yaml=require('js-yaml');
const src=path.resolve(process.argv[2]||'mihomo/bootstrap.yaml');
const dest=path.resolve(process.argv[3]||'mihomo/config.yaml');
const PORT=Number(process.env.MIHOMO_PORT||7890);
const TARGET=process.env.WULA_HEALTH_URL||'https://wulass.org/api/v1/guest/comm/config';
const doc=yaml.load(fs.readFileSync(src,'utf8'));
const proxies=Array.isArray(doc?.proxies)?doc.proxies.filter(p=>p&&p.name&&p.server&&p.port&&p.type):[];
if(!proxies.length) throw new Error('bootstrap 里没有可用节点');
const config={
  'mixed-port':PORT,'allow-lan':false,'external-controller':'127.0.0.1:9090',mode:'rule','log-level':'info',ipv6:false,'unified-delay':true,
  proxies,
  'proxy-groups':[{name:'WULA_AUTO',type:'url-test',url:TARGET,interval:20,tolerance:80,timeout:8000,lazy:false,proxies:proxies.map(p=>p.name)}],
  rules:['MATCH,WULA_AUTO']
};
fs.mkdirSync(path.dirname(dest),{recursive:true});
fs.writeFileSync(dest,yaml.dump(config,{lineWidth:-1,noRefs:true}));
console.log(`Generated ${dest}: ${proxies.length} nodes, health target=${TARGET}`);
