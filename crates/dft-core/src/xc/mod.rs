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

/// Exchange-correlation energy and potential for a spin-restricted density
/// matrix (the total density, so `rho_alpha = rho_beta = rho/2`).
pub fn restricted(
    basis: &BasisSet,
    grid: &MolecularGrid,
    density: &DMatrix<f64>,
) -> XcResult {
    let n = basis.n_functions();
    debug_assert_eq!(density.nrows(), n);

    let mut potential = DMatrix::zeros(n, n);
    let mut energy = 0.0;
    let mut n_electrons = 0.0;

    // Column `j` holds every basis function evaluated at point `j` of the block,
    // which is what makes each column contiguous and each product a gemm.
    let mut values = vec![0.0; n * BLOCK];
    let mut scaled = DMatrix::zeros(n, BLOCK);

    let mut start = 0;
    while start < grid.len() {
        let count = BLOCK.min(grid.len() - start);
        for j in 0..count {
            basis.evaluate_into(grid.points[start + j], &mut values[j * n..(j + 1) * n]);
        }
        let phi = DMatrixView::from_slice(&values[..n * count], n, count);
        // D phi, so that rho_j is the dot product of column j with phi's.
        let weighted = density * phi;

        let mut block_scaled = scaled.view_mut((0, 0), (n, count));
        for j in 0..count {
            let mut rho = 0.0;
            for mu in 0..n {
                rho += phi[(mu, j)] * weighted[(mu, j)];
            }
            // Numerical noise can push the density slightly negative in the far
            // tail; the functional is only defined for rho >= 0.
            let rho = rho.max(0.0);
            let weight = grid.weights[start + j];
            let (exc, v) = lda::lda_restricted(rho);
            energy += weight * rho * exc;
            n_electrons += weight * rho;
            let factor = weight * v;
            for mu in 0..n {
                block_scaled[(mu, j)] = factor * phi[(mu, j)];
            }
        }
        potential.gemm(1.0, &block_scaled, &phi.transpose(), 1.0);
        start += count;
    }

    XcResult { energy, potential, n_electrons }
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
    fn energy_is_negative_for_any_sensible_density() {
        let mol = Molecule::from_angstrom(&[(6, [0.0; 3])]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let grid = grid::build(&mol, GridQuality::Coarse);
        let n = basis.n_functions();
        let density = DMatrix::identity(n, n);
        assert!(restricted(&basis, &grid, &density).energy < 0.0);
    }
}
