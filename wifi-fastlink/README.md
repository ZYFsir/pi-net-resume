# wifi-fastlink

**English** | [中文](#中文)

Reconnects the machine to a preferred Wi-Fi hotspot as soon as the hotspot
appears, instead of waiting for NetworkManager's backed-off scan timer.

## The problem it solves

NetworkManager 1.36 (`src/core/devices/wifi/nm-device-wifi.c`) only rescans for
known networks on a geometric backoff while disconnected:

```c
#define SCAN_INTERVAL_SEC_MIN  3
#define SCAN_INTERVAL_SEC_STEP 20
#define SCAN_INTERVAL_SEC_MAX  120
...
priv->scan_periodic_interval_sec =
    NM_CLAMP(interval * 3 / 2, SCAN_INTERVAL_SEC_MIN, SCAN_INTERVAL_SEC_MAX);
```

3s → 4s → 6s → 9s → … → 120s. So after the phone hotspot has been off for a
couple of minutes, the board may look for it only **once every two minutes**.

The same function allows *explicit* scans while the device is disconnected
(`NM_DEVICE_STATE_DISCONNECTED` / `FAILED`), rate-limited to **1500 ms**
(8000 ms while activated, plus a 200 ms guard after a scan completes).

`wifi_fastlink.py` exploits exactly that: while it is not connected to one of
its target SSIDs it keeps asking for explicit scans, watches the access-point
list, and activates the saved connection the moment the SSID shows up.

When it *is* connected it does nothing but wait on `nmcli monitor` (event
driven, ~0% CPU) with a 20 s safety poll, so it does not burn power or airtime
while the hotspot is healthy.

## Install

```bash
./install.sh          # user service, no sudo
./install.sh --uninstall
```

Then, optionally, to keep it running when nobody is logged in:

```bash
sudo loginctl enable-linger "$USER"
```

## Config

`~/.config/wifi-fastlink/config.json` (created by `install.sh`, seeded with the
SSID you were connected to). The important keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `targets` | `[]` | SSIDs to reconnect to, in priority order. Empty = learn the current one. |
| `connection_names` | `{}` | SSID → NetworkManager profile name, if they differ. |
| `interface` | `"auto"` | Wi-Fi interface; auto picks the first managed one. |
| `poll_connected_ms` | `1000` | Safety-net re-check interval while connected (state changes from `nmcli monitor` wake it immediately). |
| `event_wait_s` | `20` | Max time to block on the NetworkManager event monitor while connected. |
| `scan_interval_ms` | `1200` | Explicit scan cadence while searching (NM clamps to ~1500 ms). |
| `activation_timeout_s` | `25` | `nmcli --wait` budget for one activation attempt. |
| `activate_on_sight` | `true` | Activate immediately instead of waiting for NM's own policy. |
| `takeover_other_networks` | `false` | Switch to a target SSID even when another network is already up. |
| `slow_after_s` | `0` | If >0, drop to `slow_scan_interval_ms` after this long searching. |
| `notify` | `false` | Desktop notification on reconnect. |
| `log_file` | `~/.local/state/wifi-fastlink/wifi-fastlink.log` | Timeline + JSON events. |

## Measuring it

Every transition is written with millisecond resolution:

```
INFO  hotspot 'hhh' is now visible
INFO  activating 'hhh' (attempt 1, 12ms after first sighting)
EVENT {"event":"connected","search_to_connected_ms":4180,"seen_to_connected_ms":3210,...}
```

* `heard` → `seen`: our polling latency (≤ one scan cycle).
* `ssid_seen` → `activated`: WPA association, measured by `seen_to_connected_ms`.
* total: `search_to_connected_ms` (search start → IP address present).

The hotspot-on moment itself is at most one scan period before `ssid_seen`.

## Useful commands

```bash
systemctl --user status wifi-fastlink
journalctl --user -u wifi-fastlink -f
python3 wifi_fastlink.py --selftest            # inspect NM, radio, APs
python3 wifi_fastlink.py --once --dry-run -v   # one cycle, change nothing
```

## When this is (and isn't) useful

This is a **targeted tool for one failure mode**, not a general networking
component. It pays off when **all** of these hold:

- **Linux with NetworkManager.** The whole approach comes from reading NM's own
  behaviour (`nm-device-wifi.c`): an explicit scan is always allowed while
  disconnected, rate-limited to 1500 ms, while the periodic scan backs off
  3s → 4s → 6s → … → 120s. Verified against NetworkManager 1.36. macOS, Windows,
  `iwd`, `wpa_supplicant` and systemd-networkd-managed setups are **not**
  supported; the logic would need a different backend per platform.
- **The AP physically disappears and comes back** — a phone hotspot, a mobile
  router, a car. If the AP never left, there is nothing to reconnect to.
- **The credentials are already saved in NetworkManager.** A brand-new SSID with
  no stored PSK cannot be joined automatically.
- **You want the reconnect latency bounded by ~one scan** rather than by NM's
  backoff, i.e. you care about the difference between ~3 s and ~2 minutes.
- **A systemd user session exists** (for the service). You can also run
  `wifi_fastlink.py` by hand, or under any supervisor.

It is **not** the right tool when:

- The platform is not Linux + NetworkManager (see above).
- The SSID has never been joined on this machine.
- **The outage is upstream**: the AP is in range and associated, but packets do
  not leave the network (ISP down, captive portal, router rebooted). This watcher
  only cares about the link, so it will correctly do nothing — and that is the
  case where [pi-net-resume](../pkg/pi-net-resume/README.md) still helps, because
  it probes whether the **model endpoint** is reachable rather than whether the
  link is up. The two components cover different layers of the same outage.
- There is no outage at all: while connected this tool only blocks on
  `nmcli monitor` and does nothing else.

### Configuring it for your network

Everything site-specific lives in `~/.config/wifi-fastlink/config.json`. No
SSID, interface name or path is hardcoded anywhere in this tool: `targets`
starts empty (`[]`, meaning "auto-learn the current SSID on first run"),
`interface` defaults to `auto`, and `install.sh` merely *seeds* `targets` with
whatever SSID the machine happens to be on at install time. Point it at a
different hotspot by editing that one file — or with
`wifi_fastlink.py --target <SSID> --once --dry-run` to try it without saving
anything.

## Notes / limits

* While **connected**, NetworkManager forbids explicit scans (the supplicant is
  associated), so this tool is quiet until the link actually drops.
* Activation uses the saved NetworkManager profile. A brand-new SSID that has
  never been joined has no PSK, so it cannot be joined automatically; map it via
  `connection_names` after joining it once.
* Scanning is the only way to discover a hotspot that is not connected, so the
  worst-case detection latency is roughly one scan (~1-3 s on the RTL8822CE
  here) plus the association and DHCP time.

---

## 中文

在热点重新出现的那一刻就连回去，而不是等 NetworkManager 那套退避后的扫描定时器。

### 它解决的痛点

NetworkManager 1.36（`src/core/devices/wifi/nm-device-wifi.c`）在断线状态下只按几何退避
去"找"已知网络：

```c
#define SCAN_INTERVAL_SEC_MIN  3
#define SCAN_INTERVAL_SEC_MAX  120
...
priv->scan_periodic_interval_sec =
    NM_CLAMP(interval * 3 / 2, SCAN_INTERVAL_SEC_MIN, SCAN_INTERVAL_SEC_MAX);
```

3s → 4s → 6s → 9s → … → 120s。所以手机热点关掉几分钟后，板子可能**两分钟才扫一次**。

同一个函数在设备处于 `NM_DEVICE_STATE_DISCONNECTED` / `FAILED` 时**允许显式扫描**，
限流 **1500 ms**（已连接时是 8000 ms，且扫描完成后还有 200 ms 的间隔）。

`wifi_fastlink.py` 就是卡着这个额度：只要没连上目标 SSID，就持续请求显式扫描、盯着 AP 列表，
目标 SSID 一出现立刻激活已保存的连接。

**已连接时它什么都不做**，只阻塞在 `nmcli monitor` 上（事件驱动，~0% CPU），
外加 20 秒兜底轮询 —— 所以热点健康时不烧电、不占空口。

### 安装

```bash
./install.sh              # 用户级服务，不需要 sudo
./install.sh --uninstall
```

可选，让它在你没登录时也能跑：

```bash
sudo loginctl enable-linger "$USER"
```

### 配置

`~/.config/wifi-fastlink/config.json`（由 `install.sh` 创建，并用你当时所在的 SSID 预填）。
关键项：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `targets` | `[]` | 要重连的 SSID，按优先级排列。空 = 自动学习当前连接 |
| `connection_names` | `{}` | SSID → NetworkManager 配置名映射（两者不同名时才需要） |
| `interface` | `"auto"` | 网卡；auto 取第一个受管 wifi 网卡 |
| `poll_connected_ms` | `1000` | 已连接时的兜底复查间隔（`nmcli monitor` 的事件会立刻唤醒它） |
| `event_wait_s` | `20` | 已连接时阻塞在事件监视器上的最长时间 |
| `scan_interval_ms` | `1200` | 搜索时的显式扫描节奏（NM 内部限制约 1500 ms） |
| `activation_timeout_s` | `25` | 单次激活的 `nmcli --wait` 预算 |
| `activate_on_sight` | `true` | 发现即激活，不等 NM 自己的策略 |
| `takeover_other_networks` | `false` | 已有别的网能用时，是否仍切到目标 SSID |
| `slow_after_s` | `0` | 大于 0 时，搜索这么久后降频到 `slow_scan_interval_ms` |
| `notify` | `false` | 重连成功时发桌面通知 |
| `log_file` | `~/.local/state/wifi-fastlink/wifi-fastlink.log` | 时间线 + JSON 事件 |

### 怎么测量

每次状态转换都按毫秒记录：

```
INFO  hotspot 'hhh' is now visible
INFO  activating 'hhh' (attempt 1, 12ms after first sighting)
EVENT {"event":"connected","search_to_connected_ms":4180,"seen_to_connected_ms":3210,...}
```

* `ssid_seen` → `connected`：关联 + 四次握手 + DHCP。
* `search_to_connected_ms`：搜索开始 → 拿到 IP。
* "你打开热点"的那一刻最多比 `ssid_seen` 晚一个扫描周期（协议上只能靠扫描发现）。

### 常用命令

```bash
systemctl --user status wifi-fastlink
journalctl --user -u wifi-fastlink -f
python3 wifi_fastlink.py --selftest            # 体检 NM、电台、可见 AP
python3 wifi_fastlink.py --once --dry-run -v   # 跑一个周期，不改动任何东西
```

### 适用范围（什么时候有用、什么时候没用）

这是**针对单一故障模式的精准工具**，不是通用网络组件。以下条件**全部满足**才划算：

* **Linux + NetworkManager**（在 NM 1.36 上验证）。macOS、Windows、`iwd`、
  `wpa_supplicant`、systemd-networkd 都**不支持**，换平台要换后端实现。
* **AP 真的消失又回来**（手机热点、随身路由、车机）。AP 没走过就没什么可重连的。
* **凭据已存在 NetworkManager 里**。全新 SSID 没有 PSK，无法自动连。
* **你在意"约一次扫描"和"NM 退避"的差别**（也就是 ~3 秒 vs ~2 分钟）。
* **有 systemd 用户会话**（跑服务用）；也可以直接手跑 `wifi_fastlink.py`，或用任何进程管理器。

**不适合**的情况：

* 平台不是 Linux + NetworkManager（见上）。
* 这台机器从没连过该 SSID。
* **故障在上游**：AP 在范围内、也关联上了，但包出不了网（宽带断、门户认证、路由器重启）。
  本看门狗只关心链路，所以它会正确地什么都不做 —— 而这种情况正是
  [pi-net-resume](../pkg/pi-net-resume/README.md) 还能派上用场的地方，因为它探的是
  **模型端点是否可达**，而不是链路是否 up。两者覆盖同一次断网的不同层次。
* 根本没有断网：已连接时它只阻塞在 `nmcli monitor` 上，不做别的事。

### 针对你自己的网络配置

所有与本机相关的东西都在 `~/.config/wifi-fastlink/config.json`。
本工具**没有硬编码任何** SSID、网卡名或路径：`targets` 默认为空（`[]`，即"首次运行自动学习"），
`interface` 默认 `auto`，`install.sh` 只是在安装时把你当时所在的 SSID **写进你自己**的配置。
要换成别的热点，改那一个文件即可 —— 或者用
`wifi_fastlink.py --target <SSID> --once --dry-run` 试一次而不保存任何东西。

### 注意事项 / 限制

* **已连接时** NetworkManager 禁止显式扫描（supplicant 处于关联状态），所以链路真正掉线前
  本工具是安静的。
* 激活用的是已保存的 NetworkManager 配置。从未连过的全新 SSID 没有 PSK，无法自动加入；
  先手动连一次，然后用 `connection_names` 建立映射。
* 扫描是发现未连接热点的唯一手段，所以最坏情况下的发现延迟约为一次扫描
  （这里的 RTL8822CE 上约 1~3 秒）加上关联与 DHCP 时间。
