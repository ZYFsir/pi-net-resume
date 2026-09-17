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

## Notes / limits

* While **connected**, NetworkManager forbids explicit scans (the supplicant is
  associated), so this tool is quiet until the link actually drops.
* Activation uses the saved NetworkManager profile. A brand-new SSID that has
  never been joined has no PSK, so it cannot be joined automatically; map it via
  `connection_names` after joining it once.
* Scanning is the only way to discover a hotspot that is not connected, so the
  worst-case detection latency is roughly one scan (~1-3 s on the RTL8822CE
  here) plus the association and DHCP time.
