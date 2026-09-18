//! Gaussian integrals over the basis set.
//!
//! Everything is built on the McMurchie-Davidson scheme in [`md`], so the code
//! is independent of the angular momenta involved and a future switch to a basis
//! with d or f functions needs no new integral kernels.

pub mod boys;
pub mod eri;
pub mod md;
pub mod onee;

pub use eri::{compute as compute_eri, EriTensor};
pub use onee::{core_hamiltonian, kinetic, nuclear_attraction, overlap, overlap_and_kinetic};
