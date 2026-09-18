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
//! The unrestricted case is the same expression with two densities and two
//! potentials; the functional itself is spin-polarised throughout, so only the
//! assembly differs.

pub mod lda;

use nalgebra::{DMatrix, DMatrixView};

use crate::basis::BasisSet;
use crate::grid::MolecularGrid;

/// Grid points per block. Big enough for the matrix products to pay off, small
/// enough that the basis-value block stays in cache.
const BLOCK: usize = 128;

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
    let n = basis.n_functions();
    debug_assert_eq!(density.nrows(), n);

    let mut potential = DMatrix::zeros(n, n);
    let mut energy = 0.0;
    let mut n_electrons = 0.0;
    let mut scaled = DMatrix::zeros(n, BLOCK);

    for_each_block(basis, grid, |phi, weights| {
        let count = weights.len();
        // D phi, so that rho_j is the dot product of column j with phi's.
        let weighted = density * phi;
        let mut block_scaled = scaled.view_mut((0, 0), (n, count));
        for j in 0..count {
            let rho = column_dot(&phi, &weighted, j).max(0.0);
            let (exc, v) = lda::lda_restricted(rho);
            energy += weights[j] * rho * exc;
            n_electrons += weights[j] * rho;
            let factor = weights[j] * v;
            for mu in 0..n {
                block_scaled[(mu, j)] = factor * phi[(mu, j)];
            }
        }
        potential.gemm(1.0, &block_scaled, &phi.transpose(), 1.0);
    });

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
    let n = basis.n_functions();
    debug_assert_eq!(alpha.nrows(), n);
    debug_assert_eq!(beta.nrows(), n);

    let mut potential_alpha = DMatrix::zeros(n, n);
    let mut potential_beta = DMatrix::zeros(n, n);
    let mut energy = 0.0;
    let mut n_electrons = 0.0;
    let mut scaled_alpha = DMatrix::zeros(n, BLOCK);
    let mut scaled_beta = DMatrix::zeros(n, BLOCK);

    for_each_block(basis, grid, |phi, weights| {
        let count = weights.len();
        let weighted_alpha = alpha * phi;
        let weighted_beta = beta * phi;
        let mut block_alpha = scaled_alpha.view_mut((0, 0), (n, count));
        let mut block_beta = scaled_beta.view_mut((0, 0), (n, count));
        for j in 0..count {
            let rho_alpha = column_dot(&phi, &weighted_alpha, j).max(0.0);
            let rho_beta = column_dot(&phi, &weighted_beta, j).max(0.0);
            let point = lda::lda(rho_alpha, rho_beta);
            let rho = rho_alpha + rho_beta;
            energy += weights[j] * rho * point.exc;
            n_electrons += weights[j] * rho;
            let factor_alpha = weights[j] * point.v_alpha;
            let factor_beta = weights[j] * point.v_beta;
            for mu in 0..n {
                block_alpha[(mu, j)] = factor_alpha * phi[(mu, j)];
                block_beta[(mu, j)] = factor_beta * phi[(mu, j)];
            }
        }
        potential_alpha.gemm(1.0, &block_alpha, &phi.transpose(), 1.0);
        potential_beta.gemm(1.0, &block_beta, &phi.transpose(), 1.0);
    });

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
    let n = basis.n_functions();
    debug_assert_eq!(alpha.nrows(), n);
    debug_assert_eq!(beta.nrows(), n);

    // sum_g w_g v_sigma(r_g) (d_k phi_mu)(r_g) phi_nu(r_g), one per direction
    // and spin. Not symmetric: only the bra is differentiated.
    let mut weighted_alpha: [DMatrix<f64>; 3] =
        std::array::from_fn(|_| DMatrix::zeros(n, n));
    let mut weighted_beta: [DMatrix<f64>; 3] = std::array::from_fn(|_| DMatrix::zeros(n, n));

    let mut values = vec![0.0; n * BLOCK];
    let mut dx = vec![0.0; n * BLOCK];
    let mut dy = vec![0.0; n * BLOCK];
    let mut dz = vec![0.0; n * BLOCK];
    let mut scaled = DMatrix::zeros(n, BLOCK);
    let mut factors_alpha = vec![0.0; BLOCK];
    let mut factors_beta = vec![0.0; BLOCK];

    let mut start = 0;
    while start < grid.len() {
        let count = BLOCK.min(grid.len() - start);
        for j in 0..count {
            let point = grid.points[start + j];
            let range = j * n..(j + 1) * n;
            basis.evaluate_into(point, &mut values[range.clone()]);
            basis.evaluate_gradient_into(
                point,
                &mut dx[range.clone()],
                &mut dy[range.clone()],
                &mut dz[range],
            );
        }
        let phi = DMatrixView::from_slice(&values[..n * count], n, count);
        let phi_t = phi.transpose();
        let gradients = [
            DMatrixView::from_slice(&dx[..n * count], n, count),
            DMatrixView::from_slice(&dy[..n * count], n, count),
            DMatrixView::from_slice(&dz[..n * count], n, count),
        ];
        let weights = &grid.weights[start..start + count];

        let phi_alpha = alpha * phi;
        let phi_beta = beta * phi;
        for j in 0..count {
            let rho_alpha = column_dot(&phi, &phi_alpha, j).max(0.0);
            let rho_beta = column_dot(&phi, &phi_beta, j).max(0.0);
            let point = lda::lda(rho_alpha, rho_beta);
            factors_alpha[j] = weights[j] * point.v_alpha;
            factors_beta[j] = weights[j] * point.v_beta;
        }

        for k in 0..3 {
            for (factors, target) in [
                (&factors_alpha, &mut weighted_alpha[k]),
                (&factors_beta, &mut weighted_beta[k]),
            ] {
                let mut block = scaled.view_mut((0, 0), (n, count));
                for j in 0..count {
                    for mu in 0..n {
                        block[(mu, j)] = factors[j] * gradients[k][(mu, j)];
                    }
                }
                target.gemm(1.0, &block, &phi_t, 1.0);
            }
        }
        start += count;
    }

    let centers = basis.function_centers();
    let mut gradient = vec![[0.0; 3]; n_atoms];
    for mu in 0..n {
        let atom = centers[mu];
        for k in 0..3 {
            let mut sum = 0.0;
            for nu in 0..n {
                sum += alpha[(mu, nu)] * weighted_alpha[k][(mu, nu)]
                    + beta[(mu, nu)] * weighted_beta[k][(mu, nu)];
            }
            gradient[atom][k] -= 2.0 * sum;
        }
    }
    gradient
}

/// The same for a spin-restricted density, where both channels hold half of it.
pub fn restricted_gradient(
    basis: &BasisSet,
    grid: &MolecularGrid,
    density: &DMatrix<f64>,
    n_atoms: usize,
) -> Vec<[f64; 3]> {
    let half = density * 0.5;
    unrestricted_gradient(basis, grid, &half, &half, n_atoms)
}

/// Walks the grid in blocks, handing each block's basis values and weights to
/// `consume`.
///
/// Column `j` of the block holds every basis function evaluated at point `j`,
/// which is what makes each column contiguous and each product a gemm.
fn for_each_block(
    basis: &BasisSet,
    grid: &MolecularGrid,
    mut consume: impl FnMut(DMatrixView<f64>, &[f64]),
) {
    let n = basis.n_functions();
    let mut values = vec![0.0; n * BLOCK];
    let mut start = 0;
    while start < grid.len() {
        let count = BLOCK.min(grid.len() - start);
        for j in 0..count {
            basis.evaluate_into(grid.points[start + j], &mut values[j * n..(j + 1) * n]);
        }
        let phi = DMatrixView::from_slice(&values[..n * count], n, count);
        consume(phi, &grid.weights[start..start + count]);
        start += count;
    }
}

/// `sum_mu phi[mu, j] * weighted[mu, j]`, the density at point `j` of a block.
///
/// Numerical noise can push this slightly negative in the far tail; the
/// functional is only defined for a non-negative density, so callers clamp.
fn column_dot(phi: &DMatrixView<f64>, weighted: &DMatrix<f64>, j: usize) -> f64 {
    (0..phi.nrows()).map(|mu| phi[(mu, j)] * weighted[(mu, j)]).sum()
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
