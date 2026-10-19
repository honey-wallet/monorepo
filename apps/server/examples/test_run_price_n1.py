import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("run_price_n1.py")
SPEC = importlib.util.spec_from_file_location("run_price_n1", MODULE_PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class PriceN1ReportTest(unittest.TestCase):
    def test_classifies_complete_and_partial_survivor_admission(self):
        good = {"connectedAfterRamp": 4, "closedDuringRun": 0}
        partial = {"connectedAfterRamp": 2, "closedDuringRun": 2}
        denied = {"connectedAfterRamp": 0,
                  "connectionFailures": {"timeout": 0, "http4xx": 4}}
        self.assertEqual(module.admission_outcome(good, 4), "admitted_and_held")
        self.assertEqual(module.admission_outcome(partial, 4), "partial_or_disconnected")
        self.assertEqual(module.admission_outcome(denied, 4), "rejected_or_unreachable")
        self.assertEqual(module.admission_outcome(None, 4), "missing_report")

    def test_loopback_guard_rejects_remote_hostnames(self):
        self.assertTrue(module.is_loopback_host("127.0.0.1"))
        self.assertTrue(module.is_loopback_host("localhost"))
        self.assertTrue(module.is_loopback_host("::1"))
        self.assertFalse(module.is_loopback_host("redis.example.invalid"))

    def test_probe_targets_keep_immediate_probe_bounded_and_retest_full_shard(self):
        self.assertEqual(module.probe_targets(10_000, 100), (100, 5_000))
        self.assertEqual(module.probe_targets(100, 100), (50, 50))

    def test_failed_replica_reclamation_uses_member_difference(self):
        at_failure = {"replica-1-a", "replica-1-b", "replica-2-a"}
        after_ttl = {"replica-2-a", "probe-new-lease"}
        self.assertEqual(len(at_failure - after_ttl), 2)

    def test_generated_namespace_is_passed_to_server_environment(self):
        script = MODULE_PATH.read_text()
        self.assertIn('"REDIS_NAMESPACE": namespace', script)
        self.assertIn('namespace = os.environ.get("REDIS_NAMESPACE", f"honey-n1-', script)

    def test_accepts_only_version_four_json_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text('{"schemaVersion":4,"connectedAfterRamp":2}')
            self.assertEqual(module.read_client_report(path)["connectedAfterRamp"], 2)
            path.write_text('{"schemaVersion":3}')
            self.assertIsNone(module.read_client_report(path))


if __name__ == "__main__":
    unittest.main()
