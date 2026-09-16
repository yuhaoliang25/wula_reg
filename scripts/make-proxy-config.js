#!/usr/bin/env node
'use strict';
/**
 * 把已提交的订阅 (sub.yaml) 转成 GitHub Actions 专用的 mihomo 配置。
 *
 * CI 不使用订阅的“自动选择”，固定使用名为“官网：wulavpn.com”的节点。
 * 不做 wulass.org 预探测，实际请求直接交给这个节点。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const src = path.resolve(process.argv[2] || 'sub.yaml');
const dest = path.resolve(process.argv[3] || 'mihomo/config.yaml');
const PORT = Number(process.env.MIHOMO_PORT || 7890);
const FIXED_PROXY = '官网：wulavpn.com';

if (!fs.existsSync(src)) {
  console.error(`找不到订阅文件: ${src}`);
  process.exit(1);
}

let doc;
try {
  doc = yaml.load(fs.readFileSync(src, 'utf8'));
} catch (e) {
  console.error(`订阅不是合法 YAML: ${e.message}`);
  process.exit(1);
}

const proxies = (doc && doc.proxies ? doc.proxies : []).filter((p) => p && p.name && p.server);
if (!proxies.length) {
  console.error('订阅里没有可用的 proxies');
  process.exit(1);
}

const fixedProxy = proxies.find((p) => p.name === FIXED_PROXY);
if (!fixedProxy) {
  console.error(`订阅里找不到固定节点: ${FIXED_PROXY}`);
  console.error(`当前节点示例: ${proxies.slice(0, 10).map((p) => p.name).join(' | ')}`);
  process.exit(1);
}

const config = {
  'mixed-port': PORT,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'info',
  ipv6: false,
  ...(doc.dns ? { dns: doc.dns } : {}),
  proxies,
  'proxy-groups': [
    {
      name: 'CI_FIXED_PROXY',
      type: 'select',
      proxies: [fixedProxy.name],
    },
  ],
  rules: ['MATCH,CI_FIXED_PROXY'],
};

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, yaml.dump(config, { lineWidth: -1 }));

console.log(`已生成 ${path.relative(process.cwd(), dest)}: 固定节点 ${fixedProxy.name}, 端口 ${PORT}`);
