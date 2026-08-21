#!/usr/bin/env node
'use strict';
/**
 * wulass.org 自动注册 + 订阅刷新
 *
 * 流程:
 *   1. GET  /api/v1/guest/comm/config          → 取出 recaptcha_site_key (站点 key)
 *   2. 无头 Chromium 载入 vendor/cap-widget.js  → 由它完成:
 *        a. POST /{key}/challenge   拿到 80 个 PoW 子挑战 (c=80,s=32,d=4)
 *        b. Web Worker (WASM) 并行爆破 SHA-256 前缀 → solutions
 *        c. 把服务端下发的 instrumentation (base64+deflate-raw) 解压后
 *           丢进 sandbox iframe 执行 → postMessage 回传 instr.state
 *        d. POST /{key}/redeem      → cap token
 *   3. POST /api/v1/passport/auth/register     → 账号 token (随机邮箱/密码)
 *   4. GET  https://windowsv1.com/s/?token=…   → mihomo 订阅内容
 *   5. 校验内容后写入 sub.yaml + sub-info.json
 *
 * 注意: instrumentation 是"多态"的 —— 每次请求下发的混淆代码都不同,
 * 所以必须真的在浏览器里执行, 无法在 Node 里静态复现。
 */

const fs = require('fs');
const path = require('path');
const { chromium, request: pwRequest } = require('playwright');

// ────────────────────────────── 配置 ──────────────────────────────
const BASE = process.env.WULA_BASE || 'https://wulass.org';
const SUB_HOST = process.env.SUB_HOST || 'https://windowsv1.com';
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.resolve(REPO_ROOT, process.env.OUT_FILE || 'sub.yaml');
const INFO_FILE = path.resolve(REPO_ROOT, process.env.INFO_FILE || 'sub-info.json');
const WIDGET_FILE = path.resolve(REPO_ROOT, 'vendor/cap-widget.js');
const ATTEMPTS = Number(process.env.ATTEMPTS || 3);
const SOLVE_TIMEOUT = Number(process.env.SOLVE_TIMEOUT || 180_000);
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'gmail.com';

// 站点会封 GitHub Actions 的机房 IP, 所以 CI 里用 mihomo 起一个本地代理,
// 把浏览器和所有 API 请求都从代理出去。PROXY_URL 为空则直连。
// 注意: 必须让"解验证码"和"注册"走同一个出口 IP —— cap token 可能与 IP 绑定。
const PROXY_URL = (process.env.PROXY_URL || '').trim();
const proxyOpt = PROXY_URL ? { server: PROXY_URL } : undefined;

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// 浏览器里注入的反检测脚本。
// instrumentation 会检查 WebGL RENDERER 是否为 swiftshader/llvmpipe (无头特征),
// 因此这里伪装成一块普通的 Intel 集显。
// 切记不要动 fetch/setTimeout/Date/... 这 37 个原生 API ——
// instrumentation 会逐个校验它们的 toString() 是否含 "[native code]"。
const STEALTH = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
  } catch {}
  const FAKE_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const FAKE_VENDOR = 'Google Inc. (Intel)';
  const patch = (proto) => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    const wrapped = function (p) {
      if (p === 0x1F01 || p === 37446) return FAKE_RENDERER; // RENDERER / UNMASKED_RENDERER_WEBGL
      if (p === 0x1F00 || p === 37445) return FAKE_VENDOR;   // VENDOR   / UNMASKED_VENDOR_WEBGL
      return orig.call(this, p);
    };
    try {
      Object.defineProperty(wrapped, 'toString', {
        value: () => 'function getParameter() { [native code] }',
        configurable: true,
      });
    } catch {}
    proto.getParameter = wrapped;
  };
  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
})();`;

// ────────────────────────────── 工具 ──────────────────────────────
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randStr(n) {
  const buf = require('crypto').randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

function maskEmail(email) {
  const [u, d] = email.split('@');
  return `${u.slice(0, 3)}***@${d}`;
}

const browserHeaders = () => ({
  'user-agent': UA,
  origin: BASE,
  referer: `${BASE}/`,
});

// Node 自带的 fetch (undici) 不认 HTTP_PROXY 环境变量, 所以这里统一用
// Playwright 的 request API —— 它能显式指定代理, 而且不受 CORS 限制。
async function newApi() {
  return await pwRequest.newContext({
    proxy: proxyOpt,
    extraHTTPHeaders: browserHeaders(),
    timeout: 60_000,
  });
}

async function apiJson(api, url, opts) {
  const res = opts ? await api.post(url, opts) : await api.get(url);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} 返回的不是 JSON (HTTP ${res.status()}): ${text.slice(0, 200)}`);
  }
  return { status: res.status(), json };
}

// ─────────────────────── 1. 取站点 key ───────────────────────
async function getSiteKey(api) {
  const { json } = await apiJson(api, `${BASE}/api/v1/guest/comm/config`);
  const data = json && json.data;
  if (!data) throw new Error('config 接口无 data 字段');

  if (data.is_recaptcha === 0) {
    log('· 服务端已关闭验证码 (is_recaptcha=0)');
    return null;
  }

  const raw = data.recaptcha_site_key;
  if (!raw) throw new Error('config 里没有 recaptcha_site_key');

  // 形如 "https://wulass.org/fd0fb2130e/" —— 取最后一段路径; 也兼容裸 key
  let key = raw;
  if (/^https?:\/\//i.test(raw)) {
    const segs = new URL(raw).pathname.split('/').filter(Boolean);
    key = segs[segs.length - 1];
  }
  if (!key) throw new Error(`无法从 recaptcha_site_key 解析出 key: ${raw}`);
  return key;
}

// ─────────────────── 2. 浏览器里解验证码 ───────────────────
async function solveCap(siteKey) {
  const widgetJs = fs.readFileSync(WIDGET_FILE, 'utf8');
  const apiEndpoint = `${BASE}/${siteKey}/`;

  const browser = await chromium.launch({
    headless: true,
    proxy: proxyOpt,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      // 保证无头环境下 WebGL 可用 (渲染器字符串已被上面的 STEALTH 伪装)
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });

  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      proxy: proxyOpt,
    });
    await ctx.addInitScript(STEALTH);

    // 只需要一个"位于 wulass.org 源"的空白页, 这样 widget 对
    // /{key}/challenge 与 /{key}/redeem 的请求都是同源的。
    // 直接拦截一个不存在的路径本地返回, 避免去下载他们那个很重的首页。
    const stubUrl = `${BASE}/__solver__`;
    await ctx.route(stubUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!DOCTYPE html><html><head><meta charset="utf-8"><title>s</title></head><body></body></html>',
      })
    );

    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('  [pageerror]', String(e).slice(0, 200)));
    page.on('console', (m) => {
      if (m.type() === 'error') log('  [console]', m.text().slice(0, 200));
    });

    await page.goto(stubUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.addScriptTag({ content: widgetJs });

    if ((await page.evaluate(() => typeof window.Cap)) !== 'function') {
      throw new Error('cap-widget 注入失败: window.Cap 不存在');
    }

    const t0 = Date.now();
    const out = await page.evaluate(
      async ({ endpoint, timeoutMs }) => {
        const widget = new window.Cap({ apiEndpoint: endpoint });

        // instrumentation 被判定为机器人时, widget 只会派发 error 事件后静默
        // 返回 undefined (不抛异常), 所以这里必须同时监听 error 事件。
        let capError = null;
        widget.addEventListener('error', (ev) => {
          capError = (ev && ev.detail && ev.detail.message) || 'cap error';
        });

        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`solve 超时 (${timeoutMs}ms)`)), timeoutMs)
        );

        try {
          const r = await Promise.race([widget.solve(), timeout]);
          if (r && r.token) return { ok: true, token: r.token };
          return { ok: false, error: capError || 'solve() 未返回 token (可能被 instrumentation 拦截)' };
        } catch (e) {
          return { ok: false, error: capError || String((e && e.message) || e) };
        }
      },
      { endpoint: apiEndpoint, timeoutMs: SOLVE_TIMEOUT }
    );

    if (!out.ok) throw new Error(`验证码求解失败: ${out.error}`);
    log(`· 验证码通过, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return out.token;
  } finally {
    await browser.close();
  }
}

// ─────────────────────── 3. 注册账号 ───────────────────────
async function register(api, capToken) {
  const email = `${randStr(12)}@${EMAIL_DOMAIN}`;
  const password = randStr(16);

  const form = { email, password };
  if (capToken) form.recaptcha_data = capToken;

  const { status, json } = await apiJson(api, `${BASE}/api/v1/passport/auth/register`, { form });

  const token = json && json.data && json.data.token;
  if (!token) {
    const msg = (json && (json.message || json.error)) || JSON.stringify(json).slice(0, 200);
    throw new Error(`注册失败 (HTTP ${status}): ${msg}`);
  }
  log(`· 注册成功: ${maskEmail(email)}`);
  return token;
}

// ─────────────────────── 4. 拉取订阅 ───────────────────────
async function fetchSubscription(api, authToken) {
  const url = `${SUB_HOST}/s/?token=${encodeURIComponent(authToken)}`;
  // 订阅站按 UA 决定返回格式, 必须伪装成 clash 客户端才会给 mihomo 配置
  const res = await api.get(url, {
    headers: { 'user-agent': process.env.SUB_UA || 'clash-verge/v2.0.0' },
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`订阅接口 HTTP ${res.status()}: ${text.slice(0, 200)}`);
  const headers = res.headers();
  return { text, userinfo: headers['subscription-userinfo'] || '' };
}

// 写入仓库前必须校验 —— 绝不能把报错页面覆盖掉一份好的订阅
function validateSubscription(text) {
  if (!text || text.length < 1000) throw new Error(`订阅内容过短 (${text ? text.length : 0} 字节)`);
  for (const marker of ['proxies:', 'proxy-groups:', 'rules:']) {
    if (!text.includes(marker)) throw new Error(`订阅内容缺少 "${marker}", 可能不是有效的 mihomo 配置`);
  }
  return true;
}

function parseUserinfo(s) {
  const out = {};
  for (const part of String(s).split(';')) {
    const [k, v] = part.split('=').map((x) => x && x.trim());
    if (k && v !== undefined && v !== '') out[k] = Number(v);
  }
  return out;
}

// ──────────────────────────── 主流程 ────────────────────────────
async function once() {
  const api = await newApi();
  try {
    const siteKey = await getSiteKey(api);
    log(`· 站点 key: ${siteKey || '(无需验证码)'}`);

    const capToken = siteKey ? await solveCap(siteKey) : null;
    const authToken = await register(api, capToken);
    const { text, userinfo } = await fetchSubscription(api, authToken);
    validateSubscription(text);
    return { text, userinfo, authToken };
  } finally {
    await api.dispose();
  }
}

(async () => {
  log(PROXY_URL ? `· 出口代理: ${PROXY_URL}` : '· 出口代理: 无 (直连)');
  let lastErr;
  for (let i = 1; i <= ATTEMPTS; i++) {
    log(`\n===== 第 ${i}/${ATTEMPTS} 次尝试 =====`);
    try {
      const { text, userinfo, authToken } = await once();

      fs.writeFileSync(OUT_FILE, text);

      const info = parseUserinfo(userinfo);
      // 只数真正的节点: proxies 里每一项都是单行 flow map 且含 server:,
      // proxy-groups 的条目没有 server:, 不能一起数进来
      const nodeCount = (text.match(/^\s*-\s*\{[^}]*\bserver:/gm) || []).length;
      const byteLen = Buffer.byteLength(text, 'utf8');
      const meta = {
        updated_at: new Date().toISOString(),
        expire_at: info.expire ? new Date(info.expire * 1000).toISOString() : null,
        total_gb: info.total ? +(info.total / 1024 ** 3).toFixed(2) : null,
        used_gb: +(((info.upload || 0) + (info.download || 0)) / 1024 ** 3).toFixed(2),
        node_count: nodeCount,
        bytes: byteLen,
      };
      fs.writeFileSync(INFO_FILE, JSON.stringify(meta, null, 2) + '\n');

      log(`\n✅ 完成`);
      log(`   订阅文件 : ${path.relative(REPO_ROOT, OUT_FILE)} (${byteLen} 字节, ${nodeCount} 个节点)`);
      log(`   到期时间 : ${meta.expire_at || '未知'}`);
      log(`   总流量   : ${meta.total_gb ? meta.total_gb + ' GB' : '未知'}`);
      // 账号 token 只打印到日志便于排查, 不写进仓库
      log(`   账号token: ${authToken.slice(0, 8)}…`);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      log(`✗ 失败: ${e.message}`);
      if (i < ATTEMPTS) {
        const wait = 5000 * i;
        log(`  ${wait / 1000}s 后重试…`);
        await sleep(wait);
      }
    }
  }
  console.error(`\n❌ ${ATTEMPTS} 次尝试均失败, 最后一次错误: ${lastErr && lastErr.message}`);
  process.exit(1);
})();
