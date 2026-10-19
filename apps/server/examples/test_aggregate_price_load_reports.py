import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("aggregate_price_load_reports.py")
SPEC = importlib.util.spec_from_file_location("aggregate_price_load_reports", MODULE_PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def report(**overrides):
    value = {
        "schemaVersion": 4, "connectionFailures": {"timeout": 0, "http4xx": 0,
            "http5xx": 0, "io": 0, "other": 0},
        "runId": "shared", "plannedStartUnixMs": 10_000, "httpStartUnixMs": 10_000,
        "targetWebSockets": 0, "connectedAfterRamp": 0, "closedDuringRun": 0,
        "minimumFramesPerClientDuringSoak": 0, "soakSeconds": 60,
        "httpEnabled": True, "httpAggregateTargetRps": 100, "httpShardCount": 4,
        "httpShardIndex": 0, "httpExpectedShardRequests": 1500,
        "httpIssuedAtDeadline": 1500, "httpCompletedAtDeadline": 1500,
        "httpSchedulerSkippedSlots": 0, "httpErrors": 0,
        "httpInFlightAtDeadline": 0, "httpInFlightAfterDrain": 0,
        "httpAuthenticated": True, "authenticatedPrincipalCount": 4,
        "authenticatedRequestsPerPrincipal": [375] * 4,
        "httpIssuedPerSecond": [25] * 60,
        "httpCompletedPerSecond": [25] * 60,
    }
    value.update(overrides)
    return value


class AggregateReportsTest(unittest.TestCase):
    def valid_reports(self):
        return [report(httpShardIndex=index) for index in range(4)] + [
            report(httpEnabled=False, targetWebSockets=10_000, connectedAfterRamp=10_000,
                   minimumFramesPerClientDuringSoak=60)
        ]

    def test_accepts_complete_coordinated_run(self):
        self.assertEqual(module.validate(self.valid_reports(), "shared", 60, 100, 4, 10_000, 45), [])

    def test_rejects_missing_http_shard_and_mismatched_epoch(self):
        reports = self.valid_reports()[:-2] + [report(httpEnabled=False, targetWebSockets=10_000,
            connectedAfterRamp=10_000, minimumFramesPerClientDuringSoak=60, plannedStartUnixMs=10_001)]
        errors = module.validate(reports, "shared", 60, 100, 4, 10_000, 45)
        self.assertTrue(any("each configured shard" in error for error in errors))
        self.assertTrue(any("plannedStartUnixMs" in error for error in errors))

    def test_rejects_http_scheduler_loss_or_deadline_backlog(self):
        reports = self.valid_reports()
        reports[0]["httpSchedulerSkippedSlots"] = 1
        self.assertTrue(module.validate(reports, "shared", 60, 100, 4, 10_000, 45))

    def test_rejects_start_skew_and_freshness_failure(self):
        reports = self.valid_reports()
        reports[1]["httpStartUnixMs"] += 11
        reports[-1]["minimumFramesPerClientDuringSoak"] = 44
        errors = module.validate(reports, "shared", 60, 100, 4, 10_000, 45)
        self.assertTrue(any("start skew" in error for error in errors))
        self.assertTrue(any("freshness" in error for error in errors))

    def test_rejects_websocket_soak_duration_mismatch(self):
        reports = self.valid_reports()
        reports[-1]["soakSeconds"] = 59
        errors = module.validate(reports, "shared", 60, 100, 4, 10_000, 45)
        self.assertTrue(any("WebSocket shard" in error and "soak duration" in error for error in errors))

    def test_rejects_principal_coverage_and_per_shard_slot_loss(self):
        reports = self.valid_reports()
        reports[0]["authenticatedRequestsPerPrincipal"][0] += 1
        reports[2]["httpIssuedPerSecond"][17] = 24
        errors = module.validate(reports, "shared", 60, 100, 4, 10_000, 45)
        self.assertTrue(any("principal coverage" in error for error in errors))
        self.assertTrue(any("assigned issue slots" in error for error in errors))

    def test_rejects_all_shards_starting_late_after_shared_epoch(self):
        reports = self.valid_reports()
        for item in reports:
            if item["httpEnabled"]:
                item["httpStartUnixMs"] += 11
        errors = module.validate(reports, "shared", 60, 100, 4, 10_000, 45)
        self.assertTrue(any("shared epoch" in error for error in errors))

    def test_rejects_stale_schema_and_missing_or_inconsistent_connection_failures(self):
        reports = self.valid_reports()
        reports[0]["schemaVersion"] = 3
        del reports[1]["connectionFailures"]
        reports[-1]["connectionFailures"]["http5xx"] = 1
        errors = module.validate(reports, "shared", 60, 100, 4, 10_000, 45)
        self.assertTrue(any("schemaVersion 4" in error for error in errors))
        self.assertTrue(any("valid bounded connectionFailures" in error for error in errors))
        self.assertTrue(any("failed connection, close, or freshness" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
