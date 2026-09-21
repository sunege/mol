//! The analytic gradient against PySCF's.
//!
//! `tests/gradients.rs` shows the gradient is the derivative of *this engine's*
//! energy. That is the test that catches implementation bugs, and it would pass
//! just as happily if the energy expression itself were wrong. This one closes
//! the loop from outside: the same geometries, the same functional and basis,
//! differentiated by a completely separate program.
//!
//! PySCF's DFT gradients leave out the grid response by default, which is the
//! same approximation made here, so the two are comparing the same quantity. The
//! grids themselves differ - level 9 there, the fine grid here - and that is
//! what sets the tolerance below.

mod common;

use common::GradientReferences;
use dft_core::gradient::{self, finite_difference};
use dft_core::opt::OPTIMIZER_GRID;
use dft_core::scf::{self, ScfOptions, ScfResult, System};

/// How far the two may differ. Quadrature, not algebra: the engine's fine grid
/// has 45 000 points against PySCF's level 9, and the exchange-correlation
/// gradient is the term that notices. Measured, the worst case is 1.5e-6 for
/// water and 1.2e-5 for methane, against forces of around 0.08 Hartree/Bohr -
/// so this is a few parts in ten thousand, and a twentieth of the force at
/// which the optimiser stops. 6-31G* is no worse: 4.5e-6 for water, 1.2e-5 at
/// most (the methyl radical).
const TOLERANCE: f64 = 2e-5;

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
    assert!(result.converged);
    result
}

#[test]
fn analytic_gradients_match_pyscf() {
    check("gradients.json");
}

#[test]
fn analytic_gradients_match_pyscf_in_631gs() {
    check("gradients_631gs.json");
}

fn check(file: &str) {
    let references: GradientReferences = common::load(file);
    assert!(
        !references.grid_response,
        "{file}: PySCF included the grid response, which the engine does not: the \
         two are no longer computing the same quantity"
    );

    for case in &references.cases {
        let molecule = case.molecule();
        let system = System::build(molecule, references.kind(), OPTIMIZER_GRID).unwrap();
        let result = solve(&system);

        // The energies have to agree first; a gradient comparison on top of a
        // wrong energy says nothing.
        assert!(
            (result.energy - case.energy).abs() < 1e-4,
            "{file}: {}: energy {} against PySCF's {}",
            case.key,
            result.energy,
            case.energy
        );

        let analytic = gradient::energy_gradient(&system, &result);
        let worst = finite_difference::max_deviation(&analytic, &case.gradient);
        let scale = finite_difference::max_component(&case.gradient);
        assert!(
            worst < TOLERANCE,
            "{file}: {}: gradient differs from PySCF by {worst:.3e} (largest \
             component {scale:.4} Ha/Bohr)\nengine {analytic:?}\npyscf  {:?}",
            case.key,
            case.gradient
        );
        assert!(scale > 1e-3, "{file}: {}: the reference gradient is empty", case.key);
    }
}
