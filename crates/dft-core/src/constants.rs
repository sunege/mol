//! Physical constants and unit conversions.
//!
//! The engine works exclusively in atomic units (Bohr, Hartree). Conversion to
//! and from Angstrom happens only at the API boundary in `dft-wasm`.

/// Bohr radii per Angstrom (CODATA 2018).
pub const BOHR_PER_ANGSTROM: f64 = 1.889_726_125_457_828_3;

/// Angstroms per Bohr radius (CODATA 2018).
pub const ANGSTROM_PER_BOHR: f64 = 0.529_177_210_903;
