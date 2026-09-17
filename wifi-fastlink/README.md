# wifi-fastlink

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
