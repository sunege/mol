//! The self-consistent field loop: restricted Kohn-Sham with the LDA functional.
//!
//! The energy of a density matrix `D` (the *total* density, so both spins) is
//!
//! ```text
//! E = sum_mu_nu D_mu_nu H_mu_nu + 1/2 sum_mu_nu D_mu_nu J_mu_nu[D] + E_xc[rho] + E_nn
//! ```
//!
//! and the Fock (Kohn-Sham) matrix is its derivative, `F = H + J + V_xc`. There is
//! no exact-exchange term: that is what makes LDA cheap.
//!
//! Non-convergence is a value, not an error. The result always carries a usable
//! density and energy along with a `converged` flag, which is what lets the UI
//! turn a failure into an animation instead of an error message (requirement F5).

pub mod diis;
pub mod guess;
pub mod linalg;

use nalgebra::{DMatrix, DVector};

use crate::basis::{BasisError, BasisSet};
use crate::grid::{self, GridQuality, MolecularGrid};
use crate::integrals::{self, EriTensor};
use crate::molecule::Molecule;
use crate::xc;
use diis::Diis;
use linalg::{canonical_orthogonalizer, symmetric_eigen_sorted, OVERLAP_THRESHOLD};

/// Orbital energies within this of each other count as degenerate when spreading
/// electrons over a partly filled shell.
const DEGENERACY_TOLERANCE: f64 = 1e-6;

/// A molecule with everything precomputed that depends only on its geometry.
///
/// Building this is the expensive part of a single-point calculation; the SCF
/// iterations themselves only touch the density.
pub struct System {
    pub molecule: Molecule,
    pub basis: BasisSet,
    pub overlap: DMatrix<f64>,
    /// `T + V_ne`.
    pub core: DMatrix<f64>,
    pub eri: EriTensor,
    pub grid: MolecularGrid,
    pub nuclear_repulsion: f64,
}

impl System {
    pub fn build(molecule: Molecule, quality: GridQuality) -> Result<Self, BasisError> {
        let basis = BasisSet::sto3g(&molecule)?;
        let (overlap, kinetic) = integrals::overlap_and_kinetic(&basis);
        let core = kinetic + integrals::nuclear_attraction(&basis, &molecule);
        let eri = integrals::compute_eri(&basis);
        let grid = grid::build(&molecule, quality);
        let nuclear_repulsion = molecule.nuclear_repulsion();
        Ok(System { molecule, basis, overlap, core, eri, grid, nuclear_repulsion })
    }

    pub fn n_functions(&self) -> usize {
        self.basis.n_functions()
    }
}

/// Where the first density matrix comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InitialGuess {
    /// Superposition of atomic densities: converge each element's atom once and
    /// assemble the blocks. Much closer to the answer than the alternative.
    #[default]
    Atomic,
    /// Diagonalise the core Hamiltonian, ignoring all electron-electron terms.
    /// Crude, but it needs no other calculation, which is what the atomic
    /// calculations behind [`InitialGuess::Atomic`] themselves start from.
    Core,
}

/// How electrons are spread over orbitals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Occupation {
    /// Two electrons per orbital from the bottom up.
    #[default]
    Aufbau,
    /// Electrons shared equally across degenerate levels, so a partly filled
    /// shell keeps the density spherical. Used by the atomic calculations behind
    /// the SAD guess; without it an open-shell atom would pick an arbitrary p
    /// direction and the guess would not be rotationally invariant.
    SphericalAverage,
}

/// Knobs of the SCF loop. The defaults are what the application uses.
#[derive(Debug, Clone, PartialEq)]
pub struct ScfOptions {
    pub max_iterations: usize,
    /// Convergence needs the energy change below this...
    pub energy_tolerance: f64,
    /// ...and the largest commutator residual below this.
    pub residual_tolerance: f64,
    pub diis_subspace: usize,
    /// Number of opening iterations in which the new density is mixed with the
    /// old one, to stop DIIS from locking onto a bad early direction.
    pub damping_iterations: usize,
    /// Fraction of the *previous* density kept while damping.
    pub damping_factor: f64,
    pub occupation: Occupation,
    pub initial_guess: InitialGuess,
}

impl Default for ScfOptions {
    fn default() -> Self {
        ScfOptions {
            max_iterations: 100,
            energy_tolerance: 1e-8,
            residual_tolerance: 1e-6,
            diis_subspace: 8,
            damping_iterations: 3,
            damping_factor: 0.4,
            occupation: Occupation::Aufbau,
            initial_guess: InitialGuess::Atomic,
        }
    }
}

/// The energy split into the terms that are checked separately against reference
/// values; a wrong total then says which part is at fault.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct EnergyBreakdown {
    /// `sum D H`, kinetic plus electron-nucleus attraction.
    pub core: f64,
    /// `1/2 sum D J`, the classical electron-electron repulsion.
    pub coulomb: f64,
    pub exchange_correlation: f64,
    pub nuclear_repulsion: f64,
}

impl EnergyBreakdown {
    pub fn total(&self) -> f64 {
        self.core + self.coulomb + self.exchange_correlation + self.nuclear_repulsion
    }
}

/// Outcome of an SCF, converged or not.
#[derive(Debug, Clone)]
pub struct ScfResult {
    pub converged: bool,
    pub iterations: usize,
    pub energy: f64,
    pub components: EnergyBreakdown,
    /// Total density matrix (both spins).
    pub density: DMatrix<f64>,
    pub orbital_energies: DVector<f64>,
    /// Molecular orbital coefficients, one orbital per column.
    pub orbitals: DMatrix<f64>,
    pub occupations: DVector<f64>,
    /// `integral rho dr` on the grid. It should equal the electron count; the gap
    /// is the quadrature error and is worth reporting.
    pub electrons_on_grid: f64,
}

impl ScfResult {
    /// Highest occupied and lowest unoccupied orbital energies, when both exist.
    pub fn homo_lumo(&self) -> Option<(f64, f64)> {
        let homo = (0..self.occupations.len())
            .filter(|&i| self.occupations[i] > 1e-8)
            .map(|i| self.orbital_energies[i])
            .next_back()?;
        let lumo = (0..self.occupations.len())
            .find(|&i| self.occupations[i] <= 1e-8)
            .map(|i| self.orbital_energies[i])?;
        Some((homo, lumo))
    }
}

/// Energy terms and the Kohn-Sham matrix of a given density.
///
/// Exposed so a test can evaluate the energy expression on a reference density
/// matrix, which separates "is the functional right" from "does the loop
/// converge to the right place".
pub fn energy_and_fock(
    system: &System,
    density: &DMatrix<f64>,
) -> (EnergyBreakdown, DMatrix<f64>, f64) {
    let coulomb = system.eri.coulomb(density);
    let xc = xc::restricted(&system.basis, &system.grid, density);
    let components = EnergyBreakdown {
        core: elementwise_dot(density, &system.core),
        coulomb: 0.5 * elementwise_dot(density, &coulomb),
        exchange_correlation: xc.energy,
        nuclear_repulsion: system.nuclear_repulsion,
    };
    let fock = &system.core + coulomb + xc.potential;
    (components, fock, xc.n_electrons)
}

/// Restricted Kohn-Sham SCF.
pub fn run_restricted(system: &System, options: &ScfOptions) -> ScfResult {
    let n_electrons = system.molecule.n_electrons().max(0) as usize;
    let x = canonical_orthogonalizer(&system.overlap, OVERLAP_THRESHOLD);
    let mut density = match options.initial_guess {
        InitialGuess::Atomic => {
            guess::superposition_of_atomic_densities(&system.molecule, &system.basis)
        }
        InitialGuess::Core => solve(&system.core, &x, n_electrons, options.occupation).2,
    };
    let mut diis = Diis::new(options.diis_subspace);

    let mut previous_energy = f64::NAN;
    let mut iterations = 0;
    let mut components = EnergyBreakdown::default();
    let mut electrons_on_grid = 0.0;
    let mut converged = false;
    let mut fock = DMatrix::zeros(system.n_functions(), system.n_functions());

    for iteration in 1..=options.max_iterations {
        iterations = iteration;
        let (terms, current_fock, electrons) = energy_and_fock(system, &density);
        components = terms;
        electrons_on_grid = electrons;
        fock = current_fock;
        let energy = components.total();

        // FDS - SDF vanishes exactly when the density commutes with the Fock
        // matrix, i.e. when the orbitals are eigenvectors. Measuring it in the
        // orthonormal basis makes the size independent of the basis conditioning.
        let commutator = &fock * &density * &system.overlap - &system.overlap * &density * &fock;
        let residual = x.transpose() * commutator * &x;
        let largest_residual = residual.amax();

        if (energy - previous_energy).abs() < options.energy_tolerance
            && largest_residual < options.residual_tolerance
        {
            converged = true;
            break;
        }
        previous_energy = energy;

        diis.push(fock.clone(), residual);
        let extrapolated = diis.extrapolate().unwrap_or_else(|| fock.clone());

        let (_, _, new_density) = solve(&extrapolated, &x, n_electrons, options.occupation);
        density = if iteration <= options.damping_iterations {
            let keep = options.damping_factor;
            density * keep + new_density * (1.0 - keep)
        } else {
            new_density
        };
    }

    // Diagonalise the final Kohn-Sham matrix (not the extrapolated one) so the
    // orbitals reported belong to the density and energy reported with them.
    let (orbital_energies, occupations, _) = solve(&fock, &x, n_electrons, options.occupation);
    let orbitals = orbitals_of(&fock, &x);

    ScfResult {
        converged,
        iterations,
        energy: components.total(),
        components,
        density,
        orbital_energies,
        orbitals,
        occupations,
        electrons_on_grid,
    }
}

/// One Roothaan step: transform, diagonalise, occupy, rebuild the density.
fn solve(
    fock: &DMatrix<f64>,
    x: &DMatrix<f64>,
    n_electrons: usize,
    kind: Occupation,
) -> (DVector<f64>, DVector<f64>, DMatrix<f64>) {
    let transformed = x.transpose() * fock * x;
    let (energies, vectors) = symmetric_eigen_sorted(transformed);
    let coefficients = x * vectors;
    let occupations = occupation_numbers(kind, &energies, n_electrons);
    let mut density = DMatrix::zeros(x.nrows(), x.nrows());
    for (i, &occupation) in occupations.iter().enumerate() {
        if occupation <= 0.0 {
            continue;
        }
        let column = coefficients.column(i);
        density += (column * column.transpose()) * occupation;
    }
    (energies, occupations, density)
}

fn orbitals_of(fock: &DMatrix<f64>, x: &DMatrix<f64>) -> DMatrix<f64> {
    let transformed = x.transpose() * fock * x;
    let (_, vectors) = symmetric_eigen_sorted(transformed);
    x * vectors
}

/// Occupation number of each orbital, summing to the electron count.
fn occupation_numbers(
    kind: Occupation,
    energies: &DVector<f64>,
    n_electrons: usize,
) -> DVector<f64> {
    let m = energies.len();
    let mut occupations = DVector::zeros(m);
    let mut remaining = n_electrons as f64;
    match kind {
        Occupation::Aufbau => {
            for i in 0..m {
                if remaining <= 0.0 {
                    break;
                }
                let take = remaining.min(2.0);
                occupations[i] = take;
                remaining -= take;
            }
        }
        Occupation::SphericalAverage => {
            let mut i = 0;
            while i < m && remaining > 0.0 {
                let mut j = i + 1;
                while j < m && (energies[j] - energies[i]).abs() < DEGENERACY_TOLERANCE {
                    j += 1;
                }
                let degeneracy = (j - i) as f64;
                let take = remaining.min(2.0 * degeneracy);
                for k in i..j {
                    occupations[k] = take / degeneracy;
                }
                remaining -= take;
                i = j;
            }
        }
    }
    occupations
}

/// `sum_ij A_ij B_ij` for two symmetric matrices.
fn elementwise_dot(a: &DMatrix<f64>, b: &DMatrix<f64>) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn aufbau_fills_from_the_bottom() {
        let energies = DVector::from_vec(vec![-1.0, -0.5, 0.1, 0.3]);
        let occupations = occupation_numbers(Occupation::Aufbau, &energies, 5);
        assert_eq!(occupations.as_slice(), &[2.0, 2.0, 1.0, 0.0]);
        assert_relative_eq!(occupations.sum(), 5.0, epsilon = 1e-15);
    }

    #[test]
    fn spherical_average_shares_a_partly_filled_shell() {
        // A carbon-like level scheme: 1s, 2s, then a threefold degenerate 2p with
        // two electrons left, which must be spread as 2/3 each.
        let energies = DVector::from_vec(vec![-10.0, -0.7, -0.2, -0.2, -0.2, 0.5]);
        let occupations = occupation_numbers(Occupation::SphericalAverage, &energies, 6);
        assert_relative_eq!(occupations[0], 2.0, epsilon = 1e-15);
        assert_relative_eq!(occupations[1], 2.0, epsilon = 1e-15);
        for i in 2..5 {
            assert_relative_eq!(occupations[i], 2.0 / 3.0, epsilon = 1e-15);
        }
        assert_relative_eq!(occupations[5], 0.0, epsilon = 1e-15);
        assert_relative_eq!(occupations.sum(), 6.0, epsilon = 1e-14);
    }

    #[test]
    fn spherical_average_matches_aufbau_for_a_closed_shell() {
        let energies = DVector::from_vec(vec![-10.0, -0.7, -0.2, -0.2, -0.2, 0.5]);
        let a = occupation_numbers(Occupation::Aufbau, &energies, 10);
        let b = occupation_numbers(Occupation::SphericalAverage, &energies, 10);
        assert_relative_eq!(a, b, epsilon = 1e-15);
    }

    #[test]
    fn breakdown_adds_up() {
        let terms = EnergyBreakdown {
            core: -1.5,
            coulomb: 0.25,
            exchange_correlation: -0.125,
            nuclear_repulsion: 0.5,
        };
        assert_relative_eq!(terms.total(), -0.875, epsilon = 1e-15);
    }
}
