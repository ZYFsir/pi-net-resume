# pi-net-resume

Auto-continue a pi session after a network outage.

**English** | [中文](#中文)

When a phone hotspot or Wi-Fi link drops, the provider request fails, pi retries
it `retry.maxRetries` times (default 3: backoff 2s/4s/8s, about 14 seconds), and
then the agent settles with an error and simply stops. Nothing happens until a
human types something. If you stepped away, or your SSH session died with the
link, the task is silently stuck.

This extension watches for exactly that situation, waits for the network to come
back, and then resumes **the same session** with its full context.

## Install

```bash
pi install npm:pi-net-resume      # from npm
pi -e npm:pi-net-resume           # try it for one run, no settings change
```

Or from a git ref / a local checkout:

```bash
pi install git:github.com/ZYFsir/pi-net-resume@v1.0.0
pi install ./                                  # from a checkout of this package
```

This package lives in the `pkg/pi-net-resume/` subdirectory of the
[repository](https://github.com/ZYFsir/pi-net-resume); the repo root carries a
small `package.json` that points pi at it, so the git install above works
without extra flags. `pi install` from a *local checkout* must point at the
package directory itself.

### One setting you should change

The extension only takes over **after** pi has exhausted its own retries, so
`retry.maxRetries` decides how long a hiccup pi absorbs by itself. The default
of 3 (about 14 seconds) is short for a hotspot outage; 6 rides out about two
minutes:

```jsonc
// ~/.pi/agent/settings.json
{
  "retry": { "maxRetries": 6, "baseDelayMs": 2000 }
}
```

This is deliberately **not** done by the package on install. If you skip it the
extension still works, it just starts waiting sooner.

## How it works

| Step | Hook | Action |
| --- | --- | --- |
| 1 | `agent_end` | remember a failure whose assistant message has `stopReason: "error"` and a connectivity-class `errorMessage` |
| 2 | `agent_settled` | pi fires this only when *no* automatic retry / compaction retry / queued message is left, i.e. it really gave up |
| 3 | polling | check the link, then TCP-probe the model endpoint until it answers |
| 4 | resume | `pi.sendUserMessage(...)` in the same session, which starts a fresh turn |

Because the continuation is an ordinary user message in the existing session,
all context — including tool results from before the outage — is preserved. This
is a resume, not a re-run.

### Where the probe target comes from

No provider is hardcoded. The first non-empty result wins:

1. **`ctx.model.baseUrl`** — the endpoint pi is actually configured to talk to.
2. **`MODEL_BASE_URL` / `PI_BASE_URL` / `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`**
   — for self-hosted gateways configured through the environment.
3. **`extraProbeHosts`** from the config.
4. Nothing (e.g. a local `llama.cpp` with no base URL): the system link state
   alone decides.

Ports follow what the URL means: `https://…` → 443, `http://…` → 80, and an
explicit `host:port` or `[::1]:port` is taken literally.

## Relationship to `pi-auto-resume`

[`pi-auto-resume`](https://www.npmjs.com/package/pi-auto-resume) is a sibling
extension that handles a **different** interruption class:

| Interruption | `pi-auto-resume` | `pi-net-resume` (this) |
| --- | --- | --- |
| Output truncated (`stopReason: "length"`) | yes — sends a continuation | not handled |
| HTTP 429 / rate limit | yes — exponential backoff | **never** (excluded on purpose) |
| Billing / quota / plan exhaustion | notifies the user | **never** (excluded on purpose) |
| Incomplete tool call | yes — asks the model to finish it | not handled |
| **Connectivity loss** | **not detected** | **core case** |
| How it decides to retry | a **timer** (fixed/exponential delay) | the link is actually up: NM state + a TCP probe of the model endpoint |

The two are complementary and can be installed together. The one place they
could overlap is a network error whose wording also looks like throttling; the
boundary is pinned in both directions by tests:

- A message carrying a **hard** broken-link signature (`ECONNRESET`,
  `ENOTFOUND`, `fetch failed`, `socket hang up`, …) is treated as an outage even
  if it also mentions `429` or `quota` somewhere.
- A message that only says `unauthorized` / `quota` / `rate limit` with no hard
  signature is **left alone**, because resuming it would burn tokens on a
  request that cannot succeed.

If you want the sibling's behaviour too, install both:

```bash
pi install npm:pi-auto-resume     # truncation, 429, quota
pi install npm:pi-net-resume      # connectivity loss
```

## Guards

- Only connectivity-class errors arm it (`errorPattern`).
- Quota, rate-limit and auth errors **never** do (`excludePattern`) — the
  extension will not burn your credit on a request that cannot succeed.
- `stopReason: "aborted"` (Ctrl+C) never resumes.
- Typing anything cancels a pending auto-resume.
- `armOnlyWhenOffline` (default `true`): if the link is up when pi settles, the
  error was not an outage, so nothing is armed.
- Capped by `maxAutoResumes` and `maxWaitMinutes`, throttled by
  `minSecondsBetweenResumes`, and it never fires while pi is busy.
- `/net-resume off` disables it for one session.

**Known limitation:** pressing `Escape` while pi waits between retries cancels
the retries, and pi reports that identically to "retries exhausted". If the link
is still down, this extension may arm and later resume such a cancelled run.
Typing anything, or `/net-resume off`, cancels it.

## Configure

```bash
mkdir -p ~/.pi/agent
cp config.example.json ~/.pi/agent/pi-net-resume.json
```

The agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise.
Config is searched in this order, first existing file wins:

1. `$PI_NET_RESUME_CONFIG`
2. `<agent dir>/pi-net-resume.json` ← what the copy above creates
3. `<agent dir>/extensions/pi-net-resume/config.json` (manual/legacy install)
4. `config.json` bundled next to the extension

`/net-resume` prints which file was actually loaded, so there is no guessing.

Most useful keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `continueMessage` | `The network is back… continue` | the prompt injected after a reconnect |
| `armOnlyWhenOffline` | `true` | only arm when the link is actually down |
| `maxAutoResumes` | `20` | hard cap on auto-resumes |
| `minSecondsBetweenResumes` | `15` | throttle between resumes |
| `maxWaitMinutes` | `120` | stop waiting after this long offline |
| `probeIntervalMs` | `3000` | poll cadence while waiting |
| `probeTimeoutMs` | `4000` | per-probe TCP timeout |
| `extraProbeHosts` | `[]` | extra `host:port` probes (IPv6 must be bracketed, `[::1]:443`) |
| `checkNetworkManager` | `true` | ask `nmcli` for link state before probing TCP |
| `notify` | `true` | desktop notification when resuming |
| `logFile` | `~/.local/state/pi-net-resume/pi-net-resume.log` | JSON-lines evidence log |
| `enabled` | `true` | set `false` to load nothing at all |
| `errorPattern` / `excludePattern` | see `config.example.json` | which errors arm it / never arm it |

## Commands

| Command | Effect |
| --- | --- |
| `/net-resume` | status: armed/waiting, resumes used, link state, probe targets, config path |
| `/net-resume now` | force a resume immediately (if the link is up) |
| `/net-resume off` / `on` | disable / enable for this session |

## Verify it works

The JSON-lines log is the evidence trail:

```bash
tail -f ~/.local/state/pi-net-resume/pi-net-resume.log
```

Expected sequence for a real outage:

```json
{"event":"network_error","message":"fetch failed"}
{"event":"armed","detail":"NetworkManager reports disconnected"}
{"event":"waiting_for_network","failureAt":1789538000000}
{"event":"auto_resume","resumeCount":1,"waitedMs":41300,"detail":"api.example.com:443 reachable"}
```

`PI_NET_RESUME_CONFIG=/path/to/config.json` overrides the config location, which
is handy for testing.

## Headless runs

The extension covers a live pi session. A `pi -p` (print-mode) process instead
**exits** when the provider call fails, so it needs a wrapper. The one bundled
here is `pi-resume-run.sh`:

```bash
./pi-resume-run.sh --model <provider>/<model> "run the test suite and fix failures"
```

It re-launches `pi -p` with the same session id and a "continue" prompt until the
run succeeds or a limit is reached.

- **`bash` and `python3`** are needed (python3 powers the TCP probe and the
  default probe-target resolution; the extension itself does not need it).
- The **last argument** is the prompt; everything before it is forwarded to `pi`
  unchanged, so options and their values must come first.
- Probe target: `PI_RESUME_PROBE_HOST`/`_PORT`, then `PI_RESUME_PROBE_URL` /
  `MODEL_BASE_URL` / `PI_BASE_URL` / `OPENAI_BASE_URL`, then your pi
  `settings.json` + `models-store.json`, then `1.1.1.1:443`.
- Sessions go to `~/.local/state/pi-net-resume/sessions/` (override with
  `PI_RESUME_SESSION_DIR`), never into the normal project session store.

## Portability

| Requirement | Needed for | Without it |
| --- | --- | --- |
| pi (any platform) | everything | — |
| `nmcli` (Linux/NetworkManager) | the cheap "link is down" short-circuit | set `checkNetworkManager: false`; TCP probing alone still works |
| `notify-send` | desktop notification | silently skipped |

No host, path or provider is hardcoded, so this works on macOS and Windows in
TCP-probe-only mode.

## License

MIT

---

## 中文

网络中断后自动继续 pi 会话。

手机热点或 Wi-Fi 掉线时，provider 请求会失败，pi 按 `retry.maxRetries`
重试若干次（默认 3 次，退避 2s/4s/8s，约 14 秒），然后用一条错误结束并**静默停住** ——
除非有人再敲键盘。你若离开键盘，或 SSH 会话随链路一起断掉，任务就卡死了。

本扩展就盯着这个状态：等网络恢复，然后**在同一条会话里**带着完整上下文继续。

### 安装

```bash
pi install npm:pi-net-resume      # 从 npm 安装
pi -e npm:pi-net-resume           # 临时试用一次，不改 settings
```

或从 git / 本地目录：

```bash
pi install git:github.com/ZYFsir/pi-net-resume@v1.0.0
pi install ./                                  # 在包目录的检出里执行
```

本包位于[仓库](https://github.com/ZYFsir/pi-net-resume)的 `pkg/pi-net-resume/`
子目录；仓库根有一个小 `package.json` 指向它，所以上面的 git 安装命令可以直接用。
从**本地检出**安装时，路径要指向包目录本身。

#### 有一项设置建议你改

扩展只在 **pi 自己的重试全部耗尽之后**才接手，所以 `retry.maxRetries`
决定"多长的抖动由 pi 自己扛"。默认 3 次（约 14 秒）对热点断网太短，改成 6
能扛约两分钟：

```jsonc
// ~/.pi/agent/settings.json
{
  "retry": { "maxRetries": 6, "baseDelayMs": 2000 }
}
```

包在安装时**故意不改**这项。不改也能用，只是扩展会更早开始等待。

### 工作原理

| 步 | 钩子 | 动作 |
| --- | --- | --- |
| 1 | `agent_end` | 记住"助手消息 `stopReason: "error"` 且错误属于连通性类" |
| 2 | `agent_settled` | pi 只在**再无自动重试 / 压缩重试 / 排队消息**时才触发，即真的放弃了 |
| 3 | 轮询 | 先看链路状态，再对模型端点做 TCP 探测，直到能通 |
| 4 | 续跑 | 在同一会话里 `pi.sendUserMessage(...)`，开新一轮 |

因为续跑是一条普通用户消息，断网前的全部上下文（含工具调用结果）原样保留 ——
这是"续跑"，不是"重跑"。

#### 探测目标从哪来

**不写死任何 provider**，取第一个非空结果：

1. **`ctx.model.baseUrl`** —— pi 实际要访问的端点；
2. **`MODEL_BASE_URL` / `PI_BASE_URL` / `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`**
   —— 给自建网关用；
3. 配置里的 **`extraProbeHosts`**；
4. 都没有（如本地 `llama.cpp` 没有 baseUrl）：只看系统链路状态。

端口按 URL 语义解析：`https://…` → 443，`http://…` → 80，显式 `host:port`
或 `[::1]:port` 按字面值使用。

#### 与 `pi-auto-resume` 的关系

[`pi-auto-resume`](https://www.npmjs.com/package/pi-auto-resume) 是另一个扩展，
处理的是**不同**的中断类别：

| 中断类型 | `pi-auto-resume` | `pi-net-resume`（本扩展） |
| --- | --- | --- |
| 输出被截断（`stopReason: "length"`） | 处理 —— 发继续提示词 | 不处理 |
| HTTP 429 / 限流 | 处理 —— 指数退避 | **永不**（有意排除） |
| 套餐 / 额度耗尽 | 通知用户 | **永不**（有意排除） |
| 工具调用被截断 | 处理 —— 让模型补完 | 不处理 |
| **链路断开** | **不识别** | **核心场景** |
| 如何决定重试时机 | **定时器**（固定/指数延迟） | 链路真的通了：NM 状态 + 对模型端点做 TCP 探测 |

两者互补，可以同时安装。唯一可能重叠的地方是"措辞看起来像限流的网络错误"，
这个边界我用**双向测试**钉住了：

* 消息里带**硬**断链特征（`ECONNRESET`、`ENOTFOUND`、`fetch failed`、`socket hang up` 等）时，
  即使别处还提到 `429` 或 `quota`，也判定为断网；
* 只有 `unauthorized` / `quota` / `rate limit` 而没有硬特征的消息**一律不动** ——
  对注定失败的请求续跑只会烧额度。

想同时要那个包的能力，两个都装：

```bash
pi install npm:pi-auto-resume     # 截断、429、额度
pi install npm:pi-net-resume      # 链路断开
```

## 安全阀

* 只对连通性类错误待命（`errorPattern`）；
* 限流 / 欠费 / 鉴权类**永不**待命（`excludePattern`）—— 不会替你在注定失败的请求上烧额度；
* `stopReason: "aborted"`（Ctrl+C）永不续跑；
* 用户一打字立即取消；
* `armOnlyWhenOffline`（默认 `true`）：pi 放弃时若链路正常，说明不是断网，不待命；
* `maxAutoResumes` / `maxWaitMinutes` 上限、`minSecondsBetweenResumes` 节流，pi 忙时不触发；
* `/net-resume off` 可对单个会话关闭。

**已知限制**：在 pi 重试等待期按 `Esc` 会取消重试，而 pi 对这一点的上报与"重试耗尽"
完全相同。若此时链路仍是断的，本扩展可能对这样一个被取消的运行待命并在之后续跑。
打字或 `/net-resume off` 都能立即取消。

### 配置

```bash
mkdir -p ~/.pi/agent
cp config.example.json ~/.pi/agent/pi-net-resume.json
```

agent 目录默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 覆盖。
配置文件按以下顺序查找，首个存在者胜：

1. `$PI_NET_RESUME_CONFIG`
2. `<agent dir>/pi-net-resume.json` ← 上面这条命令创建的位置
3. `<agent dir>/extensions/pi-net-resume/config.json`（手动/旧式安装）
4. 扩展旁边的 `config.json`

`/net-resume` 会打印**实际加载的那个文件**，不用猜。

常用配置项：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `continueMessage` | `The network is back… continue` | 重连后注入的提示词（可换成任意语言） |
| `armOnlyWhenOffline` | `true` | 只在链路确实断了时才待命 |
| `maxAutoResumes` | `20` | 自动续跑次数上限 |
| `minSecondsBetweenResumes` | `15` | 两次续跑之间的节流 |
| `maxWaitMinutes` | `120` | 离线等待上限 |
| `probeIntervalMs` | `3000` | 等待期间的轮询节奏 |
| `probeTimeoutMs` | `4000` | 单次 TCP 探测超时 |
| `extraProbeHosts` | `[]` | 额外 `host:port`（IPv6 要加方括号，`[::1]:443`） |
| `checkNetworkManager` | `true` | TCP 探测前先问 `nmcli` 链路状态 |
| `notify` | `true` | 续跑时发桌面通知 |
| `logFile` | `~/.local/state/pi-net-resume/pi-net-resume.log` | JSON lines 证据链 |
| `enabled` | `true` | 设 `false` 则完全不加载 |
| `errorPattern` / `excludePattern` | 见 `config.example.json` | 哪些错误触发 / 永不触发 |

### 命令

| 命令 | 作用 |
| --- | --- |
| `/net-resume` | 状态：待命/等待中、已续跑次数、链路状态、探测目标、配置路径 |
| `/net-resume now` | 链路已通时立刻续跑一次 |
| `/net-resume off` / `on` | 对当前会话关闭 / 开启 |

### 验证

JSON lines 日志就是证据链：

```bash
tail -f ~/.local/state/pi-net-resume/pi-net-resume.log
```

真实断网时应依次出现：

```json
{"event":"network_error","message":"fetch failed"}
{"event":"armed","detail":"NetworkManager reports disconnected"}
{"event":"waiting_for_network","failureAt":1789538000000}
{"event":"auto_resume","resumeCount":1,"waitedMs":41300,"detail":"api.example.com:443 reachable"}
```

`PI_NET_RESUME_CONFIG=/path/to/config.json` 可覆盖配置路径，便于测试。

### 无头模式

扩展只覆盖活着的 pi 会话。`pi -p`（print 模式）在 provider 调用失败后是**退出**，
所以需要包装脚本，本包内置 `pi-resume-run.sh`：

```bash
./pi-resume-run.sh --model <provider>/<model> "跑测试并修复失败"
```

它用同一个 session id 反复拉起 `pi -p`，并在失败且离线时改用"继续"提示词重试，
直到成功或达到上限。

* 需要 **`bash` 与 `python3`**（python3 用于 TCP 探测和解析默认探测目标；
  扩展本身不需要它）；
* **最后一个参数是提示词**，前面的选项原样转发给 pi，所以选项和它的值必须在前；
* 探测目标：`PI_RESUME_PROBE_HOST`/`_PORT` → `PI_RESUME_PROBE_URL` /
  `MODEL_BASE_URL` / `PI_BASE_URL` / `OPENAI_BASE_URL` → pi 的
  `settings.json` + `models-store.json` → `1.1.1.1:443`；
* 会话写在 `~/.local/state/pi-net-resume/sessions/`（可用 `PI_RESUME_SESSION_DIR`
  覆盖），**不写进**正常的项目 session 库。

### 可移植性

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| pi（任意平台） | 全部功能 | — |
| `nmcli`（Linux/NetworkManager） | 廉价的"链路已断"短路判断 | 设 `checkNetworkManager: false`，退化为纯 TCP 探测 |
| `notify-send` | 桌面通知 | 静默跳过 |

没有硬编码的主机、路径或 provider，因此在 macOS 和 Windows 上以纯 TCP 探测模式可用。

### 许可

MIT
