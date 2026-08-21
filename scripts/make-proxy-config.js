#!/usr/bin/env node
'use strict';
/**
 * 把已提交的订阅 (sub.yaml) 转成一份"只用来当本地代理"的 mihomo 配置。
 *
 * 用法: node scripts/make-proxy-config.js [输入 sub.yaml] [输出 config.yaml]
 *
 * 为什么不直接用 sub.yaml:
 *   订阅里自带的 rules 有大量 DIRECT / GEOIP,CN 规则, 会让 wulass.org 直连,
 *   那就白搭了。这里只取 proxies 列表, 规则改成 MATCH → 全部走节点。
 *
 * 机场通常会塞几个"信息节点"(如 "剩余流量：1000 GB"), 它们连不通。
 * 用 url-test 分组做健康检查, mihomo 会自动挑一个真正能用的, 所以不必手动过滤。
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

const config = {
  'mixed-port': PORT,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'warning',
  ipv6: false,
  // 关掉内置 DNS, 直接用系统解析器 —— CI 里的 DNS 本来就是通的, 少一个变数
  dns: { enable: false },
  proxies,
  'proxy-groups': [
    {
      name: 'AUTO',
      type: 'url-test',
      proxies: proxies.map((p) => p.name),
      url: 'http://cp.cloudflare.com/generate_204',
      interval: 60,
      tolerance: 100,
      lazy: false, // 启动就测速, 不等第一个请求
    },
  ],
  rules: ['MATCH,AUTO'],
};

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, yaml.dump(config, { lineWidth: -1 }));

console.log(`已生成 ${path.relative(process.cwd(), dest)}: ${proxies.length} 个节点, 端口 ${PORT}`);
