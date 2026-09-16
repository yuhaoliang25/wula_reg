#!/usr/bin/env node
'use strict';
/**
 * 把已提交的订阅 (sub.yaml) 转成一份“只用来当本地代理”的 mihomo 配置。
 *
 * 用法: node scripts/make-proxy-config.js [输入 sub.yaml] [输出 config.yaml]
 *
 * 这里只取 proxies 列表, 规则改成 MATCH → 代理节点。
 * 不在这里做 URL 健康探测：GitHub Actions 的网络环境可能导致探测目标
 * 本身失败，从而把本来可用的订阅误判成不可用。实际请求直接交给节点。
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

// 使用 select 而不是 url-test：不做 Cloudflare/其它站点的预测速。
// 默认直接使用订阅中的第一个节点；如需指定节点，可通过 MIHOMO_PROXY_NAME。
const selectedName = process.env.MIHOMO_PROXY_NAME || proxies[0].name;
if (!proxies.some((p) => p.name === selectedName)) {
  console.error(`指定的 MIHOMO_PROXY_NAME 不存在: ${selectedName}`);
  process.exit(1);
}

const config = {
  'mixed-port': PORT,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'warning',
  ipv6: false,
  // 关闭内置 DNS，节点连接使用系统解析结果，减少 CI 中的额外变量。
  dns: { enable: false },
  proxies,
  'proxy-groups': [
    {
      name: 'PROXY',
      type: 'select',
      proxies: [selectedName],
    },
  ],
  rules: ['MATCH,PROXY'],
};

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, yaml.dump(config, { lineWidth: -1 }));

console.log(`已生成 ${path.relative(process.cwd(), dest)}: ${proxies.length} 个节点, 当前节点 ${selectedName}, 端口 ${PORT}`);
