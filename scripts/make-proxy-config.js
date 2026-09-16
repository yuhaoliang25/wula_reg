#!/usr/bin/env node
'use strict';
/**
 * 把已提交的订阅 (sub.yaml) 转成一份“只用来当本地代理”的 mihomo 配置。
 *
 * 用法: node scripts/make-proxy-config.js [输入 sub.yaml] [输出 config.yaml]
 *
 * 订阅本身已经包含代理策略组（例如“乌拉VPN”→“自动选择”）。
 * 这里保留订阅里的 proxies 和 proxy-groups，只把 rules 收敛为
 * MATCH → 订阅原有的主策略组，避免原订阅中的 DIRECT / GEOIP,CN
 * 规则让 wulass.org 绕过代理。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const src = path.resolve(process.argv[2] || 'sub.yaml');
const dest = path.resolve(process.argv[3] || 'mihomo/config.yaml');
const PORT = Number(process.env.MIHOMO_PORT || 7890);

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

const groups = Array.isArray(doc['proxy-groups']) ? doc['proxy-groups'] : [];
if (!groups.length) {
  console.error('订阅里没有 proxy-groups，无法使用订阅自带的策略。');
  process.exit(1);
}

// 优先使用订阅的主策略组“乌拉VPN”；该组当前包含“自动选择”，
// 因此会继续使用订阅自己的自动选择策略，而不是人为指定第一个节点。
let mainGroup = groups.find((g) => g && g.name === '乌拉VPN');
if (!mainGroup) mainGroup = groups.find((g) => g && g.name === '自动选择');
if (!mainGroup) mainGroup = groups.find((g) => g && g.name);

if (!mainGroup || !mainGroup.name) {
  console.error('找不到可用的主策略组。');
  process.exit(1);
}

const config = {
  'mixed-port': PORT,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'info',
  ipv6: false,
  // 保留订阅 DNS 配置，避免改变原订阅的解析策略。
  ...(doc.dns ? { dns: doc.dns } : {}),
  proxies,
  // 完整保留订阅自己的策略组，包括“自动选择”。
  'proxy-groups': groups,
  // CI 中所有请求都必须经过订阅自己的主策略组。
  rules: [`MATCH,${mainGroup.name}`],
};

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, yaml.dump(config, { lineWidth: -1 }));

console.log(`已生成 ${path.relative(process.cwd(), dest)}: ${proxies.length} 个节点, 主策略 ${mainGroup.name}, 端口 ${PORT}`);
