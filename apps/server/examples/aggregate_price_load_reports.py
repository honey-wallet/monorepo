#!/usr/bin/env python3
"""Fail-closed validator for coordinated price_load_client reports."""
import argparse
import json
import sys
from pathlib import Path


def validate(reports, run_id, seconds, aggregate_rps, http_shards, websocket_target, min_frames):
    errors = []
    if not reports:
        return ["at least one report is required"]
    failure_keys = {"timeout", "http4xx", "http5xx", "io", "other"}
    for index, report in enumerate(reports):
        if report.get("schemaVersion") != 4:
            errors.append(f"report {index} must use schemaVersion 4")
        failures = report.get("connectionFailures")
        if (not isinstance(failures, dict) or set(failures) != failure_keys
                or any(type(value) is not int or value < 0 for value in failures.values())):
            errors.append(f"report {index} must include valid bounded connectionFailures counts")
        elif sum(failures.values()) != report.get("closedDuringRun"):
            # Failed handshakes are included in closedDuringRun; connected sockets
            # that close are also included, so this can only be a lower bound.
            if sum(failures.values()) > report.get("closedDuringRun", -1):
                errors.append(f"report {index} connectionFailures exceed closedDuringRun")
    if any(r.get("runId") != run_id for r in reports):
        errors.append("all reports must have the requested common runId")
    starts = {r.get("plannedStartUnixMs") for r in reports}
    if len(starts) != 1 or None in starts:
        errors.append("reports must share one plannedStartUnixMs")
    actual_starts = [r.get("httpStartUnixMs") for r in reports if r.get("httpEnabled")]
    tolerance = max(10, 1000 // max(aggregate_rps, 1))
    if actual_starts and max(actual_starts) - min(actual_starts) > tolerance:
        errors.append("HTTP shard start skew exceeds one aggregate slot (minimum tolerance 10 ms)")
    if any(abs(actual - planned) > tolerance for actual in actual_starts
           for planned in starts if isinstance(planned, int)):
        errors.append("observed HTTP start differs from shared epoch by more than one aggregate slot")
    ws = [r for r in reports if r.get("targetWebSockets", 0) > 0]
    if sum(r.get("targetWebSockets", 0) for r in ws) != websocket_target:
        errors.append("WebSocket target sum does not match requested target")
    for report in ws:
        if report.get("soakSeconds") != seconds:
            errors.append(f"WebSocket shard {report.get('targetWebSockets')} soak duration differs from requested seconds")
        if (report.get("connectedAfterRamp") != report.get("targetWebSockets")
                or report.get("closedDuringRun") != 0
                or not isinstance(report.get("connectionFailures"), dict)
                or sum(report["connectionFailures"].values()) != 0
                or report.get("minimumFramesPerClientDuringSoak", 0) < min_frames):
            errors.append(f"WebSocket shard {report.get('targetWebSockets')} failed connection, close, or freshness gate")
    http = [r for r in reports if r.get("httpEnabled")]
    if any(r.get("httpAuthenticated") is not True for r in http):
        errors.append("every HTTP shard must exercise authenticated profile reads")
    indexes = [r.get("httpShardIndex") for r in http]
    if len(http) != http_shards or sorted(indexes) != list(range(http_shards)):
        errors.append("HTTP reports must contain each configured shard exactly once")
    if any(r.get("httpShardCount") != http_shards or r.get("httpAggregateTargetRps") != aggregate_rps
           or r.get("soakSeconds") != seconds for r in http):
        errors.append("HTTP shard configuration differs from requested aggregate")
    expected_per_shard = aggregate_rps * seconds // http_shards if http_shards else 0
    for report in http:
        if (report.get("httpExpectedShardRequests") != expected_per_shard
                or report.get("httpIssuedAtDeadline") != expected_per_shard
                or report.get("httpCompletedAtDeadline") != expected_per_shard
                or report.get("httpSchedulerSkippedSlots") != 0
                or report.get("httpErrors") != 0
                or report.get("httpInFlightAtDeadline") != 0
                or report.get("httpInFlightAfterDrain") != 0
                or not report.get("httpAuthenticated")
                or report.get("authenticatedPrincipalCount", 0) < 1
                or len(report.get("authenticatedRequestsPerPrincipal") or []) != report.get("authenticatedPrincipalCount")):
            errors.append(f"HTTP shard {report.get('httpShardIndex')} failed exact authenticated-read gate")
        counts = report.get("authenticatedRequestsPerPrincipal") or []
        if counts and (sum(counts) != expected_per_shard or max(counts) - min(counts) > 1):
            errors.append(f"HTTP shard {report.get('httpShardIndex')} has incomplete or imbalanced principal coverage")
    if http_shards and aggregate_rps % http_shards:
        errors.append("aggregate HTTP rate must divide evenly across configured shards")
    elif http and aggregate_rps % http_shards == 0:
        if any(len(r.get("httpIssuedPerSecond") or []) != seconds
               or len(r.get("httpCompletedPerSecond") or []) != seconds for r in http):
            errors.append("HTTP reports must include complete per-second issue and completion buckets")
        for second in range(seconds):
            per_shard = [((r.get("httpIssuedPerSecond") or [])[second]
                          if len(r.get("httpIssuedPerSecond") or []) > second else 0) for r in http]
            if any(count != aggregate_rps // http_shards for count in per_shard):
                errors.append(f"an HTTP shard missed its assigned issue slots in second {second}")
            issued = sum((report.get("httpIssuedPerSecond") or [])[second]
                         for report in http if len(report.get("httpIssuedPerSecond") or []) > second)
            if issued != aggregate_rps:
                errors.append(f"aggregate issue bucket for second {second} is {issued}, expected {aggregate_rps}")
                break
        completed_total = sum(sum(r.get("httpCompletedPerSecond") or []) for r in http)
        if completed_total != aggregate_rps * seconds:
            errors.append("summed per-second completion buckets do not match the exact deadline total")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", nargs="+", type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--http-rps", type=int, default=100)
    parser.add_argument("--http-shards", type=int, default=4)
    parser.add_argument("--websocket-target", type=int, default=10_000)
    parser.add_argument("--min-frames", type=int, default=45)
    args = parser.parse_args()
    reports = [json.loads(path.read_text()) for path in args.reports]
    errors = validate(reports, args.run_id, args.seconds, args.http_rps, args.http_shards,
                      args.websocket_target, args.min_frames)
    result = {"runId": args.run_id, "passed": not errors, "errors": errors,
              "websocketConnections": sum(r.get("connectedAfterRamp", 0) for r in reports),
              "httpIssued": sum(r.get("httpIssuedAtDeadline", 0) for r in reports),
              "httpCompletedAtDeadline": sum(r.get("httpCompletedAtDeadline", 0) for r in reports)}
    print(json.dumps(result, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
