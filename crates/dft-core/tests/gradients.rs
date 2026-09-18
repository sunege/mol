//! The analytic gradient against central differences of the energy.
//!
//! This is the test phase 5 was built around. A Pulay term with the wrong sign,
//! a derivative integral that raises the wrong index, a missing Hellmann-Feynman
//! contribution - none of them change an energy, and all of them change a force
//! by a few percent, which is invisible in a picture of a molecule relaxing. The
//! only thing that catches them is moving a nucleus and measuring.
//!
//! **The grid is held still.** The exchange-correlation gradient leaves out the
//! derivatives of the Becke weights (see `xc::unrestricted_gradient`), so the
//! quantity it computes is the exact derivative of the energy *on a fixed grid*.
//! Differencing that same fixed-grid energy is therefore the comparison that can
//! be made to machine precision, and any disagreement is a real bug rather than
//! a known approximation. What the approximation is actually worth is measured
//! separately, in `the_omitted_grid_weight_derivatives_are_small`, by letting the
//! grid move as it does in the application.

use dft_core::gradient::{self, finite_difference};
use dft_core::grid::{self, GridQuality, MolecularGrid};
use dft_core::molecule::{Atom, Molecule};
use dft_core::scf::{self, ScfOptions, ScfResult, System};

/// The grid the application uses, so the numbers here describe the real thing.
const QUALITY: GridQuality = GridQuality::Medium;

/// Tight enough that the energy noise over a `2e-4` Bohr interval is around
/// `1e-10` Hartree/Bohr, two orders below what is being asserted.
fn tight() -> ScfOptions {
    ScfOptions {
        max_iterations: 400,
        energy_tolerance: 1e-12,
        residual_tolerance: 1e-10,
        ..ScfOptions::default()
    }
}

fn solve(system: &System) -> ScfResult {
    let result = if system.molecule.multiplicity == 1 {
        scf::run_restricted(system, &tight())
    } else {
        scf::run_unrestricted(system, &tight())
    };
    assert!(
        result.converged,
        "the SCF must converge for the gradient to be the derivative of anything \
         (multiplicity {}, {} iterations)",
        system.molecule.multiplicity, result.iterations
    );
    result
}

/// Energy of a geometry on a grid that is *not* rebuilt for it.
fn frozen_grid_energy(molecule: &Molecule, grid: &MolecularGrid) -> f64 {
    let system = System::build_with_grid(molecule.clone(), grid.clone()).unwrap();
    solve(&system).energy
}

/// Energy of a geometry with the grid rebuilt around it, which is what the
/// application computes.
fn moving_grid_energy(molecule: &Molecule, quality: GridQuality) -> f64 {
    let system = System::build(molecule.clone(), quality).unwrap();
    solve(&system).energy
}

/// Distorted water: the O-H lengths differ and the angle is nothing special, so
/// no symmetry can make a wrong term cancel itself.
fn distorted_water(multiplicity: u32) -> Molecule {
    let mut molecule = Molecule::from_angstrom(&[
        (8, [0.03, -0.11, 0.17]),
        (1, [0.21, 0.88, -0.31]),
        (1, [-0.05, -0.62, -0.83]),
    ])
    .unwrap();
    molecule.multiplicity = multiplicity;
    molecule
}

/// Methane with one hydrogen pulled out and the others twisted off the ideal
/// tetrahedron.
fn distorted_methane() -> Molecule {
    Molecule::from_angstrom(&[
        (6, [0.04, -0.02, 0.03]),
        (1, [0.78, 0.71, 0.55]),
        (1, [0.55, -0.83, -0.71]),
        (1, [-0.83, 0.62, -0.49]),
        (1, [-0.61, -0.74, 0.97]),
    ])
    .unwrap()
}

/// Oxygen at a stretched bond, in its triplet ground state: the open-shell case
/// the application actually meets.
fn stretched_oxygen() -> Molecule {
    let mut molecule = Molecule::new(vec![
        Atom { z: 8, pos: [0.0, 0.0, 0.0] },
        Atom { z: 8, pos: [0.31, -0.17, 2.55] },
    ])
    .unwrap();
    molecule.multiplicity = 3;
    molecule
}

/// A methyl radical bent out of its plane: an odd electron count, so genuinely
/// unrestricted with no choice of spin state to make.
fn distorted_methyl() -> Molecule {
    let mut molecule = Molecule::from_angstrom(&[
        (6, [0.02, 0.03, -0.04]),
        (1, [1.12, 0.09, 0.21]),
        (1, [-0.57, 0.94, -0.18]),
        (1, [-0.49, -0.88, 0.33]),
    ])
    .unwrap();
    molecule.multiplicity = 2;
    molecule
}

/// Compares the analytic gradient with a central difference of the fixed-grid
/// energy and returns the worst disagreement, having asserted it is small.
fn check(name: &str, molecule: Molecule) -> f64 {
    let grid = grid::build(&molecule, QUALITY);
    let system = System::build_with_grid(molecule.clone(), grid.clone()).unwrap();
    let result = solve(&system);
    let analytic = gradient::energy_gradient(&system, &result);

    let numeric = finite_difference::scalar(&molecule, finite_difference::DEFAULT_STEP, |m| {
        frozen_grid_energy(m, &grid)
    });
    let worst = finite_difference::max_deviation(&analytic, &numeric);
    let scale = finite_difference::max_component(&numeric);
    assert!(
        scale > 1e-3,
        "{name}: the geometry is already relaxed, so there is no force to check"
    );
    assert!(
        worst < 1e-6,
        "{name}: analytic and numeric gradients differ by {worst:.3e} \
         (largest force {scale:.4} Ha/Bohr)\nanalytic {analytic:?}\nnumeric  {numeric:?}"
    );
    worst
}

#[test]
fn distorted_water_restricted() {
    check("H2O singlet", distorted_water(1));
}

/// The same nuclei solved unrestricted. Water is not a triplet, but solving it
/// as one is the cleanest way to put the whole unrestricted path - two densities,
/// two potentials, two sets of orbitals in the energy-weighted matrix - under the
/// same finite-difference microscope as the restricted one.
#[test]
fn distorted_water_unrestricted() {
    check("H2O triplet", distorted_water(3));
}

#[test]
fn distorted_methane_restricted() {
    check("CH4", distorted_methane());
}

#[test]
fn stretched_oxygen_unrestricted() {
    check("O2 triplet", stretched_oxygen());
}

#[test]
fn distorted_methyl_radical_unrestricted() {
    check("CH3 doublet", distorted_methyl());
}

/// Moving every nucleus together cannot change the energy, so the gradient has
/// to sum to zero.
///
/// It is not exact here, and the reason is the same omission: the grid does not
/// translate with the molecule, so the fixed-grid energy is not quite
/// translationally invariant either. What is left is quadrature residue, and it
/// shrinks with the grid - 2.7e-4 on the coarse grid, 5.2e-5 on the medium one,
/// 3.0e-6 on the fine grid the optimiser uses. The optimiser removes what
/// remains before taking a step, which costs nothing because translation is a
/// direction the energy does not depend on.
#[test]
fn the_gradient_has_no_net_force() {
    let molecule = distorted_water(1);
    let system = System::build(molecule, dft_core::opt::OPTIMIZER_GRID).unwrap();
    let result = solve(&system);
    let analytic = gradient::energy_gradient(&system, &result);
    for axis in 0..3 {
        let sum: f64 = analytic.iter().map(|g| g[axis]).sum();
        assert!(sum.abs() < 1e-5, "axis {axis} has a net force of {sum:.3e}");
    }
}

/// What leaving the grid-weight derivatives out actually costs, measured rather
/// than assumed.
///
/// Here the grid is rebuilt for every displaced geometry, which is the energy
/// the application computes, so the gap between the analytic gradient and the
/// difference *is* the omitted term. Measured on distorted water it is
///
/// ```text
/// coarse grid (9 500 points)    4.3e-4 Ha/Bohr
/// medium grid (21 800 points)   7.2e-5 Ha/Bohr
/// fine grid   (44 500 points)   1.2e-5 Ha/Bohr
/// ```
///
/// against the `4.5e-4` at which a structure is called relaxed. On the coarse
/// grid the omission is the whole convergence threshold, which is why the
/// optimiser does not use it; on the fine grid it is a few percent of it, which
/// is the trade the design plan proposed - spend the grid rather than the code.
#[test]
fn the_omitted_grid_weight_derivatives_are_small() {
    let molecule = distorted_water(1);
    // A larger step than the strict test uses: with the grid rebuilt at each
    // geometry the energy carries a little quadrature jitter, and a wider
    // interval averages over it rather than differentiating it.
    let step = 1e-3;

    let mut worst_by_quality = Vec::new();
    for quality in [GridQuality::Medium, dft_core::opt::OPTIMIZER_GRID] {
        let system = System::build(molecule.clone(), quality).unwrap();
        let result = solve(&system);
        let analytic = gradient::energy_gradient(&system, &result);
        let numeric =
            finite_difference::scalar(&molecule, step, |m| moving_grid_energy(m, quality));
        worst_by_quality.push(finite_difference::max_deviation(&analytic, &numeric));
    }

    let fine = worst_by_quality[1];
    assert!(
        fine < 0.1 * 4.5e-4,
        "the grid response is worth {fine:.3e} Ha/Bohr, more than a tenth of the \
         force at which the optimiser stops"
    );
    assert!(
        fine < worst_by_quality[0],
        "refining the grid did not shrink the omitted term ({:.3e} -> {fine:.3e})",
        worst_by_quality[0]
    );
}
