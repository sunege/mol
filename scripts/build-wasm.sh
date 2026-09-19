#!/bin/sh
# Builds the browser engine into web/src/wasm/, the artifact that is committed
# (Vercel's build image has no Rust toolchain; see CLAUDE.md).
#
# CI rebuilds the artifact on every pull request and fails if the bytes differ
# from what was committed, so the build has to come out the same on any machine.
# Three things would otherwise make it depend on who ran it:
#
# * Panic messages carry the source path of the dependency they come from, and
#   for crates.io dependencies that path starts with the builder's CARGO_HOME
#   (/Users/<name>/.cargo on a Mac, /home/runner/.cargo in CI). It is remapped
#   to a fixed /cargo here. Cargo's own `trim-paths` would do this but is not
#   stable yet (1.98). The flag is added with `--config` because an array given
#   there is appended to the one in .cargo/config.toml, which is what switches
#   on SIMD - setting RUSTFLAGS instead would replace it and silently drop SIMD.
# * The standard library's paths include the rustc commit, so the toolchain is
#   pinned in rust-toolchain.toml and CI installs that version.
# * wasm-opt's output depends on its version, which is whatever wasm-pack
#   downloads, so CI pins wasm-pack to the version used here (0.15.0).
set -eu
cd "$(dirname "$0")/.."

cargo_home="${CARGO_HOME:-$HOME/.cargo}"

# wasm-pack 0.15 reads back the package.json it wrote last time and fails on its
# `files` array, so start without one.
rm -f web/src/wasm/package.json
wasm-pack build crates/dft-wasm --release --target web --out-dir ../../web/src/wasm \
  -- --config "target.wasm32-unknown-unknown.rustflags=['--remap-path-prefix=${cargo_home}=/cargo']"
# wasm-pack writes a .gitignore that would hide the artifact from git.
rm -f web/src/wasm/.gitignore
