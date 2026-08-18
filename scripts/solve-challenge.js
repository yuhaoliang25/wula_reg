#!/usr/bin/env node
/**
 * Challenge Solver
 *
 * 流程:
 *   1. 用 Playwright 启动 Chromium 打开 challenge 页面
 *   2. widget.js 自动: 解压 instrumentation → 沙盒 iframe 环境检测 → 计算 solutions
 *   3. 拦截 POST /redeem 响应, 拿到最终通过凭证
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ────────────────────────── 配置 ──────────────────────────
const TARGET_URL  = process.env.TARGET_URL || 'https://wulass.org/fd0fb2130e/challenge';
const REDEEM_RE   = /\/redeem/;          // 匹配 redeem 接口的正则
const NAV_TIMEOUT = 60_000;              // 页面加载超时 (ms)
const SOLVE_TIMEOUT = 60_000;            // 等待 redeem 完成超时 (ms)
const OUTPUT_FILE = path.join(process.cwd(), 'challenge-result.json');
const SCREENSHOT  = path.join(process.cwd(), 'debug-screenshot.png');

// ──────────────── 反检测注入脚本 (关键!) ────────────────
// widget.js 的 iframe 会检测:
//   1. WebGL RENDERER 是否包含 swiftshader / llvmpipe (headless 特征)
//   2. navigator.userAgent 是否存在
//   3. 37 个原生 API 的 toString() 是否包含 "[native code]"
const STEALTH_JS = `
(() => {
  // ① 隐藏 webdriver 标志
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // ② 伪装 WebGL 渲染器 (绕过 swiftshader/llvmpipe 检测)
  const fakeRenderer = 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)';
  const fakeVendor   = 'Google Inc. (Intel)';
  const patch = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === this.RENDERER) return fakeRenderer;
      if (param === this.VENDOR)   return fakeVendor;
      return orig.call(this, param);
    };
  };
  patch(window.WebGLRenderingContext?.prototype);
  patch(window.WebGL2RenderingContext?.prototype);

  // ③ 确保 canvas 2d 正常工作 (widget.js 会 fillText 并检查 toDataURL 长度)
  // Playwright 的 Chromium 已支持, 无需额外处理
})();
`;

// ────────────────────────── 主流程 ──────────────────────────
async function main() {
  console.log(`🎯 Target: ${TARGET_URL}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',   // 隐藏自动化特征
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--use-angle=swiftshader',                        // 软件渲染 (CI 无 GPU)
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
  });

  // 在任何页面脚本执行前注入反检测代码
  await context.addInitScript(STEALTH_JS);

  const page = await context.newPage();

  // 日志: 捕获 challenge 和 redeem 请求
  page.on('request', (req) => {
    const url = req.url();
    if (/challenge|redeem/.test(url)) {
      console.log(`  ➜ ${req.method()} ${url}`);
    }
  });

  page.on('response', (res) => {
    const url = res.url();
    if (/challenge|redeem/.test(url)) {
      console.log(`  ⬅ ${res.status()} ${url}`);
    }
  });

  page.on('pageerror', (err) => console.error('  [page error]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('  [console error]', msg.text());
  });

  try {
    // ── Step 1: 打开页面 ──
    console.log('\n⏳ Loading page...');
    await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });

    // ── Step 2: 等待 widget.js 自动完成 challenge ──
    // widget.js 内部流程:
    //   POST /challenge → 解压 instrumentation → iframe 环境检测
    //   → 计算 solutions → POST /redeem
    // 我们只需等待 redeem 响应即可
    console.log('⏳ Waiting for challenge to be solved (POST /redeem)...');

    const redeemResponse = await page.waitForResponse(
      (res) => REDEEM_RE.test(res.url()) && res.request().method() === 'POST',
      { timeout: SOLVE_TIMEOUT }
    );

    // ── Step 3: 解析结果 ──
    const status = redeemResponse.status();
    const headers = redeemResponse.headers();
    let body;
    try {
      body = await redeemResponse.json();
    } catch {
      body = await redeemResponse.text();
    }

    console.log(`\n✅ Challenge solved! redeem status: ${status}`);
    console.log('📦 Response body:', JSON.stringify(body, null, 2).slice(0, 2000));

    // ── Step 4: 保存结果 ──
    const result = {
      success: status >= 200 && status < 300,
      status,
      url: redeemResponse.url(),
      headers,
      body,
      solvedAt: new Date().toISOString(),
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    console.log(`💾 Saved to ${OUTPUT_FILE}`);

    // ── Step 5: 设置 GitHub Actions outputs (供后续步骤使用) ──
    const ghOutput = process.env.GITHUB_OUTPUT;
    if (ghOutput) {
      // 如果 redeem 返回了 token, 提取出来
      const token = body?.token || body?.access_token || '';
      fs.appendFileSync(ghOutput, `status=${status}\n`);
      fs.appendFileSync(ghOutput, `token=${token}\n`);
      if (token) console.log('🔑 Token extracted for downstream steps');
    }

    // 截图存档
    await page.screenshot({ path: SCREENSHOT, fullPage: true });

    // ── Step 6: 根据状态码决定是否失败 ──
    if (status < 200 || status >= 300) {
      process.exitCode = 1;
      console.error(`❌ redeem returned non-2xx status: ${status}`);
    }
  } catch (err) {
    console.error('\n❌ Failed:', err.message);

    // 保存调试截图
    try {
      await page.screenshot({ path: SCREENSHOT, fullPage: true });
      console.log('📸 Debug screenshot saved');
    } catch { /* ignore */ }

    // 保存失败信息
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      success: false,
      error: err.message,
      failedAt: new Date().toISOString(),
    }, null, 2));

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();