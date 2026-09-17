# pi_fast_resume

Keep a Jetson/Linux box connected to a phone hotspot, and keep a pi agent
working through the outage.

**English** | [中文](#中文)

```
wifi-fastlink/     Wi-Fi fast-reconnect watcher (NetworkManager + nmcli, user systemd service)
pkg/pi-net-resume/ the publishable pi package (extension + headless wrapper)
tests/             22 Wi-Fi state-machine cases + 15 extension cases, all offline
```

Install the pi side:

```bash
pi install npm:pi-net-resume
```

Install the Wi-Fi side (Linux + NetworkManager only, no sudo needed):

```bash
./install.sh
```

Details: [wifi-fastlink/README.md](wifi-fastlink/README.md),
[pkg/pi-net-resume/README.md](pkg/pi-net-resume/README.md).
**Acceptance procedure:** [TESTING.md](TESTING.md).

---

## 1. Why the reconnect used to be slow

NetworkManager 1.36 only rescans for known networks on a geometric backoff while
disconnected (`SCAN_INTERVAL_SEC_MIN 3` → `SCAN_INTERVAL_SEC_MAX 120`), so a few
minutes after the hotspot disappears the box may look for it only once every two
minutes.

The same function allows **explicit** scans while disconnected, rate-limited to
1500 ms. `wifi-fastlink` uses exactly that: it keeps requesting scans at that
cadence, watches the access-point list, and activates the saved connection the
moment the target SSID appears.

| Phase | Time | Note |
| --- | --- | --- |
| hotspot on → scanned | ≤ one scan (~1–3 s) | discovery is protocol-limited |
| seen → associated | 0.5–1.5 s | WPA2 handshake |
| associated → IP | 0.3–1 s | DHCP |
| **total** | **~2–5 s** | measured as `search_to_connected_ms` |

## 2. Why pi used to stop

pi retries a failed provider request `retry.maxRetries` times (default 3, backoff
2s/4s/8s ≈ 14 s). An outage longer than that exhausts the retries, pi logs an
error and sits there until someone types.

`pi-net-resume` hooks `agent_end` (remember a connectivity error) and
`agent_settled` (pi has really given up), then polls the link and TCP-probes the
model endpoint, and finally injects a user message into **the same session** so
the task continues with all context intact.

`install.sh` also raises `retry.maxRetries` from 3 to 6 (with a timestamped
backup) so short hiccups are absorbed by pi itself. Skip that with
`./install.sh --no-retry-tuning`.

## 3. What gets installed

| Path | Purpose |
| --- | --- |
| `~/.local/share/wifi-fastlink/wifi_fastlink.py` | the watcher |
| `~/.config/wifi-fastlink/config.json` | target SSIDs etc. (seeded with the current SSID) |
| `~/.config/systemd/user/wifi-fastlink.service` | user service, `Restart=always` |
| `~/.pi/agent/extensions/pi-net-resume/index.ts` | the pi extension |
| `~/.local/bin/pi-resume-run.sh` | headless `pi -p` wrapper |
| `~/.local/state/wifi-fastlink/wifi-fastlink.log` | Wi-Fi timeline (ms + JSON events) |
| `~/.local/state/pi-net-resume/pi-net-resume.log` | extension evidence chain (JSON lines) |

## 4. Day-to-day

```bash
systemctl --user status wifi-fastlink
tail -f ~/.local/state/wifi-fastlink/wifi-fastlink.log
tail -f ~/.local/state/pi-net-resume/pi-net-resume.log

# inside pi
/net-resume            # armed? resumes used? probe target? config path?
/net-resume off        # do not auto-resume in this session
/net-resume now        # resume right now

# headless
pi-resume-run.sh --model <provider>/<model> "run the tests and fix failures"
```

## 5. Scope: what each half is actually for

The two halves cover **different layers of the same outage**, and each one is
narrow on purpose. Pick the one that matches your failure:

| Your failure | Use |
| --- | --- |
| The AP disappeared and came back (phone hotspot, mobile router) | **wifi-fastlink** |
| The AP is associated but packets do not leave (ISP down, captive portal, router reboot) | **pi-net-resume only** — the link is fine, so the watcher correctly does nothing |
| pi stopped after a provider error and nobody is at the keyboard | **pi-net-resume** (works with or without the watcher) |
| Truncated output, HTTP 429, quota exhausted | neither — see [pi-auto-resume](https://www.npmjs.com/package/pi-auto-resume) |

`wifi-fastlink` pays off only when **all** of these hold: Linux with
NetworkManager; the AP physically leaves and returns; its password is already
saved; and you care about ~3 s instead of NM's 3 s → 120 s backoff. It is a
targeted tool, not a general networking component: macOS, Windows, `iwd`,
`wpa_supplicant` and systemd-networkd setups are not supported, and it needs a
systemd user session (or any supervisor) to stay resident.

No SSID, interface or path is hardcoded: `targets` starts empty
(auto-learn), `interface` defaults to `auto`, and the current SSID is only ever
*seeded into your own* `~/.config/wifi-fastlink/config.json` at install time.

## 6. Honest limits

- Discovery of a hotspot can only happen by scanning, so "hotspot on → connected"
  is bounded below by one scan (~1–3 s here). Five seconds is achievable; one
  second is not.
- The watcher only works while disconnected. Once associated, NetworkManager
  forbids explicit scans, so it just blocks on `nmcli monitor`.
- Only networks with **saved credentials** can be joined automatically. A brand
  new SSID needs one manual join first; map it via `connection_names` if the
  profile name differs from the SSID.
- Verified platform: Linux + NetworkManager 1.36 (Jetson, RTL8822CE, iPhone
  hotspot). The pi extension is cross-platform; `wifi-fastlink` is not.
- `pi-net-resume` deliberately does nothing about quota / rate-limit / auth
  errors, and cannot distinguish an `Escape`-cancelled retry from exhausted
  retries. Typing or `/net-resume off` cancels it.
- A user-level service only runs while you are logged in. For always-on:
  `sudo loginctl enable-linger $USER`.

## 7. Publishing
```bash
./publish-package.sh              # verify only: tests, package.json, jiti load, tarball
./publish-package.sh --publish    # then npm publish
```

The pi package directory is `pkg/pi-net-resume/`; its README is bilingual and is
the one users see on npm.

## 8. Rollback

```bash
./uninstall.sh
cp ~/.pi/agent/settings.json.bak.<timestamp> ~/.pi/agent/settings.json
```

---

## 中文

让 Linux/Jetson 板在手机热点重新打开后**几秒内自动连上**，并让因断网停下的 pi agent
在 Wi-Fi 恢复后**自动接着干活**。

```
wifi-fastlink/     Wi-Fi 快速重连看门狗（NetworkManager + nmcli，用户级 systemd 服务）
pkg/pi-net-resume/ 可发布的 pi 包（扩展 + 无头包装脚本）
tests/             22 个 Wi-Fi 状态机用例 + 15 个扩展用例，全部离线可跑
```

装 pi 侧：

```bash
pi install npm:pi-net-resume
```

装 Wi-Fi 侧（仅 Linux + NetworkManager，不需要 sudo）：

```bash
./install.sh
```

详见 [wifi-fastlink/README.md](wifi-fastlink/README.md)、
[pkg/pi-net-resume/README.md](pkg/pi-net-resume/README.md)；
**验收步骤见 [TESTING.md](TESTING.md)**。

### 一、原来为什么慢

NetworkManager 1.36 断线后只按几何退避去"找"已知网络（`SCAN_INTERVAL_SEC_MIN 3`
→ `SCAN_INTERVAL_SEC_MAX 120`）。热点关掉几分钟后，板子可能**两分钟才扫一次**。

同一个函数在断线状态下**允许显式扫描**（限流 1500ms）。`wifi-fastlink` 就卡着这个额度
持续扫描，盯着 AP 列表，目标 SSID 一出现立刻 `nmcli connection up`。

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| 热点打开 → 被扫到 | ≤ 一次扫描（约 1~3s） | 协议上只能靠扫描发现 |
| 发现 → 关联完成 | 0.5~1.5s | WPA2 四次握手 |
| 关联 → 拿到 IP | 0.3~1s | DHCP |
| **合计** | **约 2~5s** | 日志里的 `search_to_connected_ms` |

### 二、pi 为什么会停下来

pi 的重试是 `retry.maxRetries`（默认 3 次，退避 2s/4s/8s ≈ 14 秒）。断网超过 14 秒，
重试耗尽，pi 打一条错误然后**静默停住**，除非有人再敲键盘。

`pi-net-resume` 挂在 `agent_end`（记住连通性错误）与 `agent_settled`
（pi 真的放弃了）上，然后轮询链路并探测模型端点，最后往**同一会话**注入一条用户消息，
任务带着完整上下文继续。

`install.sh` 还会把 `retry.maxRetries` 从 3 提到 6（带时间戳备份），让短抖动由 pi 自己扛过；
不想要就 `./install.sh --no-retry-tuning`。

### 三、装了些什么

| 路径 | 作用 |
| --- | --- |
| `~/.local/share/wifi-fastlink/wifi_fastlink.py` | 看门狗主程序 |
| `~/.config/wifi-fastlink/config.json` | 目标 SSID 等（安装时填入当前 SSID） |
| `~/.config/systemd/user/wifi-fastlink.service` | 用户级服务，`Restart=always` |
| `~/.pi/agent/extensions/pi-net-resume/index.ts` | pi 扩展 |
| `~/.local/bin/pi-resume-run.sh` | 无头 `pi -p` 包装脚本 |
| `~/.local/state/wifi-fastlink/wifi-fastlink.log` | Wi-Fi 时间线（毫秒 + JSON 事件） |
| `~/.local/state/pi-net-resume/pi-net-resume.log` | 扩展证据链（JSON lines） |

### 四、日常用法

```bash
systemctl --user status wifi-fastlink
tail -f ~/.local/state/wifi-fastlink/wifi-fastlink.log
tail -f ~/.local/state/pi-net-resume/pi-net-resume.log

# pi 里
/net-resume            # 是否待命、已续跑几次、探测目标、配置路径
/net-resume off        # 本会话不要自动续跑
/net-resume now        # 立刻续跑一次

# 无头任务（最后一个参数是提示词，前面选项原样转给 pi）
pi-resume-run.sh --model <provider>/<model> "跑测试并修复失败"
```

### 五、适用范围：两半各自到底管什么

两半覆盖的是**同一次断网的不同层次**，各自都很窄，是有意的。按你的故障选：

| 你的故障 | 该用哪个 |
| --- | --- |
| AP 消失又出现（手机热点、随身路由） | **wifi-fastlink** |
| AP 连着但包出不去（宽带断、门户认证、路由器重启） | **只用 pi-net-resume** —— 链路本身没问题，看门狗正确地什么都不做 |
| pi 因 provider 报错停下、而人不在键盘前 | **pi-net-resume**（装不装看门狗都行） |
| 输出截断、HTTP 429、额度耗尽 | 两个都不管 —— 见 [pi-auto-resume](https://www.npmjs.com/package/pi-auto-resume) |

`wifi-fastlink` 只有在**同时满足**下列条件时才划算：Linux + NetworkManager；
AP 真的离开又回来；密码已保存；且你在意"~3 秒"和"NM 的 3 秒→120 秒退避"的差别。
它是**针对单一故障模式的精准工具**，不是通用网络组件：macOS、Windows、`iwd`、
`wpa_supplicant`、systemd-networkd 都不支持，并且需要一个 systemd 用户会话
（或任何进程管理器）来常驻。

没有硬编码任何 SSID、网卡名或路径：`targets` 默认为空（自动学习），
`interface` 默认 `auto`，当前 SSID 只在安装时**写进你自己的**
`~/.config/wifi-fastlink/config.json`。

### 六、老实话（限制）

* 发现热点只能靠扫描，"打开热点 → 连上"的下限是一次扫描（这里 1~3s）。
  5 秒目标可达，1 秒内不可能。
* 看门狗只在断线时工作；连上后 NetworkManager 禁止显式扫描，它只阻塞在 `nmcli monitor` 上。
* 只能连**已保存密码**的网络；全新 SSID 需先手动连一次，profile 名与 SSID 不同时用
  `connection_names` 映射。
* 已验证平台：Linux + NetworkManager 1.36（Jetson / RTL8822CE / iPhone 热点）。
  pi 扩展跨平台，`wifi-fastlink` 不是。
* `pi-net-resume` 对限流/欠费/鉴权类错误故意不动手；且无法区分"按 Esc 取消重试"与
  "重试耗尽"。打字或 `/net-resume off` 都能取消。
* 用户级服务只在登录会话中运行；要常驻：`sudo loginctl enable-linger $USER`。

### 七、发布

```bash
./publish-package.sh              # 只校验：测试、package.json、jiti 加载、tarball
./publish-package.sh --publish    # 再执行 npm publish
```

pi 包目录是 `pkg/pi-net-resume/`，其 README 为中英双语，也是用户在 npm 上看到的那份。

### 八、回滚

```bash
./uninstall.sh
cp ~/.pi/agent/settings.json.bak.<时间戳> ~/.pi/agent/settings.json
```
