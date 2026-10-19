"""Independent RFC5869 vectors; public test seeds only, never wallet data."""
import hashlib
import hmac
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
phrase = json.loads((root / "src/fixtures/bunk-evm-v3.json").read_text())["phrase"]
salt = b"honey:bunk:journal:extract:v1"
info = b"honey:bunk:journal:encryption:v1"
seeds = [
    ("incrementing-public-bytes", bytes(range(64))),
    ("v3-public-fixture-phrase", hashlib.pbkdf2_hmac("sha512", phrase.encode(), b"mnemonic", 2048)),
]
vectors = []
for label, seed in seeds:
    prk = hmac.new(salt, seed, hashlib.sha256).digest()
    key = hmac.new(prk, info + b"\x01", hashlib.sha256).digest()
    vectors.append({"label": label, "seed": seed.hex(), "key": key.hex()})
print(json.dumps({"warning": "Public test vectors only; never use for funds.",
                  "algorithm": "RFC5869 HKDF-SHA256", "salt": salt.decode(),
                  "info": info.decode(), "length": 32, "vectors": vectors}, indent=2))
