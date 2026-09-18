//! A small all-electron molecular DFT engine.
//!
//! Scope: non-periodic molecules built from H-Ar, up to roughly benzene in
//! size, using a fixed STO-3G basis and the LDA (Slater exchange + VWN5
//! correlation) functional. Everything is in atomic units.
//!
//! The crate is deliberately free of any WebAssembly dependency so the whole
//! engine can be exercised with `cargo test` on the host.

pub mod basis;
pub mod bonding;
pub mod constants;
pub mod density;
pub mod driver;
pub mod element;
pub mod gradient;
pub mod grid;
pub mod integrals;
pub mod marching;
pub mod molecule;
pub mod opt;
pub mod scf;
pub mod xc;

pub use basis::{BasisError, BasisSet, Shell};
pub use bonding::{DensityChannel, OrbitalRef};
pub use density::{DensityGrid, GridSpec};
pub use driver::{DriverOptions, Outcome, SpinState};
pub use grid::GridQuality;
pub use marching::Mesh;
pub use molecule::{Atom, GeometryError, Molecule};
pub use opt::{Relaxation, Status as OptStatus};
pub use scf::{run_restricted, run_unrestricted, OrbitalSet, ScfOptions, ScfResult, System};
