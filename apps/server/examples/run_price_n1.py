#!/usr/bin/env python3
"""Run a local two-replica price-stream crash/re-admission experiment.

This is diagnostic tooling, not a production-capacity acceptance test. It uses
the existing independent Rust load client and requires migrated disposable
PostgreSQL/Redis plus the release server/client binaries.
"""
import argparse
import ipaddress
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import unquote, urlsplit
from pathlib import Path


def wait_http(url, deadline, want_price=False):
    last_error = "not ready"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                payload = response.read()
                if response.status == 200:
                    if not want_price:
                        return
                    snapshot = json.loads(payload)
                    if snapshot.get("stale") is False:
                        return
                    last_error = "price snapshot is stale"
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
            last_error = type(error).__name__
        time.sleep(0.25)
    raise RuntimeError(f"readiness deadline exceeded for {url}: {last_error}")


def read_client_report(path):
    try:
        value = json.loads(path.read_text())
        if isinstance(value, dict) and value.get("schemaVersion") == 4:
            return value
    except (OSError, json.JSONDecodeError):
        pass
    return None


def admission_outcome(report, target):
    if report is None:
        return "missing_report"
    connected = report.get("connectedAfterRamp")
    closed = report.get("closedDuringRun")
    if connected == target and closed == 0:
        return "admitted_and_held"
    if connected == 0 and isinstance(report.get("connectionFailures"), dict):
        return "rejected_or_unreachable"
    return "partial_or_disconnected"


def probe_targets(total_clients, requested_immediate):
    each = total_clients // 2
    return min(each, requested_immediate), each


def redis_count(redis_cli, redis_url, key):
    if not redis_cli:
        return None
    parsed = urlsplit(redis_url)
    host = parsed.hostname
    if parsed.scheme != "redis" or not is_loopback_host(host):
        return None
    env = os.environ.copy()
    if parsed.password is not None:
        env["REDISCLI_AUTH"] = unquote(parsed.password)
    command = [redis_cli, "-h", host, "-p", str(parsed.port or 6379),
               "-n", (parsed.path or "/0").lstrip("/") or "0", "--raw"]
    if parsed.username:
        command.extend(["--user", unquote(parsed.username)])
    try:
        result = subprocess.run(
            command + ["ZCARD", key], env=env,
            text=True, capture_output=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode:
        return None
    try:
        return int(result.stdout.strip())
    except ValueError:
        return None


def redis_members(redis_cli, redis_url, key):
    """Read the exact sorted-set members without exposing them in reports."""
    if not redis_cli:
        return None
    parsed = urlsplit(redis_url)
    host = parsed.hostname
    if parsed.scheme != "redis" or not is_loopback_host(host):
        return None
    env = os.environ.copy()
    if parsed.password is not None:
        env["REDISCLI_AUTH"] = unquote(parsed.password)
    command = [redis_cli, "-h", host, "-p", str(parsed.port or 6379),
               "-n", (parsed.path or "/0").lstrip("/") or "0", "--raw"]
    if parsed.username:
        command.extend(["--user", unquote(parsed.username)])
    try:
        result = subprocess.run(
            command + ["ZRANGE", key, "0", "-1"], env=env,
            text=True, capture_output=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode:
        return None
    return set(result.stdout.splitlines()) if result.stdout else set()


def is_loopback_host(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except (TypeError, ValueError):
        return False


def client_command(args, url, users, start_ms, run_id, seconds, label, ramp_ms=None):
    env = os.environ.copy()
    env.update({
        "LOAD_WS_URL": f"ws://127.0.0.1:{url}/api/v1/stream/prices",
        "LOAD_HTTP_URL": f"http://127.0.0.1:{url}/api/v1/prices",
        "LOAD_USERS": str(users),
        "LOAD_SECONDS": str(seconds),
        "LOAD_RAMP_MS": str(args.ramp_ms if ramp_ms is None else ramp_ms),
        "LOAD_HTTP_ENABLED": "false",
        "LOAD_RUN_ID": run_id,
        "LOAD_START_AT_UNIX_MS": str(start_ms),
        "LOAD_MIN_FRAMES_PER_CLIENT": "0",
        "LOAD_MAX_HTTP_ERRORS": "0",
    })
    return [str(args.client_binary)], env


def run_probe(args, port, users, label, outdir, redis_key, redis_cli):
    """Run a short fresh-connect probe; preserve nonzero generator outcomes."""
    if users <= 0:
        return {"label": label, "skipped": True}
    probe_ramp_ms = min(10_000, max(1_000, users // 100))
    start_ms = int(time.time() * 1000) + probe_ramp_ms + 3_000
    run_id = str(uuid.uuid4())
    command, env = client_command(args, port, users, start_ms, run_id,
                                  args.probe_seconds, label, probe_ramp_ms)
    output = outdir / f"{label}.json"
    errors = outdir / f"{label}.stderr.log"
    with output.open("w") as stdout, errors.open("w") as stderr:
        process = subprocess.Popen(command, env=env, stdout=stdout, stderr=stderr)
        try:
            status = process.wait(timeout=probe_ramp_ms / 1000 + args.probe_seconds + 45)
        except subprocess.TimeoutExpired:
            process.kill()
            status = process.wait()
    report = read_client_report(output)
    return {
        "label": label, "exitCode": status,
        "target": users,
        "admissionOutcome": admission_outcome(report, users),
        "connectedAfterRamp": report.get("connectedAfterRamp") if report else None,
        "closedDuringRun": report.get("closedDuringRun") if report else None,
        "clientsWithFrames": report.get("clientsWithFrames") if report else None,
        "clientsWithNoFrames": report.get("clientsWithNoFrames") if report else None,
        "clientsClosedByReportEnd": report.get("clientsClosedByReportEnd") if report else None,
        "connectionFailures": report.get("connectionFailures") if report else None,
        "connectionFailureStatusCodes": report.get("connectionFailureStatusCodes") if report else None,
        "frameGapMs": report.get("clientFrameGapMs") if report else None,
        "redisSocketLeaseCountAfterProbe": redis_count(redis_cli, args.redis_url, redis_key),
        "reportPath": str(output),
        "parseError": report is None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-binary", type=Path, default=Path("target/release/honey-server"))
    parser.add_argument("--client-binary", type=Path, default=Path("target/release/examples/price_load_client"))
    parser.add_argument("--output-dir", type=Path, default=Path("capacity-n1-run"))
    parser.add_argument("--ports", type=int, nargs=2, default=(18081, 18082))
    parser.add_argument("--clients", type=int, default=200,
                        help="total clients, split evenly; 10000 is intentionally opt-in")
    parser.add_argument("--seconds", type=int, default=90,
                        help="soak; must exceed failure offset plus lease-reclamation interval")
    parser.add_argument("--ramp-ms", type=int, default=10_000)
    parser.add_argument("--fail-after", type=int, default=10,
                        help="seconds after shared soak start to terminate replica 1")
    parser.add_argument("--failure-mode", choices=("sigkill", "sigterm"), default="sigkill")
    parser.add_argument("--probe-seconds", type=int, default=3)
    parser.add_argument("--probe-clients", type=int, default=100,
                        help="bounded immediate survivor probe; the post-TTL probe uses the full failed shard")
    parser.add_argument("--redis-cli", default="redis-cli")
    parser.add_argument("--allow-10000", action="store_true")
    args = parser.parse_args()

    if args.clients < 2 or args.clients % 2:
        parser.error("--clients must be a positive even number")
    if args.clients > 10_000:
        parser.error("--clients above 10000 are not supported")
    if args.clients >= 10_000 and not args.allow_10000:
        parser.error("10k mode requires explicit --allow-10000")
    if args.seconds < args.fail_after + 65:
        parser.error("--seconds must allow the 60-second lease TTL plus a 5-second margin")
    if args.fail_after < 1 or args.ramp_ms < args.clients // 100:
        parser.error("failure offset must be positive and ramp must be >=10ms/client")
    if not 1 <= args.probe_clients <= 1_000:
        parser.error("--probe-clients must be between 1 and 1000")
    for name in ("DATABASE_URL", "REDIS_URL"):
        if not os.environ.get(name):
            parser.error(f"{name} must point to disposable local infrastructure")
    database_url = urlsplit(os.environ["DATABASE_URL"])
    database_host = database_url.hostname
    redis_parsed = urlsplit(os.environ["REDIS_URL"])
    if (database_url.scheme not in {"postgres", "postgresql"}
            or not is_loopback_host(database_host)
            or redis_parsed.scheme != "redis"
            or not is_loopback_host(redis_parsed.hostname)):
        parser.error("DATABASE_URL and REDIS_URL must use loopback hosts; the runner refuses remote infrastructure")
    for port in args.ports:
        if not 1024 <= port <= 65535:
            parser.error("ports must be unprivileged TCP ports")
    if args.ports[0] == args.ports[1]:
        parser.error("replicas need distinct ports")
    for binary in (args.server_binary, args.client_binary):
        if not binary.is_file():
            parser.error(f"binary not found: {binary}; build with cargo build --release -p honey-server --example price_load_client")

    args.output_dir.mkdir(parents=True, exist_ok=False)
    namespace = os.environ.get("REDIS_NAMESPACE", f"honey-n1-{uuid.uuid4().hex[:12]}")
    redis_key = f"{namespace}:{{price-sockets}}:global"
    base_env = os.environ.copy()
    base_env.update({
        "HOST": "127.0.0.1", "REQUIRE_INFRASTRUCTURE": "true",
        "REDIS_NAMESPACE": namespace,
        "PRICES_ENABLED": "true", "PRICE_MAX_CONNECTIONS": str(args.clients),
        "PRICE_MAX_CONNECTIONS_PER_IP": str(args.clients),
    })
    servers = []
    server_logs = []
    client_processes = []
    client_files = []
    report = {
        "schemaVersion": 1, "runId": str(uuid.uuid4()), "clients": args.clients,
        "replicaPorts": list(args.ports), "failureMode": args.failure_mode,
        "failureOffsetSeconds": args.fail_after, "soakSeconds": args.seconds,
        "tls": False, "productionAcceptance": False,
        "redisNamespace": namespace,
        "reconnectsAttempted": 0,
        "limitation": "Clients do not auto-reconnect; fresh survivor probes measure re-admission after replica loss.",
    }
    try:
        for index, port in enumerate(args.ports):
            env = base_env | {"PORT": str(port)}
            log = (args.output_dir / f"replica-{index + 1}.log").open("w")
            server_logs.append(log)
            servers.append(subprocess.Popen([str(args.server_binary)], env=env,
                                            stdout=log, stderr=subprocess.STDOUT))
        for port in args.ports:
            wait_http(f"http://127.0.0.1:{port}/ready", time.monotonic() + 90)
            wait_http(f"http://127.0.0.1:{port}/api/v1/prices", time.monotonic() + 90, True)

        each = args.clients // 2
        immediate_probe_clients, post_ttl_probe_clients = probe_targets(args.clients, args.probe_clients)
        report["immediateProbeTarget"] = immediate_probe_clients
        report["postTtlProbeTarget"] = post_ttl_probe_clients
        # Leave time for a 10k ramp before the shared UTC soak epoch.
        start_ms = int(time.time() * 1000) + args.ramp_ms + 15_000
        report["plannedStartUnixMs"] = start_ms
        report["redisLeaseCountBefore"] = redis_count(args.redis_cli, args.redis_url, redis_key)
        for index, port in enumerate(args.ports):
            command, env = client_command(args, port, each, start_ms,
                                          report["runId"], args.seconds, f"replica-{index + 1}")
            output = (args.output_dir / f"clients-replica-{index + 1}.json").open("w")
            error = (args.output_dir / f"clients-replica-{index + 1}.stderr.log").open("w")
            client_files.append((output, error))
            client_processes.append(subprocess.Popen(command, env=env, stdout=output, stderr=error))

        failure_at = start_ms / 1000 + args.fail_after
        time.sleep(max(0, failure_at - time.time()))
        if servers[0].poll() is not None:
            raise RuntimeError("replica 1 exited before scheduled failure injection")
        lease_count_at_failure = redis_count(args.redis_cli, args.redis_url, redis_key)
        lease_members_at_failure = redis_members(args.redis_cli, args.redis_url, redis_key)
        if args.failure_mode == "sigkill":
            servers[0].kill()
        else:
            servers[0].send_signal(signal.SIGTERM)
        servers[0].wait(timeout=30)
        failure_monotonic = time.monotonic()
        report["redisLeaseCountAtFailure"] = lease_count_at_failure
        report["redisLeaseMembersAtFailure"] = len(lease_members_at_failure) if lease_members_at_failure is not None else None
        report["injectedFailureAtUnixMs"] = int(time.time() * 1000)
        report["failedReplicaExitCode"] = servers[0].returncode

        # The immediate probe asks the survivor to admit the lost shard while
        # its stale 60-second leases may still occupy shared global capacity.
        immediate = run_probe(args, args.ports[1], immediate_probe_clients, "probe-immediate",
                              args.output_dir, redis_key, args.redis_cli)
        report["immediateSurvivorProbe"] = immediate
        remaining_ttl = max(0, 62 - (time.monotonic() - failure_monotonic))
        time.sleep(remaining_ttl)
        lease_members_after_ttl = redis_members(args.redis_cli, args.redis_url, redis_key)
        report["redisLeaseCountAfterTtl"] = (
            len(lease_members_after_ttl) if lease_members_after_ttl is not None
            else redis_count(args.redis_cli, args.redis_url, redis_key)
        )
        if lease_members_at_failure is not None and lease_members_after_ttl is not None:
            report["failedReplicaLeaseMembersReclaimed"] = len(
                lease_members_at_failure - lease_members_after_ttl
            )
        reclaimed = run_probe(args, args.ports[1], post_ttl_probe_clients, "probe-after-ttl",
                              args.output_dir, redis_key, args.redis_cli)
        report["postTtlSurvivorProbe"] = reclaimed
        report["elapsedAfterFailureSeconds"] = round(time.monotonic() - failure_monotonic, 3)

        # Wait for the baseline clients to finish their common soak and archive
        # each JSON even when expected replica-loss closures make exit nonzero.
        for process in client_processes:
            try:
                process.wait(timeout=max(10, start_ms / 1000 + args.seconds - time.time() + 45))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for output, error in client_files:
            output.flush()
            error.flush()
        report["replicaClientReports"] = []
        for index, _ in enumerate(args.ports):
            path = args.output_dir / f"clients-replica-{index + 1}.json"
            raw = read_client_report(path)
            report["replicaClientReports"].append({
                "replica": index + 1,
                "exitCode": client_processes[index].returncode,
                "admissionOutcome": admission_outcome(raw, each),
                "reportPath": str(path),
                "connectedAfterRamp": raw.get("connectedAfterRamp") if raw else None,
                "closedDuringRun": raw.get("closedDuringRun") if raw else None,
                "clientsWithFrames": raw.get("clientsWithFrames") if raw else None,
                "clientsWithNoFrames": raw.get("clientsWithNoFrames") if raw else None,
                "clientsClosedByReportEnd": raw.get("clientsClosedByReportEnd") if raw else None,
                "framesDuringSoak": raw.get("framesDuringSoak") if raw else None,
                "minimumFramesPerClientDuringSoak": raw.get("minimumFramesPerClientDuringSoak") if raw else None,
                "clientFrameGapMs": raw.get("clientFrameGapMs") if raw else None,
                "connectionFailures": raw.get("connectionFailures") if raw else None,
                "connectionFailureStatusCodes": raw.get("connectionFailureStatusCodes") if raw else None,
            })
        report["redisLeaseCountAtEnd"] = redis_count(args.redis_cli, args.redis_url, redis_key)
    except Exception as error:
        report["runnerError"] = f"{type(error).__name__}: {error}"
    finally:
        for process in client_processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for process in servers[1:]:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for process in servers:
            if process.poll() is None:
                process.kill()
                process.wait()
        for output, error in client_files:
            output.close()
            error.close()
        for log in server_logs:
            log.close()

    report["runnerOutcome"] = "completed" if "runnerError" not in report else "error"
    report_path = args.output_dir / "n1-summary.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"summary: {report_path}", file=sys.stderr)
    return 0 if "runnerError" not in report else 1


if __name__ == "__main__":
    sys.exit(main())
