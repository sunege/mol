//! A small all-electron molecular DFT engine.
//!
//! Scope: non-periodic molecules built from H-Ar, up to roughly benzene in
//! size, using a fixed STO-3G basis and the LDA (Slater exchange + VWN5
//! correlation) functional. Everything is in atomic units.
//!
//! The crate is deliberately free of any WebAssembly dependency so the whole
//! engine can be exercised with `cargo test` on the host.

pub mod basis;
pub mod constants;
pub mod element;
pub mod grid;
pub mod integrals;
pub mod molecule;
pub mod scf;
pub mod xc;

pub use basis::{BasisError, BasisSet, Shell};
pub use grid::GridQuality;
pub use molecule::{Atom, GeometryError, Molecule};
pub use scf::{run_restricted, ScfOptions, ScfResult, System};
