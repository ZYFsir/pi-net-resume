#!/usr/bin/env python3
"""Unit tests for the wifi-fastlink decision loop.

These never touch the network: a fake NetworkManager adapter and a fake clock
drive the engine, so the reconnect state machine can be tested deterministically.

    python3 tests/test_wifi_fastlink.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "wifi-fastlink"))

import wifi_fastlink as wf  # noqa: E402


class RecordingLogger(wf.Logger):
    def __init__(self):
        super().__init__("", 0, verbose=False)
        self.events: list[tuple[str, dict]] = []
        self.lines: list[tuple[str, str]] = []

    def _write(self, line: str) -> None:
        self.lines.append(("?", line))

    def info(self, msg):  # type: ignore[override]
        self.lines.append(("INFO", msg))

    def debug(self, msg):  # type: ignore[override]
        self.lines.append(("DEBUG", msg))

    def warn(self, msg):  # type: ignore[override]
        self.lines.append(("WARN", msg))

    def event(self, name, **data):  # type: ignore[override]
        self.events.append((name, data))

    def messages(self, level: str | None = None) -> str:
        return "\n".join(m for lv, m in self.lines if level is None or lv == level)


class FakeClock:
    def __init__(self, start: int = 1_700_000_000_000):
        self.now = start

    def __call__(self) -> int:
        return self.now

    def advance(self, ms: int) -> None:
        self.now += ms


class FakeNm:
    """Scriptable stand-in for NmAdapter."""

    def __init__(self, iface: str = "wlan0"):
        self.iface = iface
        self.radio = True
        self.state = wf.NM_STATE_DISCONNECTED
        self.con = ""
        self.addrs: list[str] = []
        self.visible: set[str] = {"neighbour-ap"}
        self.connections: dict[str, str] = {"hhh": "hhh"}
        self.activate_ok = True
        self.ap_appears_on_sighting: int | None = None
        self.sightings = 0
        self.scan_requests = 0
        self.activations: list[str] = []

    # queries
    def wifi_interfaces(self):
        return [self.iface]

    def device_state(self, iface):
        return self.state, self.con, list(self.addrs)

    def radio_wifi_enabled(self):
        return self.radio

    def visible_ssids(self):
        self.sightings += 1
        if self.ap_appears_on_sighting is not None and self.sightings >= self.ap_appears_on_sighting:
            self.visible.add("hhh")
        return set(self.visible)

    def connection_exists(self, name):
        return name in self.connections

    def connection_ssid(self, name):
        return self.connections.get(name, "")

    # actions
    def request_scan(self, iface):
        self.scan_requests += 1
        return True

    def activate(self, name, iface, timeout_s):
        self.activations.append(name)
        if not self.activate_ok:
            return False, "simulated activation failure"
        self.con = name
        self.state = wf.NM_STATE_ACTIVATED
        self.addrs = ["172.20.10.42/28"]
        return True, "ok"


def make_engine(nm: FakeNm, **cfg) -> tuple[wf.Engine, RecordingLogger]:
    config = dict(wf.DEFAULT_CONFIG)
    config.update({"targets": ["hhh"], "log_file": ""})
    config.update(cfg)
    log = RecordingLogger()
    engine = wf.Engine(nm, log, config)
    return engine, log


def event_names(log: RecordingLogger) -> list[str]:
    return [name for name, _ in log.events]


def event_data(log: RecordingLogger, name: str) -> dict:
    for ev_name, data in log.events:
        if ev_name == name:
            return data
    raise AssertionError(f"event {name} not logged; saw {event_names(log)}")


class TestSearchAndConnect(unittest.TestCase):
    def test_searches_until_ssid_appears_then_activates(self):
        nm = FakeNm()
        nm.ap_appears_on_sighting = 3
        engine, log = make_engine(nm, scan_interval_ms=0)

        statuses = []
        for _ in range(6):
            statuses.append(engine.step())
            if statuses[-1] == "connected":
                break

        self.assertEqual(statuses[-1], "connected")
        self.assertGreaterEqual(nm.sightings, 3)
        self.assertEqual(nm.activations, ["hhh"])
        self.assertEqual(event_names(log)[:2], ["search_start", "ssid_seen"])
        self.assertIn("connected", event_names(log))
        self.assertTrue(event_data(log, "activate_result")["ok"])
        self.assertGreaterEqual(event_data(log, "connected")["seen_to_connected_ms"], 0)
        self.assertIn("reconnected to 'hhh'", log.messages("INFO"))

    def test_does_not_activate_when_target_never_visible(self):
        nm = FakeNm()
        engine, log = make_engine(nm, scan_interval_ms=0)
        for _ in range(5):
            self.assertEqual(engine.step(), "searching")
        self.assertEqual(nm.activations, [])
        self.assertGreater(nm.scan_requests, 0)
        self.assertNotIn("ssid_seen", event_names(log))

    def test_scan_requests_are_paced_by_scan_interval(self):
        nm = FakeNm()
        clock = FakeClock()
        original = wf.now_ms
        wf.now_ms = clock  # type: ignore[assignment]
        try:
            engine, _ = make_engine(nm, scan_interval_ms=1200)
            engine.step()  # first cycle: scans immediately
            self.assertEqual(nm.scan_requests, 1)
            clock.advance(300)
            engine.step()
            clock.advance(300)
            engine.step()
            self.assertEqual(nm.scan_requests, 1, "must not re-scan inside the interval")
            clock.advance(700)  # total 1300ms since the first scan
            engine.step()
            self.assertEqual(nm.scan_requests, 2, "must scan once the interval elapsed")
        finally:
            wf.now_ms = original  # type: ignore[assignment]

    def test_activation_failure_is_retried(self):
        nm = FakeNm()
        nm.ap_appears_on_sighting = 1
        nm.activate_ok = False
        engine, log = make_engine(nm, scan_interval_ms=0)
        for _ in range(4):
            engine.step()
        self.assertEqual(nm.activations, ["hhh", "hhh", "hhh", "hhh"])
        self.assertIn("activation of 'hhh' failed", log.messages("WARN"))
        self.assertNotIn("connected", event_names(log))

    def test_missing_profile_is_reported_once(self):
        nm = FakeNm()
        nm.connections = {}
        nm.ap_appears_on_sighting = 1
        engine, log = make_engine(nm, scan_interval_ms=0)
        for _ in range(3):
            engine.step()
        self.assertEqual(nm.activations, [])
        self.assertEqual(event_names(log).count("no_connection_profile"), 1)

    def test_dry_run_never_activates(self):
        nm = FakeNm()
        nm.ap_appears_on_sighting = 1
        engine, log = make_engine(nm, scan_interval_ms=0, dry_run=True)
        for _ in range(3):
            engine.step()
        self.assertEqual(nm.activations, [])
        self.assertIn("would activate", log.messages("DEBUG"))

    def test_activate_on_sight_can_be_disabled(self):
        nm = FakeNm()
        nm.ap_appears_on_sighting = 1
        engine, _ = make_engine(nm, scan_interval_ms=0, activate_on_sight=False)
        for _ in range(3):
            engine.step()
        self.assertEqual(nm.activations, [])

    def test_does_not_steal_a_working_other_network(self):
        nm = FakeNm()
        nm.state = wf.NM_STATE_ACTIVATED
        nm.con = "other-ap"
        nm.addrs = ["10.0.0.9/24"]
        nm.ap_appears_on_sighting = 1
        engine, log = make_engine(nm, scan_interval_ms=0)
        for _ in range(3):
            engine.step()
        self.assertEqual(nm.activations, [])
        self.assertIn("keeping the working connection 'other-ap'", log.messages("INFO"))

    def test_takeover_switches_when_configured(self):
        nm = FakeNm()
        nm.state = wf.NM_STATE_ACTIVATED
        nm.con = "other-ap"
        nm.addrs = ["10.0.0.9/24"]
        nm.ap_appears_on_sighting = 1
        engine, _ = make_engine(nm, scan_interval_ms=0, takeover_other_networks=True)
        for _ in range(2):
            engine.step()
        self.assertEqual(nm.activations, ["hhh"])

    def test_waits_when_nm_is_already_activating(self):
        nm = FakeNm()
        nm.state = wf.NM_STATE_PREPARE
        nm.ap_appears_on_sighting = 1
        engine, log = make_engine(nm, scan_interval_ms=0)
        for _ in range(2):
            engine.step()
        self.assertEqual(nm.activations, [])
        self.assertIn("already activating", log.messages("DEBUG"))


class TestStates(unittest.TestCase):
    def test_already_connected_is_idle(self):
        nm = FakeNm()
        nm.state = wf.NM_STATE_ACTIVATED
        nm.con = "hhh"
        nm.addrs = ["172.20.10.4/28"]
        engine, log = make_engine(nm, scan_interval_ms=0)
        self.assertEqual(engine.step(), "connected")
        self.assertEqual(nm.scan_requests, 0)
        self.assertEqual(nm.activations, [])

    def test_connected_without_ip_is_not_connected(self):
        nm = FakeNm()
        nm.state = wf.NM_STATE_ACTIVATED
        nm.con = "hhh"
        nm.addrs = []
        engine, _ = make_engine(nm, scan_interval_ms=0)
        self.assertEqual(engine.step(), "searching")
        self.assertGreater(nm.scan_requests, 0)

    def test_connected_to_other_network_keeps_searching(self):
        nm = FakeNm()
        nm.state = wf.NM_STATE_ACTIVATED
        nm.con = "some-other-ap"
        nm.addrs = ["10.0.0.9/24"]
        engine, log = make_engine(nm, scan_interval_ms=0)
        self.assertEqual(engine.step(), "searching")
        self.assertIn("waiting for a target", log.messages("INFO"))

    def test_radio_off_is_respected(self):
        nm = FakeNm()
        nm.radio = False
        engine, _ = make_engine(nm, scan_interval_ms=0)
        self.assertEqual(engine.step(), "radio-off")
        self.assertEqual(nm.scan_requests, 0)

    def test_no_wifi_interface(self):
        nm = FakeNm()
        nm.wifi_interfaces = lambda: []  # type: ignore[assignment]
        engine, _ = make_engine(nm, scan_interval_ms=0)
        self.assertEqual(engine.step(), "no-interface")

    def test_target_is_learned_from_current_connection(self):
        nm = FakeNm()
        nm.state = wf.NM_STATE_ACTIVATED
        nm.con = "my-phone"
        nm.addrs = ["192.168.1.5/24"]
        engine, log = make_engine(nm, targets=[], scan_interval_ms=0)
        self.assertEqual(engine.step(), "connected")
        self.assertEqual(engine.targets, ["my-phone"])
        self.assertIn("learned 'my-phone'", log.messages("INFO"))

    def test_no_targets_at_all_is_reported(self):
        nm = FakeNm()
        engine, _ = make_engine(nm, targets=[], scan_interval_ms=0)
        self.assertEqual(engine.step(), "no-targets")


# A stub nmcli that enforces the field validation the real tool applies, so the
# argument shapes used by NmAdapter are pinned against nmcli behaviour instead
# of against the fake adapter.
STUB_NMCLI = r'''#!/usr/bin/env bash
fields=""
args=("$@")
i=0
while (( i < ${#args[@]} )); do
  case "${args[i]}" in
    -t) ;;
    -f) i=$((i + 1)); fields="${args[i]}" ;;
    *) break ;;
  esac
  i=$((i + 1))
done
rest=("${args[@]:i}")
if [[ "${rest[0]:-}" == "connection" && "${rest[1]:-}" == "show" && -n "${rest[2]:-}" ]]; then
  name="${rest[2]}"
  if [[ "$name" != "hhh" ]]; then
    echo "Error: $name - no such connection profile." >&2
    exit 10
  fi
  case "$fields" in
    NAME)
      echo "Error: invalid field 'NAME'; allowed fields: 802-11-wireless, connection, ipv4, ..." >&2
      exit 2
      ;;
    802-11-wireless.ssid)
      echo "802-11-wireless.ssid:hhh"
      exit 0
      ;;
    *)
      echo "connection.id:hhh"
      exit 0
      ;;
  esac
fi
exit 0
'''


class TestNmAdapterAgainstNmcli(unittest.TestCase):
    """The fake adapter never shells out, so nothing above pins the real
    argument shapes.  Regression: `-f NAME` is rejected by nmcli for the
    profile form of `connection show`, which made connection_exists() always
    return False and the watcher refuse to activate a profile that exists."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        stub = os.path.join(self.tmp.name, "nmcli")
        with open(stub, "w", encoding="utf-8") as fh:
            fh.write(STUB_NMCLI)
        os.chmod(stub, 0o755)
        self.adapter = wf.NmAdapter(nmcli=stub)

    def test_existing_profile_is_found(self):
        self.assertTrue(self.adapter.connection_exists("hhh"))

    def test_absent_profile_is_not_found(self):
        self.assertFalse(self.adapter.connection_exists("ghost"))

    def test_profile_ssid_is_read(self):
        self.assertEqual(self.adapter.connection_ssid("hhh"), "hhh")


class TestHelpers(unittest.TestCase):
    def test_nmcli_unescaping(self):
        self.assertEqual(wf.split_nm_line(r"a:b:c"), ["a", "b", "c"])
        self.assertEqual(wf.split_nm_line(r"my\:ap:70:6"), ["my:ap", "70", "6"])
        self.assertEqual(wf.split_nm_line(r"back\\slash:x"), ["back\\slash", "x"])

    def test_expand(self):
        self.assertEqual(wf.expand("~/x"), os.path.expanduser("~/x"))
        self.assertEqual(wf.expand(""), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
