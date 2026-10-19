"""Install/verify immutable Solidity sources without changing the monorepo's dependencies.

Only contracts/ and LICENSE are installed. No downloaded script is executed.
All contract files and the upstream license are covered by the checked-in tree hash.
"""
import argparse
import hashlib
import io
import json
import pathlib
import shutil
import tarfile
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024


def source_hash(folder):
    paths = sorted([*folder.joinpath("contracts").rglob("*"), folder / "LICENSE"],
                   key=lambda path: path.relative_to(folder).as_posix())
    digest = hashlib.sha256()
    for path in paths:
        if path.is_symlink():
            raise ValueError("Symlinks are not permitted in dependency sources")
        if path.is_file():
            digest.update(path.relative_to(folder).as_posix().encode() + b"\0"
                          + hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def install(dependency, target):
    url = f"https://codeload.github.com/{dependency['repository']}/tar.gz/{dependency['commit']}"
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError("Dependency archive exceeds download limit")
    with tempfile.TemporaryDirectory(prefix=".bunk-dependency-", dir=ROOT / "lib") as temp:
        extracted = pathlib.Path(temp)
        total = 0
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            for member in bundle:
                path = pathlib.PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts:
                    raise ValueError("Unsafe archive path")
                relative = pathlib.Path(*path.parts[1:])
                selected = relative.parts and (relative.parts[0] == "contracts" or relative.as_posix() == "LICENSE")
                if not selected or member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError("Dependency source contains a non-regular file")
                total += member.size
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError("Dependency source exceeds extraction limit")
                destination = extracted / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)
        if source_hash(extracted) != dependency["sourceSha256"]:
            raise ValueError(f"Source integrity mismatch for {dependency['name']}")
        extracted.rename(target)


parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument("--check", action="store_true")
mode.add_argument("--install", action="store_true")
args = parser.parse_args()
lock = json.loads((ROOT / "dependencies.lock.json").read_text())
assert lock["schemaVersion"] == 1
if args.install:
    (ROOT / "lib").mkdir(exist_ok=True)
for dependency in lock["dependencies"]:
    target = ROOT / "lib" / dependency["name"]
    if not target.exists() and args.install:
        install(dependency, target)
    if not target.is_dir() or source_hash(target) != dependency["sourceSha256"]:
        raise SystemExit(f"Missing or changed sources: {dependency['name']}; restore or run --install for a missing directory")
    print(f"Verified {dependency['name']} @ {dependency['commit']}")
