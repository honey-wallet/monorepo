"""Build and execute isolated public-fixture SBF acceptance. No deployment/network calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def hashes():
    paths = [ROOT / "Cargo.toml", ROOT / "Cargo.lock", ROOT / "build.rs"]
    for directory, pattern in [("src", "*.rs"), ("tests", "*.rs"), ("tests", "*.toml"),
                               ("tests/fixtures", "*.json"), ("scripts", "*.py")]:
        paths += list((ROOT / directory).rglob(pattern))
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="honey-solana-acceptance-"))
    print(f"Acceptance logs: {work}", flush=True)
    env = {**os.environ, "BUNK_SOLANA_GENESIS_HEX": "07" * 32}
    before = hashes()
    commands = [
        ["python3", "scripts/vectors.py", "--check"],
        ["cargo", "fmt", "--all", "--check"],
        ["cargo", "build-sbf", "--offline", "--skip-tools-install", "--tools-version", "v1.52", "--manifest-path", "Cargo.toml", "--sbf-out-dir", str(ROOT / "target/deploy"), "--", "--locked", "--offline"],
        ["cargo", "build-sbf", "--offline", "--skip-tools-install", "--tools-version", "v1.52", "--manifest-path", "tests/invoker/Cargo.toml", "--sbf-out-dir", str(ROOT / "target/deploy"), "--", "--locked", "--offline"],
        ["cargo", "clippy", "--locked", "--offline", "--workspace", "--all-targets", "--", "-D", "warnings"],
        ["cargo", "test", "--locked", "--offline"],
    ]
    for i, command in enumerate(commands):
        print("Running " + " ".join(command), flush=True)
        with (work / f"step-{i}.log").open("w") as log:
            subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
    assert hashes() == before, "sources changed during acceptance"
    artifacts = {}
    for name in ["honey_bunk_solana", "honey_bunk_test_invoker"]:
        data = (ROOT / f"target/deploy/{name}.so").read_bytes()
        artifacts[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    versions = {"rust": subprocess.check_output(["rustc", "--version"],text=True).strip(),
                "sbf": subprocess.check_output(["cargo", "build-sbf", "--version"],text=True).strip(),
                "openssl": subprocess.check_output(["openssl", "version"],text=True).strip()}
    result = {"scope": "Compiled SBF executed in LiteSVM 0.7.1/Agave 2.3.13, real precompile and transaction signature verification; no public deployment or validator-network certification",
              "fixtureGenesisHex": env["BUNK_SOLANA_GENESIS_HEX"], "sourcesSha256": before,
              "sourcesRechecked": True, "artifacts": artifacts, "tools": versions,
              "commands": commands, "logDirectory": str(work), "runtimeTestLog": (work / "step-5.log").read_text()}
    args.output.write_text(json.dumps(result,indent=2)+"\n")
    print(f"Acceptance passed; evidence {args.output}; logs {work}")


if __name__ == "__main__":
    main()
