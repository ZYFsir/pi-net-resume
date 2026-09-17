#!/usr/bin/env python3
"""wifi-fastlink - reconnect to a preferred Wi-Fi hotspot within seconds.

Why this exists
---------------
NetworkManager only rescans for known networks on a *backed off* schedule while
the device is disconnected.  In NetworkManager 1.36 (nm-device-wifi.c):

    #define SCAN_INTERVAL_SEC_MIN  3
    #define SCAN_INTERVAL_SEC_STEP 20      /* interval = clamp(interval*3/2, ...) */
    #define SCAN_INTERVAL_SEC_MAX  120

    priv->scan_periodic_interval_sec =
        NM_CLAMP(interval * 3 / 2, SCAN_INTERVAL_SEC_MIN, SCAN_INTERVAL_SEC_MAX);

so the periodic scan cadence drifts 3s -> 4s -> 6s -> 9s -> ... -> 120s.  After a
couple of minutes without the hotspot, the machine may only look for it once
every two minutes.

But the same function allows *explicit* scans while disconnected:

    } else if (NM_IN_SET(state, NM_DEVICE_STATE_DISCONNECTED, NM_DEVICE_STATE_FAILED)) {
        /* Can always scan when disconnected */
        explicit_allowed = TRUE;
        periodic_allowed = TRUE;
    } else if (NM_IN_SET(state, NM_DEVICE_STATE_ACTIVATED)) {
        /* Prohibit periodic scans when connected ... */
        explicit_allowed = <false while associated>;
    }

    /* while activated NM rate limits to 8000ms, otherwise 1500ms, plus a
       200ms guard after the previous scan completed */

So while disconnected we may ask for an explicit scan every ~1.5s, and we do:
this watcher polls the device state, fires an explicit scan as often as NM
accepts one, watches the access-point list, and activates the known connection
the instant the target SSID shows up.

Every interesting transition is logged with millisecond timestamps and a
machine-readable `EVENT {...}` JSON line, so the reconnect latency can be
measured instead of guessed.

Usage
-----
    wifi_fastlink.py                      # run the watcher (foreground)
    wifi_fastlink.py --once               # single decision cycle, then exit
    wifi_fastlink.py --dry-run            # never activate anything, just log
    wifi_fastlink.py --selftest           # inspect the environment and exit
    wifi_fastlink.py --config /path.json
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

VERSION = "1.0.0"

# NetworkManager device states (nm-device.h)
NM_STATE_UNKNOWN = 0
NM_STATE_UNMANAGED = 10
NM_STATE_UNAVAILABLE = 20
NM_STATE_DISCONNECTED = 30
NM_STATE_PREPARE = 40
NM_STATE_IP_CHECK = 80
NM_STATE_DEACTIVATING = 110
NM_STATE_ACTIVATED = 100
# 40..90 means NetworkManager is already bringing something up.
NM_STATES_ACTIVATING = range(NM_STATE_PREPARE, 100)

DEFAULT_CONFIG = {
    # SSIDs we want to be connected to, in priority order.
    # Empty list => learn the currently connected SSID on first run.
    "targets": [],
    # Optional SSID -> NetworkManager connection name override.
    "connection_names": {},
    # "auto" picks the first managed wifi interface.
    "interface": "auto",
    # How often to look when already connected to a target.  When the nmcli
    # monitor is healthy this is only a safety net; state changes wake us up.
    "poll_connected_ms": 1000,
    # Max time to block on the NetworkManager monitor while connected.
    "event_wait_s": 20,
    # Delay between scan attempts while searching (NM enforces ~1500ms).
    "scan_interval_ms": 1200,
    # Give up on one activation attempt after this long and retry.
    "activation_timeout_s": 25,
    # Attempt activation as soon as the SSID is visible (instead of waiting for
    # NetworkManager's own auto-activate, which can be backed off after failures).
    "activate_on_sight": True,
    # If another known network is already up and working, do not steal the radio
    # from it just because a target SSID became visible.
    "takeover_other_networks": False,
    # Log file; empty string disables file logging.
    "log_file": "~/.local/state/wifi-fastlink/wifi-fastlink.log",
    # Grow log up to this size before truncating in place.
    "log_max_bytes": 2 * 1024 * 1024,
    # Desktop notification on reconnect (best effort, needs notify-send).
    "notify": False,
    # Do not fight the user: if wifi radio is switched off, wait this long.
    "radio_off_poll_s": 5,
    # If the target SSID stays invisible this long, drop back to a slower scan
    # cadence to save power/airtime.  0 disables the slowdown.
    "slow_after_s": 0,
    "slow_scan_interval_ms": 5000,
    "verbose": False,
}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def now_ms() -> int:
    return int(time.time() * 1000)


def expand(path: str) -> str:
    return os.path.expanduser(os.path.expandvars(path)) if path else path


def unescape_nm(field: str) -> str:
    """Undo nmcli terse-mode escaping (backslash escapes for ':' and '\\')."""
    out = []
    i = 0
    while i < len(field):
        c = field[i]
        if c == "\\" and i + 1 < len(field):
            out.append(field[i + 1])
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def split_nm_line(line: str) -> list[str]:
    """Split a nmcli -t line on unescaped colons."""
    fields = []
    cur = []
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(c)
            cur.append(line[i + 1])
            i += 2
            continue
        if c == ":":
            fields.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    fields.append("".join(cur))
    return [unescape_nm(f) for f in fields]


class NmError(RuntimeError):
    pass


class Logger:
    def __init__(self, path: str = "", max_bytes: int = 0, verbose: bool = False):
        self.path = expand(path) if path else ""
        self.max_bytes = max_bytes
        self.verbose = verbose
        if self.path:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self._rotate_if_needed()

    def _rotate_if_needed(self) -> None:
        try:
            if self.max_bytes and os.path.getsize(self.path) > self.max_bytes:
                with open(self.path + ".1", "w", encoding="utf-8") as fh:
                    with open(self.path, encoding="utf-8") as src:
                        fh.write(src.read()[-self.max_bytes // 2 :])
                os.truncate(self.path, 0)
        except OSError:
            pass

    def _write(self, line: str) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        full = f"{stamp}.{now_ms() % 1000:03d} {line}"
        if self.verbose:
            print(full, file=sys.stderr, flush=True)
        if self.path:
            try:
                with open(self.path, "a", encoding="utf-8") as fh:
                    fh.write(full + "\n")
            except OSError:
                pass

    def info(self, msg: str) -> None:
        self._write(f"INFO  {msg}")

    def debug(self, msg: str) -> None:
        if self.verbose:
            self._write(f"DEBUG {msg}")

    def warn(self, msg: str) -> None:
        self._write(f"WARN  {msg}")

    def event(self, name: str, **data) -> None:
        payload = {"ts": now_ms(), "event": name}
        payload.update(data)
        self._write("EVENT " + json.dumps(payload, ensure_ascii=False, sort_keys=True))


# --------------------------------------------------------------------------- #
# NetworkManager adapter
# --------------------------------------------------------------------------- #

class NmAdapter:
    """Minimal nmcli wrapper.  All calls force an English locale."""

    def __init__(self, nmcli: str = "nmcli", timeout: float = 20.0):
        self.nmcli = nmcli
        self.timeout = timeout
        self._monitor_proc: subprocess.Popen | None = None
        self._monitor_queue: queue.Queue | None = None
        self._monitor_env: dict = {}

    # -- low level ---------------------------------------------------------

    def _run(self, args: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["LC_ALL"] = "C"
        env["LANG"] = "C"
        return subprocess.run(
            [self.nmcli, *args],
            capture_output=True,
            text=True,
            timeout=timeout if timeout is not None else self.timeout,
            env=env,
            check=False,
        )

    # -- event monitor -----------------------------------------------------

    def start_monitor(self) -> bool:
        """Keep a `nmcli monitor` reader alive; True when it is running.

        Polling nmcli twice a second costs a few percent of a core, which is a
        lot for a board that lives on a phone hotspot.  NetworkManager already
        knows when the link comes and goes, so listen to it instead and use
        polling only as a safety net.
        """
        if self.monitor_active():
            return True
        if not self.available():
            return False
        env = dict(os.environ)
        env["LC_ALL"] = "C"
        env["LANG"] = "C"
        try:
            self._monitor_proc = subprocess.Popen(
                [self.nmcli, "monitor"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                env=env,
            )
        except OSError:
            self._monitor_proc = None
            return False
        self._monitor_queue = queue.Queue()
        proc, q = self._monitor_proc, self._monitor_queue

        def _reader() -> None:
            try:
                for line in proc.stdout:  # type: ignore[union-attr]
                    q.put(line)
            except Exception:
                pass
            q.put("")  # EOF marker so waiters wake up

        threading.Thread(target=_reader, name="nmcli-monitor", daemon=True).start()
        return True

    def monitor_active(self) -> bool:
        return self._monitor_proc is not None and self._monitor_proc.poll() is None

    def wait_for_change(self, timeout_s: float) -> bool:
        """Block until NetworkManager reports a change, or the timeout passes."""
        if not self.monitor_active() or self._monitor_queue is None:
            return False
        try:
            line = self._monitor_queue.get(timeout=timeout_s)
        except queue.Empty:
            return False
        if not line:  # monitor died; let the caller fall back to polling
            return False
        while True:  # drain the backlog so we re-check once, not N times
            try:
                self._monitor_queue.get_nowait()
            except queue.Empty:
                break
        return True

    def stop_monitor(self) -> None:
        proc = self._monitor_proc
        self._monitor_proc = None
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def _lines(self, args: list[str], timeout: float | None = None) -> list[str]:
        proc = self._run(args, timeout)
        if proc.returncode != 0:
            raise NmError(f"nmcli {' '.join(args)} failed: {proc.stderr.strip()}")
        return [ln for ln in proc.stdout.splitlines() if ln.strip()]

    # -- queries -----------------------------------------------------------

    def available(self) -> bool:
        return shutil.which(self.nmcli) is not None

    def wifi_interfaces(self) -> list[str]:
        out = []
        for line in self._lines(["-t", "-f", "DEVICE,TYPE", "dev", "status"]):
            parts = split_nm_line(line)
            if len(parts) >= 2 and parts[1] == "wifi" and not parts[0].startswith("p2p-"):
                out.append(parts[0])
        return out

    def device_state(self, iface: str) -> tuple[int, str, list[str]]:
        """Return (numeric state, connection name, ipv4 addresses)."""
        state = NM_STATE_UNKNOWN
        con = ""
        addrs: list[str] = []
        for line in self._lines(
            ["-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS", "dev", "show", iface]
        ):
            key, _, value = line.partition(":")
            value = value.strip()
            if key == "GENERAL.STATE":
                m = re.match(r"(\d+)", value)
                if m:
                    state = int(m.group(1))
            elif key == "GENERAL.CONNECTION":
                con = "" if value in ("--", "") else value
            elif key.startswith("IP4.ADDRESS"):
                if value:
                    addrs.append(value)
        return state, con, addrs

    def radio_wifi_enabled(self) -> bool:
        out = self._lines(["-t", "radio"])
        # "wifi-hw:wifi:wwan-hw:wwan"
        for line in out:
            fields = line.split(":")
            if len(fields) >= 2:
                return fields[1] == "enabled"
        return True

    def general_state(self) -> tuple[str, str]:
        for line in self._lines(["-t", "-f", "STATE,CONNECTIVITY", "general"]):
            parts = line.split(":")
            if len(parts) >= 2:
                return parts[0], parts[1]
        return "unknown", "unknown"

    def visible_ssids(self) -> set[str]:
        ssids = set()
        for line in self._lines(["-t", "-f", "SSID", "dev", "wifi", "list"]):
            for field in split_nm_line(line):
                if field:
                    ssids.add(field)
        return ssids

    def connection_exists(self, name: str) -> bool:
        # `-f NAME` is only valid for the *list* form of `connection show`.
        # With a profile argument nmcli 1.36 answers "invalid field 'NAME'" and
        # exits 2, which made every saved profile look missing.  `connection.id`
        # is accepted by the list form and the profile form alike.
        try:
            self._lines(["-t", "-f", "connection.id", "connection", "show", name])
            return True
        except NmError:
            return False

    def connection_ssid(self, name: str) -> str:
        try:
            for line in self._lines(["-t", "-f", "802-11-wireless.ssid", "connection", "show", name]):
                fields = split_nm_line(line)
                if len(fields) >= 2 and fields[1]:
                    return fields[1]
        except NmError:
            pass
        return ""

    # -- actions -----------------------------------------------------------

    def request_scan(self, iface: str) -> bool:
        """Ask for an explicit scan.  NM drops requests inside its 1.5s rate
        limit, so failures here are normal and are not treated as errors."""
        proc = self._run(["dev", "wifi", "rescan", "ifname", iface], timeout=8)
        return proc.returncode == 0

    def activate(self, name: str, iface: str, timeout_s: float) -> tuple[bool, str]:
        proc = self._run(
            ["--wait", str(int(timeout_s)), "connection", "up", name, "ifname", iface],
            timeout=timeout_s + 10,
        )
        msg = (proc.stdout + proc.stderr).strip().replace("\n", " ")
        return proc.returncode == 0, msg


# --------------------------------------------------------------------------- #
# engine
# --------------------------------------------------------------------------- #

class Engine:
    """The decision loop, with the adapter injected so it can be unit tested."""

    def __init__(self, adapter, logger: Logger, config: dict):
        self.nm = adapter
        self.log = logger
        self.cfg = config
        self.running = True
        self.iface: str | None = config.get("interface") if config.get("interface") != "auto" else None
        self.targets: list[str] = list(config.get("targets") or [])
        self.dry_run: bool = bool(config.get("dry_run"))
        self._seen_at_ms: int | None = None
        self._outage_started_ms: int | None = None
        self._activation_started_ms: int | None = None
        self._activation_attempts = 0
        self._scans_requested = 0
        self._last_scan_ms = 0
        self._learned_target = False
        self._holding = False

    # -- config ------------------------------------------------------------

    @property
    def connection_names(self) -> dict:
        return dict(self.cfg.get("connection_names") or {})

    def connection_for(self, ssid: str) -> str:
        return self.connection_names.get(ssid, ssid)

    # -- lookups -----------------------------------------------------------

    def pick_interface(self) -> str | None:
        if self.iface:
            return self.iface
        ifaces = self.nm.wifi_interfaces()
        if not ifaces:
            return None
        self.iface = ifaces[0]
        self.log.info(f"using wifi interface {self.iface}")
        return self.iface

    def learn_targets(self, active_con: str) -> None:
        """First run convenience: remember whatever we are connected to now."""
        if self.targets or self._learned_target:
            return
        self._learned_target = True
        if active_con:
            self.targets = [active_con]
            self.log.info(
                f"no targets configured - learned '{active_con}' from the current connection"
            )

    # -- one cycle ---------------------------------------------------------

    def step(self) -> str:
        """Run one decision cycle.  Returns a short status string."""
        if not self.nm.radio_wifi_enabled():
            self.log.debug("wifi radio is off, waiting")
            return "radio-off"

        iface = self.pick_interface()
        if not iface:
            self.log.debug("no managed wifi interface")
            return "no-interface"

        state, con, addrs = self.nm.device_state(iface)
        self.learn_targets(con)

        if not self.targets:
            self.log.warn("no target SSIDs configured and none could be learned")
            return "no-targets"

        connected_target = con if con in self.targets else None
        if state == NM_STATE_ACTIVATED and connected_target and addrs:
            self.on_connected(connected_target, addrs)
            return "connected"

        # Not connected to a target: search.
        self.on_disconnected(state, con)
        return "searching"

    # -- transitions -------------------------------------------------------

    def on_disconnected(self, state: int, active_con: str) -> None:
        if self._outage_started_ms is None:
            self._outage_started_ms = now_ms()
            if state == NM_STATE_ACTIVATED and active_con and active_con not in self.targets:
                self.log.info(
                    f"connected to '{active_con}' but waiting for a target "
                    f"({', '.join(self.targets)})"
                )
            else:
                self.log.info(f"not connected to a target ({', '.join(self.targets)}), searching")
            self.log.event("search_start", targets=self.targets, state=state, connection=active_con)

        self.maybe_scan()

        visible = self.nm.visible_ssids()
        hit = next((t for t in self.targets if t in visible), None)
        if hit:
            self.on_target_seen(hit, state, active_con)
        else:
            self.log.debug(
                f"target not visible ({len(visible)} APs seen); "
                f"scans requested: {self._scans_requested}"
            )
            self._seen_at_ms = None

    def maybe_scan(self) -> None:
        interval_ms = int(self.cfg.get("scan_interval_ms", 900))
        slow_after = float(self.cfg.get("slow_after_s", 0) or 0)
        if slow_after and self._outage_started_ms is not None:
            if (now_ms() - self._outage_started_ms) / 1000.0 > slow_after:
                interval_ms = int(self.cfg.get("slow_scan_interval_ms", 5000))
        if now_ms() - self._last_scan_ms >= interval_ms:
            if self.nm.request_scan(self.iface):
                self._scans_requested += 1
            self._last_scan_ms = now_ms()

    def on_target_seen(self, ssid: str, state: int = NM_STATE_DISCONNECTED, active_con: str = "") -> None:
        if self._seen_at_ms is None:
            self._seen_at_ms = now_ms()
            self.log.info(f"hotspot '{ssid}' is now visible")
            self.log.event(
                "ssid_seen",
                ssid=ssid,
                after_search_ms=self._seen_at_ms - (self._outage_started_ms or self._seen_at_ms),
                scans=self._scans_requested,
            )

        if not self.cfg.get("activate_on_sight", True):
            return
        if state in NM_STATES_ACTIVATING:
            self.log.debug("NetworkManager is already activating, waiting for it")
            return
        if (
            state == NM_STATE_ACTIVATED
            and active_con
            and active_con != ssid
            and not self.cfg.get("takeover_other_networks", False)
        ):
            if not self._holding:
                self._holding = True
                self.log.info(
                    f"keeping the working connection '{active_con}' "
                    f"(set takeover_other_networks to switch to '{ssid}')"
                )
            return
        if self.dry_run:
            self.log.debug(f"[dry-run] would activate '{self.connection_for(ssid)}'")
            return

        name = self.connection_for(ssid)
        if not self.nm.connection_exists(name):
            if self._activation_attempts == 0:
                self.log.warn(
                    f"'{ssid}' is visible but no saved connection named '{name}' exists; "
                    "create one (nmcli device wifi connect) or map it via connection_names"
                )
                self.log.event("no_connection_profile", ssid=ssid, connection=name)
            self._activation_attempts += 1
            return

        self._activation_attempts += 1
        self._activation_started_ms = now_ms()
        self.log.info(
            f"activating '{name}' (attempt {self._activation_attempts}, "
            f"{self._activation_started_ms - self._seen_at_ms}ms after first sighting)"
        )
        self.log.event(
            "activate_start",
            ssid=ssid,
            connection=name,
            attempt=self._activation_attempts,
            seen_to_activate_ms=self._activation_started_ms - (self._seen_at_ms or now_ms()),
        )
        ok, msg = self.nm.activate(name, self.iface, float(self.cfg.get("activation_timeout_s", 25)))
        self.log.event("activate_result", connection=name, ok=ok, message=msg[:400])
        if not ok:
            self.log.warn(f"activation of '{name}' failed: {msg[:200]}")

    def on_connected(self, ssid: str, addrs: list[str]) -> None:
        if self._outage_started_ms is None:
            # Already connected when the watcher started.
            self._outage_started_ms = now_ms()
        self.log.debug(f"connected to '{ssid}' with {addrs[0]}")
        if self._seen_at_ms is not None:
            seen = self._seen_at_ms
            self.log.info(
                f"reconnected to '{ssid}' ({addrs[0]}) - "
                f"{now_ms() - seen}ms from first sighting, "
                f"{now_ms() - (self._outage_started_ms or seen)}ms from search start"
            )
            self.log.event(
                "connected",
                ssid=ssid,
                address=addrs[0],
                seen_to_connected_ms=now_ms() - seen,
                search_to_connected_ms=now_ms() - (self._outage_started_ms or seen),
                scans=self._scans_requested,
                activation_attempts=self._activation_attempts,
            )
            self.notify(f"Wi-Fi '{ssid}' reconnected in {now_ms() - seen}ms")
        self.reset_tracking()

    def reset_tracking(self) -> None:
        self._seen_at_ms = None
        self._outage_started_ms = None
        self._activation_started_ms = None
        self._activation_attempts = 0
        self._scans_requested = 0
        self._last_scan_ms = 0
        self._holding = False

    def notify(self, text: str) -> None:
        if not self.cfg.get("notify"):
            return
        if not shutil.which("notify-send"):
            return
        try:
            subprocess.run(
                ["notify-send", "-a", "wifi-fastlink", "Wi-Fi", text],
                timeout=5,
                check=False,
                capture_output=True,
            )
        except Exception:
            pass

    # -- loop --------------------------------------------------------------

    def run(self, max_cycles: int | None = None) -> None:
        cycles = 0
        self.nm.start_monitor()
        try:
            while self.running and (max_cycles is None or cycles < max_cycles):
                if not self.nm.monitor_active():
                    self.nm.start_monitor()
                cycles += 1
                started = time.monotonic()
                try:
                    status = self.step()
                except NmError as exc:
                    if not self.running:
                        break
                    self.log.warn(f"nmcli error: {exc}")
                    status = "error"
                except subprocess.TimeoutExpired:
                    if not self.running:
                        break
                    self.log.warn("nmcli call timed out")
                    status = "timeout"
                except Exception as exc:  # keep the service alive
                    self.log.warn(f"unexpected error: {exc!r}")
                    status = "error"

                if not self.running:
                    break
                sleep_s = self._sleep_for(status)
                elapsed = time.monotonic() - started
                if sleep_s > elapsed:
                    self._wait(sleep_s - elapsed, status)
        finally:
            self.nm.stop_monitor()

    def _sleep_for(self, status: str) -> float:
        if status == "connected":
            return float(self.cfg.get("poll_connected_ms", 1000)) / 1000.0
        if status == "radio-off":
            return float(self.cfg.get("radio_off_poll_s", 5))
        if status == "searching":
            # The scan request cadence is paced by scan_interval_ms inside
            # maybe_scan(); the outer loop only has to be quick enough to
            # notice a fresh AP list, so keep it well under a scan.
            return 0.35
        return 1.0

    def _wait(self, seconds: float, status: str) -> None:
        """Sleep, but wake up early when NetworkManager reports a change."""
        if status != "connected" or not self.nm.monitor_active():
            time.sleep(seconds)
            return
        # While connected there is nothing to do but wait for the link to drop.
        # Block on the event monitor with a slow safety poll.
        self.nm.wait_for_change(max(seconds, float(self.cfg.get("event_wait_s", 20))))


# --------------------------------------------------------------------------- #
# config / cli
# --------------------------------------------------------------------------- #

def load_config(path: str | None) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    candidates = []
    if path:
        candidates.append(path)
    else:
        candidates += [
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
            "~/.config/wifi-fastlink/config.json",
        ]
    for cand in candidates:
        cand = expand(cand)
        if cand and os.path.isfile(cand):
            with open(cand, encoding="utf-8") as fh:
                user = json.load(fh)
            cfg.update(user)
            cfg["_config_path"] = cand
            return cfg
    return cfg


def selftest(cfg: dict, nm: NmAdapter, log: Logger) -> int:
    print(f"wifi-fastlink {VERSION} selftest")
    print(f"  nmcli          : {nm.nmcli} ({shutil.which(nm.nmcli) or 'MISSING'})")
    if not nm.available():
        print("  FAIL: nmcli not found")
        return 2
    try:
        radios = nm._lines(["-t", "radio"])
        print(f"  radio          : {radios}")
        print(f"  radio wifi on  : {nm.radio_wifi_enabled()}")
        ifaces = nm.wifi_interfaces()
        print(f"  wifi interfaces: {ifaces or 'NONE'}")
        print(f"  general        : {nm.general_state()}")
        for iface in ifaces:
            state, con, addrs = nm.device_state(iface)
            print(f"  {iface:14s} : state={state} connection={con!r} ip4={addrs}")
        t0 = time.monotonic()
        ok = nm.request_scan(ifaces[0]) if ifaces else False
        print(f"  RequestScan    : {'accepted' if ok else 'refused'} in {(time.monotonic()-t0)*1000:.0f}ms")
        ssids = nm.visible_ssids()
        print(f"  visible APs    : {len(ssids)}")
        for ssid in sorted(ssids):
            marker = "  <-- target" if ssid in (cfg.get("targets") or []) else ""
            print(f"      {ssid}{marker}")
        targets = cfg.get("targets") or []
        if targets:
            for t in targets:
                print(
                    f"  target {t!r}: visible={t in ssids} "
                    f"connection_exists={nm.connection_exists(t)}"
                )
    except (NmError, subprocess.TimeoutExpired) as exc:
        print(f"  FAIL: {exc}")
        return 2
    print("selftest finished")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fast reconnect to a preferred Wi-Fi hotspot")
    parser.add_argument("--config", help="path to config.json")
    parser.add_argument("--once", action="store_true", help="run a single cycle and exit")
    parser.add_argument("--dry-run", action="store_true", help="never activate connections")
    parser.add_argument("--selftest", action="store_true", help="inspect environment and exit")
    parser.add_argument("--target", action="append", default=None, help="target SSID (repeatable)")
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--version", action="version", version=f"wifi-fastlink {VERSION}")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    if args.target:
        cfg["targets"] = list(args.target)
    if args.verbose:
        cfg["verbose"] = True
    if args.dry_run:
        cfg["dry_run"] = True
        cfg["verbose"] = True

    log = Logger(cfg.get("log_file", ""), int(cfg.get("log_max_bytes", 0) or 0), bool(cfg["verbose"]))
    nm = NmAdapter()

    if args.selftest:
        return selftest(cfg, nm, log)

    path = cfg.get("_config_path") or "(built-in defaults)"
    log.info(f"wifi-fastlink {VERSION} starting (config: {path}, dry_run={bool(cfg.get('dry_run'))})")
    log.info(
        f"targets={cfg.get('targets') or 'auto-learn'} "
        f"scan_interval={cfg.get('scan_interval_ms')}ms "
        f"poll_connected={cfg.get('poll_connected_ms')}ms"
    )

    engine = Engine(nm, log, cfg)

    def _stop(signum, _frame):
        engine.running = False
        log.info(f"received signal {signum}, shutting down")

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    engine.run(max_cycles=1 if args.once else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
