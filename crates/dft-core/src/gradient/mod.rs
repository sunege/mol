//! Analytic nuclear gradients of the Kohn-Sham LDA energy.
//!
//! The force on a nucleus is not just the electrostatic pull of the electron
//! cloud on it. That would be the Hellmann-Feynman term, and on its own it is
//! wrong - badly enough to point the wrong way for a stretched bond - because
//! the basis functions sit *on* the nuclei and therefore change when the nuclei
//! move. The energy at a converged density is
//!
//! ```text
//! E = sum D H + 1/2 sum D J[D] + E_xc[rho] + E_nn
//! ```
//!
//! and differentiating it with the orbital coefficients held at their converged
//! values gives
//!
//! ```text
//! dE/dR = sum_mu_nu D_mu_nu dH_mu_nu/dR
//!       + 1/2 sum D D d(mu nu|lambda sigma)/dR
//!       + dE_xc/dR
//!       + dE_nn/dR
//!       - sum_mu_nu W_mu_nu dS_mu_nu/dR
//! ```
//!
//! The last term - the Pulay correction, with `W` the energy-weighted density
//! matrix - is what pays for keeping the orbitals orthonormal in a basis that is
//! moving underneath them. Every term but `dE_nn/dR` therefore has a piece that
//! comes from the basis following the nuclei, and
//! [`crate::integrals::deriv`] is where those are computed.
//!
//! One approximation is made and is visible in the tests: the derivatives of the
//! integration grid's weights are left out of `dE_xc/dR` (see
//! [`crate::xc::unrestricted_gradient`]). Everything else is exact.

pub mod finite_difference;

use nalgebra::DMatrix;

use crate::integrals::deriv::{self, GRADIENT_SCREENING};
use crate::scf::{ScfResult, System};
use crate::xc;

/// Gradient of the total energy with respect to every nuclear position, in
/// Hartree per Bohr. Shape `[n_atoms][3]`.
///
/// The force on an atom is minus this.
///
/// `result` must be a converged solution *for this system*: the expression above
/// drops a term that vanishes only at self-consistency, so a gradient taken from
/// a half-converged density is not the derivative of anything.
pub fn energy_gradient(system: &System, result: &ScfResult) -> Vec<[f64; 3]> {
    let molecule = &system.molecule;
    let weighted = energy_weighted_density(result);

    let mut gradient = molecule.nuclear_repulsion_gradient();
    add(
        &mut gradient,
        &deriv::one_electron_gradient(&system.basis, molecule, &result.density, &weighted),
    );
    add(
        &mut gradient,
        &deriv::two_electron_gradient(
            &system.basis,
            molecule,
            &result.density,
            GRADIENT_SCREENING,
        ),
    );
    add(&mut gradient, &exchange_correlation_gradient(system, result));
    gradient
}

/// The exchange-correlation part on its own, split out because it is the one
/// term that differs between a restricted and an unrestricted calculation and
/// the one a test may want to look at by itself.
pub fn exchange_correlation_gradient(system: &System, result: &ScfResult) -> Vec<[f64; 3]> {
    let n_atoms = system.molecule.n_atoms();
    match result.channels.as_slice() {
        [alpha, beta] => xc::unrestricted_gradient(
            &system.basis,
            &system.grid,
            &alpha.density,
            &beta.density,
            n_atoms,
        ),
        _ => xc::restricted_gradient(&system.basis, &system.grid, &result.density, n_atoms),
    }
}

/// The energy-weighted density matrix `W_mu_nu = sum_i n_i eps_i C_mu_i C_nu_i`,
/// summed over spin channels.
///
/// It is the Lagrange multiplier of the orthonormality constraint, which is why
/// it appears multiplied by `dS/dR`: the overlap is exactly what that constraint
/// is written in terms of. A restricted calculation has one channel whose
/// occupations already count both spins, so the same sum serves both cases.
pub fn energy_weighted_density(result: &ScfResult) -> DMatrix<f64> {
    let n = result.density.nrows();
    let mut weighted = DMatrix::zeros(n, n);
    for set in &result.channels {
        for i in 0..set.occupations.len() {
            let occupation = set.occupations[i];
            if occupation <= 0.0 {
                continue;
            }
            let column = set.coefficients.column(i);
            weighted += (column * column.transpose()) * (occupation * set.energies[i]);
        }
    }
    weighted
}

/// Largest force component, in Hartree/Bohr. The usual first convergence test.
pub fn max_force(gradient: &[[f64; 3]]) -> f64 {
    gradient
        .iter()
        .flat_map(|g| g.iter())
        .fold(0.0f64, |worst, value| worst.max(value.abs()))
}

/// Root-mean-square force over all `3N` components, in Hartree/Bohr.
pub fn rms_force(gradient: &[[f64; 3]]) -> f64 {
    if gradient.is_empty() {
        return 0.0;
    }
    let total: f64 = gradient.iter().flat_map(|g| g.iter()).map(|v| v * v).sum();
    (total / (3 * gradient.len()) as f64).sqrt()
}

/// Subtracts the average force from every atom.
///
/// Translating a molecule cannot change its energy, so the gradient sums to zero
/// analytically; what is left is quadrature noise, and integrating it over a
/// hundred optimisation steps would walk the molecule off the screen. Removing
/// it changes nothing about where the structure relaxes to, because the
/// direction removed is one the energy does not depend on.
pub fn remove_net_force(gradient: &mut [[f64; 3]]) {
    if gradient.is_empty() {
        return;
    }
    let count = gradient.len() as f64;
    for axis in 0..3 {
        let mean: f64 = gradient.iter().map(|g| g[axis]).sum::<f64>() / count;
        for atom in gradient.iter_mut() {
            atom[axis] -= mean;
        }
    }
}

fn add(into: &mut [[f64; 3]], from: &[[f64; 3]]) {
    debug_assert_eq!(into.len(), from.len());
    for (target, source) in into.iter_mut().zip(from) {
        for axis in 0..3 {
            target[axis] += source[axis];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::molecule::{Atom, Molecule};
    use approx::assert_relative_eq;

    #[test]
    fn removing_the_net_force_leaves_the_differences_alone() {
        let mut gradient = [[1.0, 2.0, 3.0], [-0.5, 0.25, 1.0], [0.1, -0.2, 0.3]];
        let before: Vec<f64> = (0..3).map(|k| gradient[0][k] - gradient[1][k]).collect();
        remove_net_force(&mut gradient);
        for axis in 0..3 {
            let sum: f64 = gradient.iter().map(|g| g[axis]).sum();
            assert_relative_eq!(sum, 0.0, epsilon = 1e-14);
            assert_relative_eq!(gradient[0][axis] - gradient[1][axis], before[axis], epsilon = 1e-14);
        }
    }

    #[test]
    fn force_norms_are_what_they_say() {
        let gradient = [[3.0, 0.0, 0.0], [0.0, -4.0, 0.0]];
        assert_relative_eq!(max_force(&gradient), 4.0, epsilon = 1e-15);
        // Six components, of which two are non-zero: sqrt(25/6).
        assert_relative_eq!(rms_force(&gradient), (25.0f64 / 6.0).sqrt(), epsilon = 1e-15);
    }

    /// The weighted density is built from occupied orbitals only, and its trace
    /// against the overlap has to come out as the sum of occupied orbital
    /// energies - which is what it is.
    #[test]
    fn energy_weighted_density_traces_to_the_orbital_energies() {
        use crate::grid::GridQuality;
        use crate::scf::{run_restricted, ScfOptions};

        let molecule = Molecule::new(vec![
            Atom { z: 1, pos: [0.0, 0.0, 0.0] },
            Atom { z: 1, pos: [0.0, 0.0, 1.4] },
        ])
        .unwrap();
        let system = System::build(molecule, GridQuality::Coarse).unwrap();
        let result = run_restricted(&system, &ScfOptions::default());
        let weighted = energy_weighted_density(&result);
        let expected: f64 = result.channels[0]
            .occupations
            .iter()
            .zip(result.channels[0].energies.iter())
            .map(|(n, e)| n * e)
            .sum();
        let trace = (&weighted * &system.overlap).trace();
        assert_relative_eq!(trace, expected, max_relative = 1e-10);
    }
}
