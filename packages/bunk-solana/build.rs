use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=BUNK_SOLANA_GENESIS_HEX");
    let value = env::var("BUNK_SOLANA_GENESIS_HEX")
        .expect("set BUNK_SOLANA_GENESIS_HEX to the release's full 32-byte genesis hash in hex");
    assert!(
        value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()),
        "invalid genesis hash"
    );
    let bytes: Vec<u8> = (0..32)
        .map(|i| u8::from_str_radix(&value[2 * i..2 * i + 2], 16).unwrap())
        .collect();
    assert!(bytes.iter().any(|b| *b != 0), "zero genesis identity");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("genesis.bin"),
        bytes,
    )
    .unwrap();
}
