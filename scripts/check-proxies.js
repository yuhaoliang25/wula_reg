#!/usr/bin/env node
'use strict';

const fs = require('fs');

const API = process.env.MIHOMO_API || 'http://127.0.0.1:9090';
const GROUP = process.env.MIHOMO_GROUP || 'WULA_AUTO';
const TARGET = process.env.WULA_HEALTH_URL || 'https://wulass.org/api/v1/guest/comm/config';
const TIMEOUT = Number(process.env.WULA_HEALTH_TIMEOUT || 8000);
const EXPECTED = process.env.WULA_EXPECTED_STATUS || '200';
const REPORT = process.env.WULA_HEALTH_REPORT || 'mihomo/health-report.json';

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function main() {
  const params = new URLSearchParams({
    url: TARGET,
    timeout: String(TIMEOUT),
    expected: EXPECTED,
  });
  const endpoint = `${API}/group/${encodeURIComponent(GROUP)}/delay?${params}`;

  console.log(`开始逐节点健康检查：${GROUP}`);
  console.log(`目标：${TARGET}`);
  console.log(`超时：${TIMEOUT}ms，期望 HTTP：${EXPECTED}`);

  const results = await getJson(endpoint);
  const entries = Object.entries(results)
    .map(([name, delay]) => ({ name, delay: Number(delay) }))
    .sort((a, b) => {
      const av = a.delay > 0 ? a.delay : Number.POSITIVE_INFINITY;
      const bv = b.delay > 0 ? b.delay : Number.POSITIVE_INFINITY;
      return av - bv;
    });

  const alive = entries.filter(x => Number.isFinite(x.delay) && x.delay > 0);
  const dead = entries.filter(x => !Number.isFinite(x.delay) || x.delay <= 0);

  console.log(`总节点：${entries.length}`);
  console.log(`可用节点：${alive.length}`);
  console.log(`失败节点：${dead.length}`);

  for (const item of entries.slice(0, 20)) {
    console.log(`${item.delay > 0 ? '✓' : '✗'} ${item.name}: ${item.delay > 0 ? item.delay + 'ms' : 'failed'}`);
  }
  if (entries.length > 20) console.log(`... 其余 ${entries.length - 20} 个节点已写入报告`);

  const report = {
    generatedAt: new Date().toISOString(),
    target: TARGET,
    timeout: TIMEOUT,
    expectedStatus: EXPECTED,
    total: entries.length,
    alive: alive.length,
    dead: dead.length,
    results: entries,
  };
  fs.mkdirSync(require('path').dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  if (!alive.length) {
    throw new Error('没有任何节点通过 Wulass 健康检查');
  }

  const fastest = alive[0];
  const selectRes = await fetch(`${API}/proxies/${encodeURIComponent(GROUP)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: fastest.name }),
  });
  if (!selectRes.ok) {
    throw new Error(`选择最快节点失败：HTTP ${selectRes.status}`);
  }

  console.log(`✓ 已选择最快节点：${fastest.name} (${fastest.delay}ms)`);
}

main().catch(err => {
  console.error(`::error::健康检查失败：${err.message}`);
  process.exit(1);
});
