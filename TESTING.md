# 测试与验收

## 0. 自动化测试（不碰网络，随时可跑）

```bash
cd pi_fast_resume

# Wi-Fi 看门狗状态机：22 个用例（假 NetworkManager + 假时钟）
python3 tests/test_wifi_fastlink.py

# 其中 3 个用例不过假的 adapter，而是拿一个模拟真实 nmcli 字段校验的桩脚本
# 跑 NmAdapter，防止 "参数写错但假 adapter 看不出来" 这类回归（例如
# `-f NAME` 在 `connection show <名字>` 下会被 nmcli 拒绝）。

# pi-net-resume 扩展：10 个用例（真实 TCP socket 模拟"断网/恢复"）
node --experimental-strip-types tests/test_net_resume.mjs

# 环境体检：网卡、电台、当前链路、可见 AP、目标 SSID 是否可见
python3 wifi-fastlink/wifi_fastlink.py --selftest

# 单次决策、不改动任何东西
python3 wifi-fastlink/wifi_fastlink.py --once --dry-run --target hhh

# 无头包装脚本：用法自检（退出码 2）+ 离线探测
# （用本机死端口当探针 = 必然判定离线，退出码 1，不碰真实网络）
pi-net-resume/pi-resume-run.sh
PI_RESUME_PROBE_HOST=127.0.0.1 PI_RESUME_PROBE_PORT=59999 \
  pi-net-resume/pi-resume-run.sh --check-online
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
  pi -e ./pi-net-resume/index.ts -e /tmp/dead-provider.ts \
     --provider dead --model dead "hello"
```

只要 `/tmp/dead-config.json` 里 `armOnlyWhenOffline=false`、`maxAutoResumes=1`，
就能观察到 "network_error → armed → auto_resume"，第二次失败后触发上限保护。

## 3. 常见问题排查

| 现象 | 检查 |
| --- | --- |
| 日志不更新 | `systemctl --user status wifi-fastlink`；`journalctl --user -u wifi-fastlink -n 50` |
| 一直搜不到目标 | `python3 wifi-fastlink/wifi_fastlink.py --selftest` 看 `visible APs` 里有没有目标 SSID；确认手机热点是广播 SSID 的 |
| 看得到但连不上 | 日志里 `activation ... failed`；确认 NetworkManager 里有同名配置：`nmcli -t -f NAME con show`，必要时配 `connection_names` |
| pi 不自动续跑 | `/net-resume` 看状态；确认扩展已加载（日志里有 `extension_loaded`）；确认错误属于连通性类（`errorPattern`）而不是限流/鉴权 |
| 扩展根本没加载 | `ls ~/.pi/agent/extensions/pi-net-resume/`；在 pi 里执行 `/reload` |
| 重启后服务没起来 | `Linger=no` 时用户级服务只在登录后运行：`sudo loginctl enable-linger $USER` |

## 4. 回滚

```bash
./uninstall.sh                                   # 停掉并移除两份组件
cp ~/.pi/agent/settings.json.bak.<时间戳> ~/.pi/agent/settings.json   # 还原 retry 调整
```
