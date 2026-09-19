//! Numerical evaluation of the exchange-correlation term on the molecular grid.
//!
//! The work is done in blocks of grid points so the basis-value matrix stays
//! small and the inner products become matrix products:
//!
//! ```text
//! rho_i     = sum_mu_nu D_mu_nu phi_mu(r_i) phi_nu(r_i)
//! E_xc      = sum_i w_i rho_i eps_xc(rho_i)
//! V_xc_mu_nu = sum_i w_i v_xc(rho_i) phi_mu(r_i) phi_nu(r_i)
//! ```
//!
//! Each block only carries the basis functions that are not negligible on it
//! (see [`blocks`]); the density matrix is cut down to those rows and columns,
//! the products are formed at that size (see [`kernels`]), and the result is
//! added back into the full matrix. On benzene's fine grid that leaves out a
//! quarter of all the basis values, and the products shrink with the square.
//!
//! The unrestricted case is the same expression with two densities and two
//! potentials; the functional itself is spin-polarised throughout, so only the
//! assembly differs.

mod blocks;
mod kernels;
pub mod lda;

use nalgebra::DMatrix;

use crate::basis::BasisSet;
use crate::grid::MolecularGrid;
pub use blocks::BasisOnGrid;
use blocks::{BlockBasis, BLOCK, SCREENING};

/// Exchange-correlation energy, its potential matrix, and the electron count the
/// grid produced.
#[derive(Debug, Clone)]
pub struct XcResult {
    /// `E_xc` in Hartree.
    pub energy: f64,
    /// `V_xc` in the atomic-orbital basis.
    pub potential: DMatrix<f64>,
    /// `integral rho dr`. It should equal the electron count; the deviation is a
    /// direct measure of how good the grid is, and the SCF reports it.
    pub n_electrons: f64,
}

/// The same for a spin-polarised density: one potential per spin channel.
#[derive(Debug, Clone)]
pub struct UnrestrictedXcResult {
    pub energy: f64,
    pub potential_alpha: DMatrix<f64>,
    pub potential_beta: DMatrix<f64>,
    /// `integral (rho_alpha + rho_beta) dr`, the total electron count.
    pub n_electrons: f64,
}

/// Exchange-correlation energy and potential for a spin-restricted density
/// matrix (the total density, so `rho_alpha = rho_beta = rho/2`).
pub fn restricted(basis: &BasisSet, grid: &MolecularGrid, density: &DMatrix<f64>) -> XcResult {
    restricted_on(&BasisOnGrid::new(basis, grid), grid, density)
}

/// The same with the basis already evaluated on the grid - what an SCF uses,
/// evaluating once and iterating many times.
pub fn restricted_on(
    on_grid: &BasisOnGrid,
    grid: &MolecularGrid,
    density: &DMatrix<f64>,
) -> XcResult {
    let n = density.nrows();
    let mut potential = DMatrix::zeros(n, n);
    let mut energy = 0.0;
    let mut n_electrons = 0.0;
    let mut work = Workspace::default();

    for block in on_grid.blocks() {
        let (m, count) = (block.functions.len(), block.count);
        let weights = &grid.weights[block.start..block.start + count];
        work.densities(0, density, block.functions, block.values, count);
        let scaled = &mut work.scaled[0];
        grow(scaled, m * count);
        for j in 0..count {
            let column = j * m..(j + 1) * m;
            let rho = work.rho[0][j].max(0.0);
            let (exc, v) = lda::lda_restricted(rho);
            energy += weights[j] * rho * exc;
            n_electrons += weights[j] * rho;
            let factor = weights[j] * v;
            for (target, &value) in scaled[column.clone()].iter_mut().zip(&block.values[column]) {
                *target = factor * value;
            }
        }
        let (scaled, scratch) = (&work.scaled[0], &mut work.block);
        add_product(&mut potential, block.runs, scaled, block.values, m, count, scratch);
    }

    XcResult { energy, potential, n_electrons }
}

/// Exchange-correlation energy and both potentials for a pair of spin density
/// matrices, each holding the electrons of one spin.
pub fn unrestricted(
    basis: &BasisSet,
    grid: &MolecularGrid,
    alpha: &DMatrix<f64>,
    beta: &DMatrix<f64>,
) -> UnrestrictedXcResult {
    unrestricted_on(&BasisOnGrid::new(basis, grid), grid, alpha, beta)
}

/// The same with the basis already evaluated on the grid.
pub fn unrestricted_on(
    on_grid: &BasisOnGrid,
    grid: &MolecularGrid,
    alpha: &DMatrix<f64>,
    beta: &DMatrix<f64>,
) -> UnrestrictedXcResult {
    let n = alpha.nrows();
    debug_assert_eq!(beta.nrows(), n);

    let mut potential_alpha = DMatrix::zeros(n, n);
    let mut potential_beta = DMatrix::zeros(n, n);
    let mut energy = 0.0;
    let mut n_electrons = 0.0;
    let mut work = Workspace::default();

    for block in on_grid.blocks() {
        let (m, count) = (block.functions.len(), block.count);
        let weights = &grid.weights[block.start..block.start + count];
        work.densities(0, alpha, block.functions, block.values, count);
        work.densities(1, beta, block.functions, block.values, count);
        for scaled in &mut work.scaled {
            grow(scaled, m * count);
        }
        for j in 0..count {
            let column = j * m..(j + 1) * m;
            let values = &block.values[column.clone()];
            let rho_alpha = work.rho[0][j].max(0.0);
            let rho_beta = work.rho[1][j].max(0.0);
            let point = lda::lda(rho_alpha, rho_beta);
            let rho = rho_alpha + rho_beta;
            energy += weights[j] * rho * point.exc;
            n_electrons += weights[j] * rho;
            let factor_alpha = weights[j] * point.v_alpha;
            let factor_beta = weights[j] * point.v_beta;
            let [scaled_alpha, scaled_beta] = &mut work.scaled;
            for ((a, b), &value) in scaled_alpha[column.clone()]
                .iter_mut()
                .zip(&mut scaled_beta[column.clone()])
                .zip(values)
            {
                *a = factor_alpha * value;
                *b = factor_beta * value;
            }
        }
        let ([scaled_alpha, scaled_beta], scratch) = (&work.scaled, &mut work.block);
        let values = block.values;
        add_product(&mut potential_alpha, block.runs, scaled_alpha, values, m, count, scratch);
        add_product(&mut potential_beta, block.runs, scaled_beta, values, m, count, scratch);
    }

    UnrestrictedXcResult { energy, potential_alpha, potential_beta, n_electrons }
}

/// Gradient of `E_xc` with respect to every nuclear position, in Hartree/Bohr.
///
/// At a converged density the only geometry dependence left is in the basis
/// functions, which move with their nuclei:
///
/// ```text
/// dE_xc/dA_k = -2 sum_sigma sum_(mu on A, nu) D_sigma_mu_nu
///                  sum_g w_g v_sigma(r_g) (d_k phi_mu)(r_g) phi_nu(r_g)
/// ```
///
/// The minus sign is the whole content of the derivative: a basis function
/// depends on `r - A`, so moving its nucleus one way is moving the electron the
/// other, and the factor of two is the two places a function appears in the
/// density.
///
/// **The derivatives of the grid weights are deliberately left out.** The Becke
/// cells are tied to the nuclei, so strictly `dw_g/dA` contributes too; that
/// term is the standard omission in practical codes because it costs as much as
/// everything else here and, on a grid of this size, moves a force by far less
/// than the threshold at which the optimiser stops. What it does mean is that
/// the gradient below is the exact derivative of the energy *on a fixed grid*
/// rather than of the energy as the grid follows the atoms, and the
/// finite-difference tests are written to respect that distinction: the strict
/// comparison freezes the grid, and a second, looser one measures what the
/// omission is actually worth.
pub fn unrestricted_gradient(
    basis: &BasisSet,
    grid: &MolecularGrid,
    alpha: &DMatrix<f64>,
    beta: &DMatrix<f64>,
    n_atoms: usize,
) -> Vec<[f64; 3]> {
    gradient_screened(basis, grid, &[alpha, beta], n_atoms, SCREENING)
}

/// The same for a spin-restricted density: one channel holding both spins.
///
/// Both spins see the same potential and hold half the density each, so the
/// sum over spins collapses to the total density with `v_xc` once - half the
/// work of running the unrestricted expression on two identical halves.
pub fn restricted_gradient(
    basis: &BasisSet,
    grid: &MolecularGrid,
    density: &DMatrix<f64>,
    n_atoms: usize,
) -> Vec<[f64; 3]> {
    gradient_screened(basis, grid, &[density], n_atoms, SCREENING)
}

/// `densities` is `[total]` for a restricted calculation, `[alpha, beta]` for an
/// unrestricted one.
///
/// The expression above never needs a matrix: its inner sum over `nu` is
/// `(D phi)_mu` at the grid point, which the density at that point is built
/// from anyway. So each block contributes
///
/// ```text
/// -2 sum_g f_g (d_k phi_mu)(r_g) (D phi)_mu(r_g)      for each mu on the block
/// ```
///
/// with `f_g = w_g v_xc(r_g)`: a pass over the block's values rather than a
/// product of two of them.
fn gradient_screened(
    basis: &BasisSet,
    grid: &MolecularGrid,
    densities: &[&DMatrix<f64>],
    n_atoms: usize,
    threshold: f64,
) -> Vec<[f64; 3]> {
    let n = basis.n_functions();
    debug_assert!(densities.iter().all(|d| d.nrows() == n));
    let restricted = densities.len() == 1;

    let centers = basis.function_centers();
    let mut gradient = vec![[0.0; 3]; n_atoms];
    let mut blocks = BlockBasis::new(basis, threshold);
    let mut work = Workspace::default();
    let mut factors = [vec![0.0; BLOCK], vec![0.0; BLOCK]];
    // Per function of the block, the three components summed over its points.
    let mut per_function: Vec<[f64; 3]> = Vec::new();

    for (points, weights) in grid.points.chunks(BLOCK).zip(grid.weights.chunks(BLOCK)) {
        let m = blocks.load(points, true);
        if m == 0 {
            continue;
        }
        let count = points.len();
        for (slot, density) in densities.iter().enumerate() {
            work.weighted(slot, density, &blocks.functions, &blocks.values[..m * count]);
        }
        for j in 0..count {
            let column = j * m..(j + 1) * m;
            let values = &blocks.values[column.clone()];
            if restricted {
                let rho = dot(values, &work.products[0][column]).max(0.0);
                factors[0][j] = weights[j] * lda::lda_restricted(rho).1;
            } else {
                let rho_alpha = dot(values, &work.products[0][column.clone()]).max(0.0);
                let rho_beta = dot(values, &work.products[1][column]).max(0.0);
                let point = lda::lda(rho_alpha, rho_beta);
                factors[0][j] = weights[j] * point.v_alpha;
                factors[1][j] = weights[j] * point.v_beta;
            }
        }

        per_function.clear();
        per_function.resize(m, [0.0; 3]);
        for slot in 0..densities.len() {
            let products = &work.products[slot];
            for (j, &factor) in factors[slot][..count].iter().enumerate() {
                if factor == 0.0 {
                    continue;
                }
                let column = j * m..(j + 1) * m;
                for k in 0..3 {
                    let slopes = &blocks.gradient[k][column.clone()];
                    for ((total, &slope), &product) in
                        per_function.iter_mut().zip(slopes).zip(&products[column.clone()])
                    {
                        total[k] += factor * slope * product;
                    }
                }
            }
        }
        for (&mu, total) in blocks.functions.iter().zip(&per_function) {
            let atom = centers[mu];
            for k in 0..3 {
                gradient[atom][k] -= 2.0 * total[k];
            }
        }
    }
    gradient
}

/// Scratch space for one block, kept across blocks so the loop allocates
/// nothing once it has seen its largest block.
#[derive(Default)]
struct Workspace {
    /// The density matrix cut down to the block's functions.
    density: Vec<f64>,
    /// `D phi` for up to two densities.
    products: [Vec<f64>; 2],
    /// The density at each point of the block, for up to two densities.
    rho: [Vec<f64>; 2],
    /// Weighted basis values (or derivatives) for up to two channels.
    scaled: [Vec<f64>; 2],
    /// A block-sized product before it is added into the full matrix.
    block: Vec<f64>,
}

impl Workspace {
    /// The density `D` at each point of the block, stored as `rho[slot]`.
    fn densities(
        &mut self,
        slot: usize,
        density: &DMatrix<f64>,
        functions: &[usize],
        phi: &[f64],
        count: usize,
    ) {
        let m = functions.len();
        kernels::doubled_lower_triangle(density, functions, &mut self.density);
        let rho = &mut self.rho[slot];
        grow(rho, count);
        kernels::density_at_points(&self.density, m, &phi[..m * count], count, rho);
    }

    /// `D phi` restricted to the block's functions, stored as product `slot`.
    fn weighted(&mut self, slot: usize, density: &DMatrix<f64>, functions: &[usize], phi: &[f64]) {
        let m = functions.len();
        let count = phi.len() / m.max(1);
        self.density.clear();
        self.density.extend(
            functions.iter().flat_map(|&nu| functions.iter().map(move |&mu| density[(mu, nu)])),
        );
        let product = &mut self.products[slot];
        grow(product, m * count);
        kernels::times_density(&self.density, m, phi, count, product);
    }
}

/// `target[functions, functions] += scaled phi^T` for one block, where `runs`
/// lists the block's functions as runs of consecutive basis indices (see
/// `BlockBasis::runs`): a few slice additions per column rather than one
/// indexed add per entry.
fn add_product(
    target: &mut DMatrix<f64>,
    runs: &[(usize, usize, usize)],
    scaled: &[f64],
    phi: &[f64],
    m: usize,
    count: usize,
    scratch: &mut Vec<f64>,
) {
    grow(scratch, m * m);
    kernels::symmetric_product(scaled, phi, m, count, scratch);
    let n = target.nrows();
    let full = target.as_mut_slice();
    for &(column_start, nu_first, columns) in runs {
        for c in 0..columns {
            let source = &scratch[(column_start + c) * m..(column_start + c + 1) * m];
            let destination = &mut full[(nu_first + c) * n..(nu_first + c + 1) * n];
            for &(row_start, mu_first, rows) in runs {
                for (d, s) in destination[mu_first..mu_first + rows]
                    .iter_mut()
                    .zip(&source[row_start..row_start + rows])
                {
                    *d += s;
                }
            }
        }
    }
}

/// Makes `buffer` at least `len` long without touching what is already there:
/// everything a block reads it has written first.
fn grow(buffer: &mut Vec<f64>, len: usize) {
    if buffer.len() < len {
        buffer.resize(len, 0.0);
    }
}

/// `sum_i a_i b_i`.
#[inline]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis::Shell;
    use crate::grid::{self, GridQuality};
    use crate::molecule::{Atom, Molecule};
    use approx::assert_relative_eq;

    #[test]
    fn integrates_the_electron_count_of_a_single_normalised_function() {
        // One normalised s function with occupation two: the grid must return two
        // electrons, and E_xc must match a direct sum over the same grid.
        let mol = Molecule::new(vec![Atom { z: 1, pos: [0.0; 3] }]).unwrap();
        let basis =
            BasisSet::from_shells(vec![Shell::new(0, [0.0; 3], 0, &[0.8, 0.2], &[0.6, 0.5])]);
        let grid = grid::build(&mol, GridQuality::Fine);
        let density = DMatrix::from_element(1, 1, 2.0);
        let result = restricted(&basis, &grid, &density);
        assert_relative_eq!(result.n_electrons, 2.0, max_relative = 1e-8);

        let expected_energy = grid.integrate(|p| {
            let phi = basis.evaluate(p)[0];
            let rho = 2.0 * phi * phi;
            rho * lda::lda_restricted(rho).0
        });
        assert_relative_eq!(result.energy, expected_energy, max_relative = 1e-12);
    }

    #[test]
    fn potential_matrix_is_symmetric_and_matches_a_direct_sum() {
        let mol = Molecule::from_angstrom(&[(8, [0.0; 3]), (1, [0.0, 0.0, 0.96])]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let grid = grid::build(&mol, GridQuality::Coarse);
        let n = basis.n_functions();
        // A crude but valid density matrix: a scaled identity.
        let density = DMatrix::identity(n, n) * 0.8;
        let result = restricted(&basis, &grid, &density);

        for i in 0..n {
            for j in 0..n {
                assert_relative_eq!(
                    result.potential[(i, j)],
                    result.potential[(j, i)],
                    epsilon = 1e-14
                );
            }
        }

        // Rebuild two entries the slow way, straight from the definition.
        for &(mu, nu) in &[(0usize, 0usize), (2, 5)] {
            let expected = grid.integrate(|p| {
                let phi = basis.evaluate(p);
                let rho: f64 = (0..n).map(|k| density[(k, k)] * phi[k] * phi[k]).sum();
                lda::lda_restricted(rho.max(0.0)).1 * phi[mu] * phi[nu]
            });
            assert_relative_eq!(result.potential[(mu, nu)], expected, max_relative = 1e-10);
        }
    }

    #[test]
    fn splitting_a_density_evenly_reproduces_the_restricted_result() {
        // rho_alpha = rho_beta = rho/2 is exactly what `restricted` assumes, so
        // the two assemblies must agree to the last bit for a closed shell.
        let mol = Molecule::from_angstrom(&[(7, [0.0; 3]), (1, [0.0, 0.0, 1.01])]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let grid = grid::build(&mol, GridQuality::Coarse);
        let n = basis.n_functions();
        let density = DMatrix::identity(n, n) * 0.7;
        let half = &density * 0.5;

        let closed = restricted(&basis, &grid, &density);
        let open = unrestricted(&basis, &grid, &half, &half);
        assert_relative_eq!(open.energy, closed.energy, max_relative = 1e-12);
        assert_relative_eq!(open.n_electrons, closed.n_electrons, max_relative = 1e-12);
        assert_relative_eq!(open.potential_alpha, closed.potential, epsilon = 1e-12);
        // Both channels see the same density, so both potentials are the same.
        assert_relative_eq!(open.potential_beta, closed.potential, epsilon = 1e-12);
    }

    #[test]
    fn polarising_a_density_lowers_the_energy_and_splits_the_potentials() {
        // Moving electrons into one channel at fixed total density is what the
        // spin-polarised functional is for: exchange is more negative when the
        // electrons are aligned, so the energy has to fall.
        let mol = Molecule::from_angstrom(&[(8, [0.0; 3]), (8, [0.0, 0.0, 1.208])]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let grid = grid::build(&mol, GridQuality::Coarse);
        let n = basis.n_functions();
        let total = DMatrix::identity(n, n) * 0.9;
        let balanced = unrestricted(&basis, &grid, &(&total * 0.5), &(&total * 0.5));
        let polarised = unrestricted(&basis, &grid, &(&total * 0.65), &(&total * 0.35));

        assert!(
            polarised.energy < balanced.energy,
            "polarising raised E_xc from {} to {}",
            balanced.energy,
            polarised.energy
        );
        // The same electrons either way, so the grid must count the same number.
        assert_relative_eq!(polarised.n_electrons, balanced.n_electrons, max_relative = 1e-12);
        // The channel holding more electrons gets the deeper potential.
        let trace_alpha = polarised.potential_alpha.trace();
        let trace_beta = polarised.potential_beta.trace();
        assert!(trace_alpha < trace_beta, "{trace_alpha} vs {trace_beta}");
        for i in 0..n {
            for j in 0..n {
                assert_relative_eq!(
                    polarised.potential_alpha[(i, j)],
                    polarised.potential_alpha[(j, i)],
                    epsilon = 1e-14
                );
            }
        }
    }

    /// Screening leaves out only what is provably below `1e-14`, so the energy,
    /// both potentials and the gradient must come out as they do with every
    /// function kept - on a molecule big enough that a lot is screened.
    #[test]
    fn screening_changes_nothing_that_matters() {
        let mut atoms = Vec::new();
        for i in 0..6 {
            let angle = i as f64 * std::f64::consts::PI / 3.0;
            atoms.push((6, [1.39 * angle.cos(), 1.39 * angle.sin(), 0.0]));
            atoms.push((1, [2.48 * angle.cos(), 2.48 * angle.sin(), 0.0]));
        }
        let mol = Molecule::from_angstrom(&atoms).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let grid = grid::build(&mol, GridQuality::Coarse);
        let n = basis.n_functions();
        // Not a physical density, but a full one: every pair of functions
        // contributes, so nothing can hide behind a zero.
        let raw = DMatrix::from_fn(n, n, |i, j| 0.05 * ((i * 5 + j * 3) as f64).cos());
        let alpha = (&raw + raw.transpose()) * 0.5 + DMatrix::identity(n, n) * 0.4;
        let beta = &alpha * 0.8;

        let screened_basis = BasisOnGrid::with_threshold(&basis, &grid, SCREENING);
        let full_basis = BasisOnGrid::with_threshold(&basis, &grid, 0.0);
        let screened = unrestricted_on(&screened_basis, &grid, &alpha, &beta);
        let full = unrestricted_on(&full_basis, &grid, &alpha, &beta);
        let gap = (screened.energy - full.energy).abs();
        assert!(gap < 1e-12, "{} vs {}", screened.energy, full.energy);
        assert!((&screened.potential_alpha - &full.potential_alpha).amax() < 1e-12);
        assert!((&screened.potential_beta - &full.potential_beta).amax() < 1e-12);

        let closed = restricted_on(&screened_basis, &grid, &alpha);
        let closed_full = restricted_on(&full_basis, &grid, &alpha);
        assert!((closed.energy - closed_full.energy).abs() < 1e-12);
        assert!((&closed.potential - &closed_full.potential).amax() < 1e-12);

        let atoms = mol.n_atoms();
        let g = gradient_screened(&basis, &grid, &[&alpha, &beta], atoms, SCREENING);
        let g_full = gradient_screened(&basis, &grid, &[&alpha, &beta], atoms, 0.0);
        for (a, b) in g.iter().zip(&g_full) {
            for k in 0..3 {
                assert!((a[k] - b[k]).abs() < 1e-12, "gradient {} vs {}", a[k], b[k]);
            }
        }
    }

    /// The restricted gradient takes the one-channel shortcut; it has to be the
    /// unrestricted expression evaluated on two equal halves.
    #[test]
    fn the_restricted_gradient_is_the_unrestricted_one_on_two_halves() {
        let mol = Molecule::from_angstrom(&[
            (8, [0.03, -0.11, 0.17]),
            (1, [0.21, 0.88, -0.31]),
            (1, [-0.05, -0.62, -0.83]),
        ])
        .unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let grid = grid::build(&mol, GridQuality::Coarse);
        let n = basis.n_functions();
        let raw = DMatrix::from_fn(n, n, |i, j| 0.1 * ((i * 3 + j * 7) as f64).sin());
        let density = (&raw + raw.transpose()) * 0.5 + DMatrix::identity(n, n);
        let half = &density * 0.5;
        let closed = restricted_gradient(&basis, &grid, &density, 3);
        let open = unrestricted_gradient(&basis, &grid, &half, &half, 3);
        for (a, b) in closed.iter().zip(&open) {
            for k in 0..3 {
                assert!((a[k] - b[k]).abs() < 1e-12 * (1.0 + b[k].abs()), "{} vs {}", a[k], b[k]);
            }
        }
    }

    #[test]
    fn energy_is_negative_for_any_sensible_density() {
        let mol = Molecule::from_angstrom(&[(6, [0.0; 3])]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let grid = grid::build(&mol, GridQuality::Coarse);
        let n = basis.n_functions();
        let density = DMatrix::identity(n, n);
        assert!(restricted(&basis, &grid, &density).energy < 0.0);
    }
}
