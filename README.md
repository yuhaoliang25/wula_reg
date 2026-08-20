# wula_reg

每天自动注册 wulass.org 的 1 天试用账号, 把拿到的 mihomo 订阅内容提交到本仓库,
从而得到一个**永不过期的固定订阅链接**。

## 固定订阅链接

```
https://raw.githubusercontent.com/yuhaoliang25/wula_reg/main/sub.yaml
```

把这个地址填进 mihomo / Clash Verge / Stash 即可。内容每天由 GitHub Actions 刷新,
链接本身不变。`sub-info.json` 里记录了本次刷新的时间、到期时间、流量和节点数。

> ⚠️ 该链接是公开的 —— 任何拿到地址的人都能看到订阅里的节点信息。

## 工作原理

站点的注册接口用 [Cap](https://trycap.dev) (`@cap.js`) 做人机校验,
`recaptcha_data` 其实就是一个解完的 Cap token。整条链路:

| 步骤 | 接口 | 作用 |
| --- | --- | --- |
| 1 | `GET /api/v1/guest/comm/config` | 取 `recaptcha_site_key` → 站点 key |
| 2 | `POST /{key}/challenge` | 拿到 80 个 PoW 子挑战 (`c=80, s=32, d=4`) 和 `instrumentation` |
| 3 | 本地计算 | 每个子挑战爆破 `SHA256(salt+nonce)` 前 4 个 hex → `solutions` |
| 4 | 沙箱 iframe | 执行服务端下发的 `instrumentation` → `instr.state` |
| 5 | `POST /{key}/redeem` | 换取 cap token |
| 6 | `POST /api/v1/passport/auth/register` | 随机邮箱/密码注册 → 账号 token |
| 7 | `GET windowsv1.com/s/?token=…` | 下载 mihomo 订阅内容 |

### 为什么必须用真实浏览器

第 3 步的 PoW 纯 Node 就能算 (实测单线程 80 个挑战约 12s), 但第 4 步不行:

- `/redeem` 强制校验 `instr`。缺了直接
  `403 {"instr_error":true,"reason":"missing_instrumentation_response"}`。
- `instrumentation` 是 base64 + `deflate-raw` 压缩的 JS, 在 `sandbox="allow-scripts"`
  的 iframe 里执行, 会检查 canvas 指纹、WebGL 渲染器、`typeof process`、
  以及 37 个原生 API 的 `toString()` 是否含 `[native code]`。
  其中 `typeof process !== 'undefined'` 这条直接把 Node 排除掉。
- **它是多态的**: 每次请求下发的混淆代码都不一样 (实测同一时间两次请求分别是
  5701 / 7100 字节, 结构也不同), 所以没法在 Node 里静态复现它的算法,
  只能真的丢进浏览器跑。

因此脚本用无头 Chromium 载入 `vendor/cap-widget.js` (站点实际使用的那份 widget),
由 widget 自己完成 PoW (WASM + Web Worker 并行) 和 instrumentation, 再读走结果。
唯一需要的反检测是**伪装 WebGL 渲染器字符串** —— 无头 Chromium 报的是
`SwiftShader`/`llvmpipe`, 会被 instrumentation 判定为机器人。

脚本没有去加载站点首页, 而是用 `page.route` 在 `wulass.org` 源上伪造了一个
空白页 (`/__solver__`), 这样 widget 的请求都是同源的, 也省掉下载整个前端。

## 本地运行

```bash
npm ci
npx playwright install --with-deps chromium
npm run solve
```

成功输出示例:

```
· 站点 key: fd0fb2130e
· 验证码通过, 耗时 1.7s
· 注册成功: shr***@gmail.com
✅ 完成
   订阅文件 : sub.yaml (178923 字节, 36 个节点)
   到期时间 : 2026-08-21T03:00:56.000Z
   总流量   : 1000 GB
```

### 可调环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WULA_BASE` | `https://wulass.org` | 主站地址 (换域名时改这里) |
| `SUB_HOST` | `https://windowsv1.com` | 订阅下载域名 |
| `OUT_FILE` | `sub.yaml` | 订阅输出文件 |
| `ATTEMPTS` | `3` | 整条链路的重试次数 |
| `EMAIL_DOMAIN` | `gmail.com` | 注册邮箱后缀 |
| `SOLVE_TIMEOUT` | `180000` | 解验证码超时 (ms) |

## 自动化

`.github/workflows/solve-challenge.yml` 每天 UTC 02:23 跑一次, 也可以在 Actions
页面手动触发。脚本内置 3 次重试, 并且**写入前会校验**内容里必须含
`proxies:` / `proxy-groups:` / `rules:` 且长度 > 1000 字节 ——
避免把报错页面覆盖掉一份可用的订阅。

需要更保险的话, 在 `schedule` 里再加一行 cron (例如 `'23 14 * * *'`) 变成一天两次。

> GitHub 会把**连续 60 天没有仓库活动**的定时任务自动停用。如果长期不管这个仓库,
> 记得偶尔手动触发一次, 或者到 Actions 页面重新启用。

## 目录结构

```
scripts/solve-challenge.js   主脚本: 解验证码 → 注册 → 拉订阅 → 写文件
vendor/cap-widget.js         站点实际使用的 cap widget (已验证可用)
reference/                   抓包留档: widget.js 原件、instrumentation 解压结果、流程笔记
sub.yaml                     产出: mihomo 订阅 (由 Actions 自动更新)
sub-info.json                产出: 刷新时间 / 到期时间 / 流量 / 节点数
```

## 免责声明

仅用于个人学习与自动化实践。请遵守目标站点的服务条款, 不要滥用。
