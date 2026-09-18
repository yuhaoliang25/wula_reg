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

function normalizePort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

// Keep the bootstrap pool conservative: one malformed proxy can prevent
// Mihomo from parsing the whole config, so reject known-invalid entries
// before they ever reach Mihomo.
function sanitizeProxy(raw) {
  if (!raw || typeof raw !== 'object') return { proxy: null, reason: 'not-object' };
  if (!raw.name || !raw.type || !raw.server) return { proxy: null, reason: 'missing-basic-fields' };

  const port = normalizePort(raw.port);
  if (port == null) return { proxy: null, reason: 'invalid-port' };

  const p = { ...raw, port };
  const type = String(p.type).toLowerCase();

  if (['vless', 'vmess'].includes(type) && typeof p.uuid !== 'string') {
    return { proxy: null, reason: `${type}-missing-uuid` };
  }
  if (type === 'trojan' && typeof p.password !== 'string') {
    return { proxy: null, reason: 'trojan-missing-password' };
  }
  if (type === 'ss' && (typeof p.cipher !== 'string' || typeof p.password !== 'string')) {
    return { proxy: null, reason: 'ss-missing-auth' };
  }

  if (p['reality-opts'] != null && !['vless', 'vmess', 'trojan'].includes(type)) {
    return { proxy: null, reason: 'reality-unsupported-protocol' };
  }

  if (p['reality-opts'] != null) {
    const reality = p['reality-opts'];
    if (!reality || typeof reality !== 'object' || Array.isArray(reality)) {
      return { proxy: null, reason: 'invalid-reality-opts' };
    }

    if (typeof reality['public-key'] !== 'string' || !reality['public-key'].trim()) {
      return { proxy: null, reason: 'reality-missing-public-key' };
    }

    const shortId = reality['short-id'];
    // Mihomo expects a REALITY short ID, not arbitrary text/arrays.
    // Server short IDs are hex and are represented as byte pairs.
    if (
      typeof shortId !== 'string' ||
      !/^[0-9a-fA-F]{2,16}$/.test(shortId) ||
      shortId.length % 2 !== 0
    ) {
      return { proxy: null, reason: 'invalid-reality-short-id' };
    }
  }

  return { proxy: p, reason: null };
}

function parse(text, sourceLabel) {
  const doc = yaml.load(text);
  const raw = Array.isArray(doc?.proxies) ? doc.proxies : [];
  const kept = [];
  const dropped = new Map();

  for (const item of raw) {
    const { proxy, reason } = sanitizeProxy(item);
    if (proxy) {
      kept.push(proxy);
    } else {
      dropped.set(reason, (dropped.get(reason) || 0) + 1);
    }
  }

  if (dropped.size) {
    const summary = [...dropped.entries()]
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    console.log(`⚠ ${sourceLabel}: filtered ${raw.length - kept.length} invalid nodes (${summary})`);
  }

  return kept;
}

function key(p) {
  return JSON.stringify({
    type: p.type,
    server: p.server,
    port: p.port,
    uuid: p.uuid,
    password: p.password,
    cipher: p.cipher,
    sni: p.sni,
    network: p.network,
    reality: p['reality-opts'],
  });
}

(async () => {
  const merged = [];
  const seen = new Set();

  const add = (proxies, tag) => proxies.forEach((p, i) => {
    const k = key(p);
    if (seen.has(k)) return;
    seen.add(k);
    merged.push({
      ...p,
      name: `${String(p.name).slice(0, 180)} | src-${tag}-${i + 1}`,
    });
  });

  for (let i = 0; i < SOURCES.length; i++) {
    try {
      const p = parse(await download(SOURCES[i]), `source ${i + 1}`);
      add(p, i + 1);
      console.log(`✓ source ${i + 1}: ${p.length} valid nodes`);
    } catch (e) {
      console.log(`⚠ source ${i + 1} unavailable: ${e.message}`);
    }
  }

  if (fs.existsSync(LOCAL_FALLBACK) && fs.statSync(LOCAL_FALLBACK).size > 1000) {
    try {
      const p = parse(fs.readFileSync(LOCAL_FALLBACK, 'utf8'), 'local fallback');
      add(p, 'local');
      console.log(`✓ local fallback: ${p.length} valid nodes`);
    } catch (e) {
      console.log(`⚠ local fallback invalid: ${e.message}`);
    }
  }

  if (!merged.length) throw new Error('没有任何通过 Mihomo 基础校验的 bootstrap 节点');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    yaml.dump({
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: false,
      proxies: merged,
    }, { lineWidth: -1, noRefs: true })
  );
  console.log(`Bootstrap pool: ${merged.length} unique valid nodes -> ${OUT}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
