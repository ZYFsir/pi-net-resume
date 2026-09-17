# 测试与验收

[中文](#测试与验收) | **English**（在文件后半部分，从 “Testing and acceptance” 开始）

## 0. 自动化测试（不碰网络，随时可跑）

```bash
cd pi_fast_resume

# Wi-Fi 看门狗状态机：22 个用例（假 NetworkManager + 假时钟）
python3 tests/test_wifi_fastlink.py

# 其中 3 个用例不过假的 adapter，而是拿一个模拟真实 nmcli 字段校验的桩脚本
# 跑 NmAdapter，防止 "参数写错但假 adapter 看不出来" 这类回归（例如
# `-f NAME` 在 `connection show <名字>` 下会被 nmcli 拒绝）。

# pi-net-resume 扩展：19 个用例（真实 TCP socket 模拟"断网/恢复"；含探测目标
# 解析、配置路径解析，以及"哪些错误归我们、哪些归 pi-auto-resume"的边界）
node --experimental-strip-types tests/test_net_resume.mjs

# 环境体检：网卡、电台、当前链路、可见 AP、目标 SSID 是否可见
python3 wifi-fastlink/wifi_fastlink.py --selftest

# 单次决策、不改动任何东西
python3 wifi-fastlink/wifi_fastlink.py --once --dry-run --target hhh

# 无头包装脚本：用法自检（退出码 2）+ 离线探测
# （用本机死端口当探针 = 必然判定离线，退出码 1，不碰真实网络）
pkg/pi-net-resume/pi-resume-run.sh
PI_RESUME_PROBE_HOST=127.0.0.1 PI_RESUME_PROBE_PORT=59999 \
  pkg/pi-net-resume/pi-resume-run.sh --check-online
```

## 1. 验收 Wi-Fi 5 秒内重连

这一步会真的断网，所以**先确认 pi 的会话已经空闲、不要再发消息**（断网期间 pi 无法调用模型）。
测试由人操作热点，脚本只记录时间线。

```bash
# 终端 A：实时看时间线
tail -f ~/.local/state/wifi-fastlink/wifi-fastlink.log

# 终端 B：确认服务在跑
systemctl --user status wifi-fastlink
```

步骤：

1. 在手机上**关掉个人热点**（或打开飞行模式）。
2. 观察日志出现：
   ```
   INFO  not connected to a target (hhh), searching
   EVENT {"event":"search_start", ...}
   ```
   （1 秒内出现说明看门狗已经进入搜索状态。）
3. 等 **2~3 分钟**（关键：让 NetworkManager 的周期扫描退避到 120 秒。
   如果不做这一步，NM 自己可能也会比较快连上，测不出差别。）
4. 在手机上**打开个人热点**，并记下打开的时刻。
5. 观察日志出现：
   ```
   INFO  hotspot 'hhh' is now visible
   INFO  activating 'hhh' (attempt 1, ...ms after first sighting)
   INFO  reconnected to 'hhh' (172.20.10.x/28) - ...ms from first sighting, ...ms from search start
   EVENT {"event":"connected","seen_to_connected_ms":...,"search_to_connected_ms":...}
   ```

判读方式：

| 指标 | 含义 | 目标 |
| --- | --- | --- |
| `search_start` → `ssid_seen` | 轮询/扫描节奏带来的发现延迟 | ≤ 一次扫描（约 1~3 s） |
| `seen_to_connected_ms` | 关联 + 4 次握手 + DHCP | 越小越好 |
| `search_to_connected_ms` | 搜索开始 → 拿到 IP | **参考值** |

注意：`ssid_seen` 时刻最多比"你打开热点"晚一个扫描周期（因为协议上只能靠扫描发现），
所以真正该看的是"打开热点 → connected"的墙钟差。想更精确，可以在第 4 步执行：

```bash
date +%s.%3N      # 在手机上按下"打开热点"的同时敲下回车
```

然后与日志里 `EVENT connected` 的 `ts` 相减。

如果 `search_to_connected_ms` 偏大：

* `ssid_seen` 来得晚 → 调小 `~/.config/wifi-fastlink/config.json` 里的 `scan_interval_ms`
  （NetworkManager 内部限制约 1500 ms，再小没有收益；扫描本身耗时才是主因）。
* `seen_to_connected_ms` 偏大 → 关联/DHCP 慢，可关注 `802-11-wireless.powersave`（关闭省电模式）。

## 2. 验收"pi agent 断网后自动继续"

### 2.1 自动化等价测试

`tests/test_net_resume.mjs` 里 "waits for the link to come back, then resumes the session"
用例就是完整流程：注入网络类错误 → pi 结束重试 → 等待 → 端口恢复 → 注入续跑消息。
跑通即说明扩展逻辑正确。

### 2.2 真实场景测试

```bash
# 终端 A：看扩展的 JSON 证据链
tail -f ~/.local/state/pi-net-resume/pi-net-resume.log

# 在 pi 里进入一个长任务，例如：
#   /net-resume            -> 查看状态（enabled / armed / 探针目标 / 配置路径）
#   让 pi 干一件要花几分钟的活
```

然后：

1. 任务进行中在手机上**关掉热点**。
2. 观察 pi 里出现重试提示，然后（默认 3 次、约 14 s 后）报错停下。
   若已启用 `retry.maxRetries=6`，约 2 分钟后才停下。
3. 日志应依次出现：
   ```json
   {"event":"network_error","message":"fetch failed"}
   {"event":"armed","detail":"NetworkManager reports disconnected"}
   {"event":"waiting_for_network","failureAt":...}
   ```
   同时 pi 底部状态栏显示 `network down - waiting to resume`。
4. 打开热点。等 wifi-fastlink 连上后（第 1 节已验证），扩展在下一个探针周期内
   （默认 `probeIntervalMs=3000`，加上 800 ms 链路稳定确认）判定可达并写入：
   ```json
   {"event":"auto_resume","resumeCount":1,"waitedMs":41300,"detail":"api.example.com:443 reachable"}
   ```
   pi 会话里出现一条用户消息"The network is back… continue"，并**继续原来的任务**。
5. 如果不想等它自动跑，`/net-resume off` 或直接打字即可取消。

### 2.3 只测扩展、不动真网络（可选）

用一个指向"死端口"的假 provider，可以随时重复演练：

```bash
cat > /tmp/dead-provider.ts <<'TS'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("dead", {
    baseUrl: "http://127.0.0.1:59999/v1",
    apiKey: "$DEAD_KEY",
    api: "openai-completions",
    models: [{ id: "dead", name: "dead", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000, maxTokens: 1024 }],
  });
}
TS
PI_NET_RESUME_CONFIG=/tmp/dead-config.json \
  pi -e ./pkg/pi-net-resume/index.ts -e /tmp/dead-provider.ts \
     --provider dead --model dead "hello"
```

**注意 `-p` 模式的限制**（实测确认）：`pi -p` 在 agent settle 之后**立刻退出**，
而扩展的续跑路径要再等 800ms 稳定 + 复检，所以进程已经没了 —— 你只能看到
`network_error → armed → waiting_for_network`，**看不到 `auto_resume`**。
这正说明 `-p` 场景必须用 `pi-resume-run.sh`（它负责把进程重新拉起来）。

要观察完整的 `auto_resume`，得用**交互式** pi（TUI 里任务跑到 settle 时不要关），
或者在 `/tmp/dead-config.json` 里把 `probeTimeoutMs` 调大观察 `armed` 之后的状态转换。
`-p` 模式的等价验证是自动化用例
（`tests/test_net_resume.mjs` 里的 "waits for the link to come back, then resumes the session"），
它用假 pi API 驱动同一条代码路径。

## 3. 常见问题排查

| 现象 | 检查 |
| --- | --- |
| 日志不更新 | `systemctl --user status wifi-fastlink`；`journalctl --user -u wifi-fastlink -n 50` |
| 一直搜不到目标 | `python3 wifi-fastlink/wifi_fastlink.py --selftest` 看 `visible APs` 里有没有目标 SSID；确认手机热点是广播 SSID 的 |
| 看得到但连不上 | 日志里 `activation ... failed`；确认 NetworkManager 里有同名配置：`nmcli -t -f NAME con show`，必要时配 `connection_names` |
| pi 不自动续跑 | `/net-resume` 看状态；确认扩展已加载（日志里有 `extension_loaded`）；确认错误属于连通性类（`errorPattern`）而不是限流/鉴权 |
| 扩展根本没加载 | `pi list` 看有没有 `npm:pi-net-resume`；再在 pi 里 `/reload` |
| 重启后服务没起来 | `Linger=no` 时用户级服务只在登录后运行：`sudo loginctl enable-linger $USER` |

## 4. 回滚

```bash
./uninstall.sh                                   # 停掉并移除两份组件
cp ~/.pi/agent/settings.json.bak.<时间戳> ~/.pi/agent/settings.json   # 还原 retry 调整
```

---

# Testing and acceptance (English)

## 0. Automated tests (offline, run them any time)

```bash
cd pi_fast_resume

# Wi-Fi watcher state machine: 22 cases (fake NetworkManager + fake clock).
# Three of them drive the real NmAdapter against a stub nmcli that enforces the
# same field validation the real tool does, so an argument-shape regression
# (e.g. `-f NAME` being rejected for the profile form of `connection show`)
# cannot pass unnoticed.
python3 tests/test_wifi_fastlink.py

# pi-net-resume extension: 19 cases (a real TCP socket stands in for
# "network down / back up"). Also covers probe-target parsing, config-path
# resolution, and the boundary with pi-auto-resume (which errors are ours).
node --experimental-strip-types tests/test_net_resume.mjs

# Environment health check: interface, radio, current link, visible APs.
python3 wifi-fastlink/wifi_fastlink.py --selftest

# One decision cycle, changing nothing.
python3 wifi-fastlink/wifi_fastlink.py --once --dry-run --target <SSID>

# Headless wrapper: usage self-check (exit 2) + an offline probe
# (a dead local port = reliably offline, exit 1; no real network involved).
pkg/pi-net-resume/pi-resume-run.sh
PI_RESUME_PROBE_HOST=127.0.0.1 PI_RESUME_PROBE_PORT=59999 \
  pkg/pi-net-resume/pi-resume-run.sh --check-online
```

## 1. Accepting the "reconnect within 5 seconds" claim

This step really does cut the network, so **make sure the pi session is idle and
that you are not going to send a message** (while offline pi cannot reach the
model). A human operates the hotspot; the script only records the timeline.

```bash
# terminal A: watch the timeline
tail -f ~/.local/state/wifi-fastlink/wifi-fastlink.log

# terminal B: confirm the service is running
systemctl --user status wifi-fastlink
```

Procedure:

1. Turn the phone hotspot **off** (or enable airplane mode).
2. The log should show:
   ```
   INFO  not connected to a target (hhh), searching
   EVENT {"event":"search_start", ...}
   ```
   (appearing within a second means the watcher entered the search state)
3. Wait **2–3 minutes**. This matters: it lets NetworkManager's periodic scan
   back off to 120 s. Skip it and NM may reconnect quickly on its own, hiding the
   difference this tool makes.
4. Turn the hotspot **on**, and note the moment you did it.
5. The log should then show:
   ```
   INFO  hotspot 'hhh' is now visible
   INFO  activating 'hhh' (attempt 1, ...ms after first sighting)
   INFO  reconnected to 'hhh' (172.20.10.x/28) - ...ms from first sighting, ...ms from search start
   EVENT {"event":"connected","seen_to_connected_ms":...,"search_to_connected_ms":...}
   ```

How to read it:

| Metric | Meaning | Target |
| --- | --- | --- |
| `search_start` → `ssid_seen` | discovery latency from the scan cadence | ≤ one scan (~1–3 s) |
| `seen_to_connected_ms` | association + 4-way handshake + DHCP | as small as possible |
| `search_to_connected_ms` | search start → IP address | reference value |

Note that `ssid_seen` can be up to one scan period after you switched the hotspot
on, because scanning is the only way to discover it. So the number that really
matters is wall-clock "hotspot on → connected". To measure it precisely, run this
at the moment you press the button on the phone:

```bash
date +%s.%3N
```

then subtract it from the `ts` of the `EVENT connected` line.

If `search_to_connected_ms` is too large:

* `ssid_seen` arrives late → lower `scan_interval_ms` in
  `~/.config/wifi-fastlink/config.json` (NetworkManager clamps to ~1500 ms; below
  that buys nothing, since the scan itself is the cost).
* `seen_to_connected_ms` is large → association/DHCP is slow; look at
  `802-11-wireless.powersave` (turn power saving off).

## 2. Accepting "the pi agent continues after an outage"

### 2.1 The automated equivalent

The "waits for the link to come back, then resumes the session" case in
`tests/test_net_resume.mjs` is the whole flow: inject a connectivity error → pi
stops retrying → wait → the port comes back → the continuation message is
injected. If it passes, the extension's logic is correct.

### 2.2 The real scenario

```bash
# terminal A: follow the extension's JSON evidence chain
tail -f ~/.local/state/pi-net-resume/pi-net-resume.log

# inside pi: start something that takes a few minutes
#   /net-resume            -> status (enabled / armed / probe target / config path)
```

Then:

1. Turn the hotspot **off** while the task is running.
2. pi shows retry warnings and then (after 3 retries, ~14 s by default) gives up
   with an error. With `retry.maxRetries=6` it takes about two minutes.
3. The log should show, in order:
   ```json
   {"event":"network_error","message":"fetch failed"}
   {"event":"armed","detail":"NetworkManager reports disconnected"}
   {"event":"waiting_for_network","failureAt":...}
   ```
   and the pi footer shows `network down - waiting to resume`.
4. Turn the hotspot back on. Once wifi-fastlink has reconnected (verified in
   section 1), the extension's next probe succeeds and it writes:
   ```json
   {"event":"auto_resume","resumeCount":1,"waitedMs":41300,"detail":"api.example.com:443 reachable"}
   ```
   A user message ("The network is back… continue") appears in the session and
   **the original task carries on**.
5. If you would rather not wait for it, `/net-resume off`, or just type
   something, cancels it.

### 2.3 Testing the extension alone, without touching the real network

Point it at a dead port with a fake provider, and you can rehearse on demand:

```bash
cat > /tmp/dead-provider.ts <<'TS'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("dead", {
    baseUrl: "http://127.0.0.1:59999/v1",
    apiKey: "$DEAD_KEY",
    api: "openai-completions",
    models: [{ id: "dead", name: "dead", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000, maxTokens: 1024 }],
  });
}
TS
PI_NET_RESUME_CONFIG=/tmp/dead-config.json \
  pi -e ./pkg/pi-net-resume/index.ts -e /tmp/dead-provider.ts \
     --provider dead --model dead "hello"
```

With `armOnlyWhenOffline=false` and `maxAutoResumes=1` in
`/tmp/dead-config.json`, you will see `network_error → armed → waiting_for_network`.

**Note the `-p` limitation** (verified): `pi -p` exits as soon as the agent settles,
while the resume path still has to wait ~800ms for routes to stabilise and then
re-probe — so the process is already gone and **`auto_resume` never appears**.
That is precisely why `pi-resume-run.sh` exists for `-p` runs: it is the thing
that relaunches the process.

To watch a full `auto_resume`, use an interactive pi session. The automated
equivalent is the "waits for the link to come back, then resumes the session"
case in `tests/test_net_resume.mjs`, which drives the same code path with a fake
pi API.

## 3. Troubleshooting

| Symptom | Check |
| --- | --- |
| The log never updates | `systemctl --user status wifi-fastlink`; `journalctl --user -u wifi-fastlink -n 50` |
| The target is never found | `python3 wifi-fastlink/wifi_fastlink.py --selftest` and look for the SSID under `visible APs`; make sure the hotspot broadcasts its SSID |
| Visible but will not connect | `activation ... failed` in the log; confirm a profile with that name exists (`nmcli -t -f NAME con show`), and map it via `connection_names` if needed |
| pi does not auto-resume | `/net-resume` for status; confirm the extension loaded (an `extension_loaded` line in the log); confirm the error is connectivity-class rather than rate-limit/auth |
| The extension is not loaded at all | `pi list` should show `npm:pi-net-resume`; then `/reload` inside pi |
| The service does not survive logout | with `Linger=no` a user service only runs while you are logged in: `sudo loginctl enable-linger $USER` |

## 4. Uninstalling

```bash
./uninstall.sh                                   # stop and remove both components
cp ~/.pi/agent/settings.json.bak.<timestamp> ~/.pi/agent/settings.json   # undo the retry tuning
```
