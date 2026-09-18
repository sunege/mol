//! The self-consistent field loop: Kohn-Sham with the LDA functional, restricted
//! or unrestricted.
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
//! An unrestricted calculation splits that density in two and solves a pair of
//! coupled equations instead. Both spins see the same Coulomb potential, built
//! from the *total* density, and differ only through the exchange-correlation
//! term:
//!
//! ```text
//! F_sigma = H + J[D_alpha + D_beta] + V_xc_sigma[rho_alpha, rho_beta]
//! ```
//!
//! which is what lets an open-shell molecule like O2 lower its energy by keeping
//! two electrons unpaired.
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
    /// Hartree added to every empty orbital before the next diagonalisation.
    ///
    /// Zero for an ordinary calculation. It is the cure for a partly filled,
    /// nearly degenerate shell - an aluminium or silicon atom, where the 3s and
    /// 3p levels sit close together - in which the occupied and empty orbitals
    /// swap places from one iteration to the next and the density oscillates
    /// forever. Pushing the empty ones up stops the swap; at convergence the
    /// density is unchanged by it, since the shift only touches orbitals no
    /// electron is in.
    pub level_shift: f64,
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
            level_shift: 0.0,
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

/// One set of Kohn-Sham orbitals and the electrons occupying them.
///
/// A restricted calculation produces exactly one of these, standing for both
/// spins at once; an unrestricted calculation produces two, alpha and beta, each
/// with its own orbitals. Everything downstream that looks at orbitals - the pi
/// selection behind the bonding surface, the orbital gap - iterates over
/// whichever it is given rather than caring which kind it is.
#[derive(Debug, Clone)]
pub struct OrbitalSet {
    pub energies: DVector<f64>,
    /// Coefficients, one orbital per column.
    pub coefficients: DMatrix<f64>,
    /// Electrons in each orbital: up to two when the set stands for both spins,
    /// up to one when it is a single spin channel.
    pub occupations: DVector<f64>,
    /// The density these orbitals hold. The channel densities sum to
    /// [`ScfResult::density`].
    pub density: DMatrix<f64>,
}

impl OrbitalSet {
    pub fn n_electrons(&self) -> f64 {
        self.occupations.sum()
    }
}

/// An orbital counts as occupied above this. Fractional occupations only arise
/// in the spherically averaged atomic calculations behind the SAD guess.
const OCCUPIED_THRESHOLD: f64 = 1e-8;

/// Outcome of an SCF, converged or not.
#[derive(Debug, Clone)]
pub struct ScfResult {
    pub converged: bool,
    pub iterations: usize,
    pub energy: f64,
    pub components: EnergyBreakdown,
    /// Total density matrix (both spins).
    pub density: DMatrix<f64>,
    /// The orbitals: one set from a restricted calculation, two from an
    /// unrestricted one, alpha first.
    pub channels: Vec<OrbitalSet>,
    /// `integral rho dr` on the grid. It should equal the electron count; the gap
    /// is the quadrature error and is worth reporting.
    pub electrons_on_grid: f64,
}

impl ScfResult {
    /// Whether the two spins were solved separately.
    pub fn is_unrestricted(&self) -> bool {
        self.channels.len() == 2
    }

    /// Highest occupied and lowest unoccupied orbital energies, when both exist.
    ///
    /// Across both spin channels: for an open-shell molecule the highest
    /// occupied orbital is usually alpha and the lowest empty one beta, and the
    /// gap between them is what says how hard the calculation is to converge.
    pub fn homo_lumo(&self) -> Option<(f64, f64)> {
        let mut homo = f64::NEG_INFINITY;
        let mut lumo = f64::INFINITY;
        for set in &self.channels {
            for i in 0..set.occupations.len() {
                if set.occupations[i] > OCCUPIED_THRESHOLD {
                    homo = homo.max(set.energies[i]);
                } else {
                    lumo = lumo.min(set.energies[i]);
                }
            }
        }
        (homo.is_finite() && lumo.is_finite()).then_some((homo, lumo))
    }

    /// Spin density `rho_alpha - rho_beta` as a matrix, or `None` when the two
    /// spins were not solved separately (where it is zero by construction).
    pub fn spin_density(&self) -> Option<DMatrix<f64>> {
        match self.channels.as_slice() {
            [alpha, beta] => Some(&alpha.density - &beta.density),
            _ => None,
        }
    }

    /// `<S^2>` of the determinant the calculation converged on.
    ///
    /// An unrestricted determinant is not in general an eigenfunction of the
    /// total spin, and the gap between this and the exact `S(S+1)` says how much
    /// of another spin state has mixed in. For a single determinant it is exact:
    ///
    /// ```text
    /// <S^2> = S_z (S_z + 1) + n_beta - tr(D_alpha S D_beta S)
    /// ```
    ///
    /// A restricted calculation returns zero, which is what its (closed-shell)
    /// determinant has by construction.
    pub fn spin_squared(&self, overlap: &DMatrix<f64>) -> f64 {
        let [alpha, beta] = self.channels.as_slice() else {
            return 0.0;
        };
        let n_alpha = alpha.n_electrons();
        let n_beta = beta.n_electrons();
        let sz = 0.5 * (n_alpha - n_beta);
        let paired = (&alpha.density * overlap * &beta.density * overlap).trace();
        sz * (sz + 1.0) + n_beta - paired
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

/// The same for a pair of spin densities: one Kohn-Sham matrix per spin.
///
/// The Coulomb term is built from the total density and is shared, so the two
/// matrices differ only in their exchange-correlation potential.
pub fn energy_and_fock_unrestricted(
    system: &System,
    alpha: &DMatrix<f64>,
    beta: &DMatrix<f64>,
) -> (EnergyBreakdown, DMatrix<f64>, DMatrix<f64>, f64) {
    let total = alpha + beta;
    let coulomb = system.eri.coulomb(&total);
    let xc = xc::unrestricted(&system.basis, &system.grid, alpha, beta);
    let components = EnergyBreakdown {
        core: elementwise_dot(&total, &system.core),
        coulomb: 0.5 * elementwise_dot(&total, &coulomb),
        exchange_correlation: xc.energy,
        nuclear_repulsion: system.nuclear_repulsion,
    };
    let shared = &system.core + coulomb;
    let fock_alpha = &shared + xc.potential_alpha;
    let fock_beta = shared + xc.potential_beta;
    (components, fock_alpha, fock_beta, xc.n_electrons)
}

/// Electrons one orbital can hold when it stands for both spins.
const CLOSED_SHELL_CAPACITY: f64 = 2.0;
/// ...and when it belongs to a single spin channel.
const OPEN_SHELL_CAPACITY: f64 = 1.0;

/// Restricted Kohn-Sham SCF.
pub fn run_restricted(system: &System, options: &ScfOptions) -> ScfResult {
    let n_electrons = system.molecule.n_electrons().max(0) as f64;
    let x = canonical_orthogonalizer(&system.overlap, OVERLAP_THRESHOLD);
    let fill = |fock: &DMatrix<f64>| {
        solve(fock, &x, n_electrons, CLOSED_SHELL_CAPACITY, options.occupation)
    };
    let mut density = match options.initial_guess {
        InitialGuess::Atomic => {
            guess::superposition_of_atomic_densities(&system.molecule, &system.basis)
        }
        InitialGuess::Core => fill(&system.core).2,
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

        let residual = commutator_residual(&fock, &density, &system.overlap, &x);
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

        let shifted = level_shifted(
            &extrapolated,
            &system.overlap,
            &density,
            CLOSED_SHELL_CAPACITY,
            options.level_shift,
        );
        let (_, _, new_density) = fill(&shifted);
        density = if iteration <= options.damping_iterations {
            let keep = options.damping_factor;
            density * keep + new_density * (1.0 - keep)
        } else {
            new_density
        };
    }

    // Diagonalise the final Kohn-Sham matrix (not the extrapolated one) so the
    // orbitals reported belong to the density and energy reported with them.
    let (energies, occupations, _) = fill(&fock);
    let channel = OrbitalSet {
        energies,
        coefficients: orbitals_of(&fock, &x),
        occupations,
        density: density.clone(),
    };

    ScfResult {
        converged,
        iterations,
        energy: components.total(),
        components,
        density,
        channels: vec![channel],
        electrons_on_grid,
    }
}

/// Unrestricted Kohn-Sham SCF: the two spins get their own orbitals.
///
/// The electron counts come from the molecule's charge and multiplicity, which
/// the driver has already chosen; an impossible combination is a caller bug
/// rather than a runtime state, so it panics rather than returning a result that
/// describes nothing.
///
/// Both channels are extrapolated together: DIIS sees one error vector with the
/// two commutators stacked in it, which is what keeps alpha and beta from
/// converging against each other.
pub fn run_unrestricted(system: &System, options: &ScfOptions) -> ScfResult {
    let (n_alpha, n_beta) = system
        .molecule
        .spin_occupation()
        .expect("charge and multiplicity must be a possible combination");
    let x = canonical_orthogonalizer(&system.overlap, OVERLAP_THRESHOLD);
    let fill = |fock: &DMatrix<f64>, electrons: usize| {
        solve(fock, &x, electrons as f64, OPEN_SHELL_CAPACITY, options.occupation)
    };

    // Both channels start from half the total guess. They are identical, so the
    // first diagonalisation is too - what separates them is that alpha then
    // takes more orbitals than beta, and from the second iteration on they see
    // genuinely different potentials.
    let total = match options.initial_guess {
        InitialGuess::Atomic => {
            guess::superposition_of_atomic_densities(&system.molecule, &system.basis)
        }
        InitialGuess::Core => {
            fill(&system.core, n_alpha).2 + fill(&system.core, n_beta).2
        }
    };
    let mut alpha = &total * 0.5;
    let mut beta = &total * 0.5;
    let mut diis = Diis::new(options.diis_subspace);

    let n = system.n_functions();
    let mut previous_energy = f64::NAN;
    let mut iterations = 0;
    let mut components = EnergyBreakdown::default();
    let mut electrons_on_grid = 0.0;
    let mut converged = false;
    let mut fock_alpha = DMatrix::zeros(n, n);
    let mut fock_beta = DMatrix::zeros(n, n);

    for iteration in 1..=options.max_iterations {
        iterations = iteration;
        let (terms, f_alpha, f_beta, electrons) =
            energy_and_fock_unrestricted(system, &alpha, &beta);
        components = terms;
        electrons_on_grid = electrons;
        fock_alpha = f_alpha;
        fock_beta = f_beta;
        let energy = components.total();

        let residual_alpha = commutator_residual(&fock_alpha, &alpha, &system.overlap, &x);
        let residual_beta = commutator_residual(&fock_beta, &beta, &system.overlap, &x);
        let largest_residual = residual_alpha.amax().max(residual_beta.amax());

        if (energy - previous_energy).abs() < options.energy_tolerance
            && largest_residual < options.residual_tolerance
        {
            converged = true;
            break;
        }
        previous_energy = energy;

        diis.push(
            stack(&fock_alpha, &fock_beta),
            stack(&residual_alpha, &residual_beta),
        );
        let extrapolated = diis.extrapolate();
        let (extrapolated_alpha, extrapolated_beta) = match &extrapolated {
            Some(stacked) => split(stacked),
            None => (fock_alpha.clone(), fock_beta.clone()),
        };

        let shift = |fock: &DMatrix<f64>, density: &DMatrix<f64>| {
            level_shifted(fock, &system.overlap, density, OPEN_SHELL_CAPACITY, options.level_shift)
        };
        let new_alpha = fill(&shift(&extrapolated_alpha, &alpha), n_alpha).2;
        let new_beta = fill(&shift(&extrapolated_beta, &beta), n_beta).2;
        if iteration <= options.damping_iterations {
            let keep = options.damping_factor;
            alpha = alpha * keep + new_alpha * (1.0 - keep);
            beta = beta * keep + new_beta * (1.0 - keep);
        } else {
            alpha = new_alpha;
            beta = new_beta;
        }
    }

    let channel = |fock: &DMatrix<f64>, electrons: usize, density: DMatrix<f64>| {
        let (energies, occupations, _) = fill(fock, electrons);
        OrbitalSet { energies, coefficients: orbitals_of(fock, &x), occupations, density }
    };

    ScfResult {
        converged,
        iterations,
        energy: components.total(),
        components,
        density: &alpha + &beta,
        channels: vec![
            channel(&fock_alpha, n_alpha, alpha),
            channel(&fock_beta, n_beta, beta),
        ],
        electrons_on_grid,
    }
}

/// `F + shift (S - S P S)`, where `P` is the projector onto the orbitals the
/// electrons are currently in.
///
/// In the orthonormal basis this is `F + shift (1 - P)`: every empty orbital is
/// raised by `shift` and every occupied one is left alone, so the aufbau
/// filling stops flipping between two nearly degenerate shells. The density
/// matrix is scaled by `capacity` to turn it into that projector, which is
/// idempotent under the overlap metric.
///
/// The shift is applied only to the matrix that is about to be diagonalised,
/// never to the one the energy and the convergence test are built from, so the
/// answer it converges to is the unshifted one.
fn level_shifted(
    fock: &DMatrix<f64>,
    overlap: &DMatrix<f64>,
    density: &DMatrix<f64>,
    capacity: f64,
    shift: f64,
) -> DMatrix<f64> {
    if shift == 0.0 {
        return fock.clone();
    }
    let projector = overlap * (density / capacity) * overlap;
    fock + (overlap - projector) * shift
}

/// `X^T (FDS - SDF) X`, which vanishes exactly when the density commutes with
/// the Kohn-Sham matrix, i.e. when the orbitals are its eigenvectors. Measuring
/// it in the orthonormal basis makes the size independent of how well
/// conditioned the overlap is.
fn commutator_residual(
    fock: &DMatrix<f64>,
    density: &DMatrix<f64>,
    overlap: &DMatrix<f64>,
    x: &DMatrix<f64>,
) -> DMatrix<f64> {
    let commutator = fock * density * overlap - overlap * density * fock;
    x.transpose() * commutator * x
}

/// Stacks the two spin channels into one matrix, so a single DIIS history
/// extrapolates them together.
fn stack(alpha: &DMatrix<f64>, beta: &DMatrix<f64>) -> DMatrix<f64> {
    let (rows, columns) = alpha.shape();
    let mut stacked = DMatrix::zeros(2 * rows, columns);
    stacked.view_mut((0, 0), (rows, columns)).copy_from(alpha);
    stacked.view_mut((rows, 0), (rows, columns)).copy_from(beta);
    stacked
}

/// Inverse of [`stack`].
fn split(stacked: &DMatrix<f64>) -> (DMatrix<f64>, DMatrix<f64>) {
    let rows = stacked.nrows() / 2;
    let columns = stacked.ncols();
    (
        stacked.view((0, 0), (rows, columns)).into_owned(),
        stacked.view((rows, 0), (rows, columns)).into_owned(),
    )
}

/// One Roothaan step: transform, diagonalise, occupy, rebuild the density.
///
/// `capacity` is how many electrons one orbital holds: two when the orbitals
/// stand for both spins, one when they belong to a single spin channel.
fn solve(
    fock: &DMatrix<f64>,
    x: &DMatrix<f64>,
    n_electrons: f64,
    capacity: f64,
    kind: Occupation,
) -> (DVector<f64>, DVector<f64>, DMatrix<f64>) {
    let transformed = x.transpose() * fock * x;
    let (energies, vectors) = symmetric_eigen_sorted(transformed);
    let coefficients = x * vectors;
    let occupations = occupation_numbers(kind, &energies, n_electrons, capacity);
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
    n_electrons: f64,
    capacity: f64,
) -> DVector<f64> {
    let m = energies.len();
    let mut occupations = DVector::zeros(m);
    let mut remaining = n_electrons;
    match kind {
        Occupation::Aufbau => {
            for i in 0..m {
                if remaining <= 0.0 {
                    break;
                }
                let take = remaining.min(capacity);
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
                let take = remaining.min(capacity * degeneracy);
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
        let occupations =
            occupation_numbers(Occupation::Aufbau, &energies, 5.0, CLOSED_SHELL_CAPACITY);
        assert_eq!(occupations.as_slice(), &[2.0, 2.0, 1.0, 0.0]);
        assert_relative_eq!(occupations.sum(), 5.0, epsilon = 1e-15);
    }

    #[test]
    fn one_spin_channel_puts_a_single_electron_in_each_orbital() {
        let energies = DVector::from_vec(vec![-1.0, -0.5, 0.1, 0.3]);
        let occupations =
            occupation_numbers(Occupation::Aufbau, &energies, 3.0, OPEN_SHELL_CAPACITY);
        assert_eq!(occupations.as_slice(), &[1.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn spherical_average_shares_a_partly_filled_shell() {
        // A carbon-like level scheme: 1s, 2s, then a threefold degenerate 2p with
        // two electrons left, which must be spread as 2/3 each.
        let energies = DVector::from_vec(vec![-10.0, -0.7, -0.2, -0.2, -0.2, 0.5]);
        let occupations = occupation_numbers(
            Occupation::SphericalAverage,
            &energies,
            6.0,
            CLOSED_SHELL_CAPACITY,
        );
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
        let a = occupation_numbers(Occupation::Aufbau, &energies, 10.0, CLOSED_SHELL_CAPACITY);
        let b = occupation_numbers(
            Occupation::SphericalAverage,
            &energies,
            10.0,
            CLOSED_SHELL_CAPACITY,
        );
        assert_relative_eq!(a, b, epsilon = 1e-15);
    }

    #[test]
    fn stacking_the_two_channels_round_trips() {
        // DIIS sees one error vector with both commutators in it; nothing may be
        // mixed between the halves on the way back out.
        let alpha = DMatrix::from_row_slice(2, 3, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        let beta = DMatrix::from_row_slice(2, 3, &[-1.0, -2.0, -3.0, -4.0, -5.0, -6.0]);
        let stacked = stack(&alpha, &beta);
        assert_eq!(stacked.shape(), (4, 3));
        let (back_alpha, back_beta) = split(&stacked);
        assert_eq!(back_alpha, alpha);
        assert_eq!(back_beta, beta);
        // And a linear combination of stacked matrices is the same combination
        // of each half, which is what makes the shared extrapolation valid.
        let scaled = split(&(&stacked * 0.5));
        assert_relative_eq!(scaled.0, &alpha * 0.5, epsilon = 1e-15);
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
