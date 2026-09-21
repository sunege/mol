//! Open-shell SVWN5/STO-3G energies against PySCF's UKS.
//!
//! Same three levels as `reference_scf.rs`, which is what makes a failure say
//! where it is: the energy expression evaluated on PySCF's own pair of spin
//! density matrices, then the converged energy, then the orbital energies of
//! each channel. On top of those, `<S^2>` checks that the determinant the
//! engine settled on is the one PySCF settled on, and not some other spin state
//! that happens to have a similar energy.
//!
//! The last test is the one the phase exists for: O2 is a triplet, and nothing
//! about its geometry says so.

mod common;

use common::{load, OpenShellReference, OpenShellReferences};
use dft_core::basis::BasisKind;
use dft_core::driver::DriverOptions;
use dft_core::grid::GridQuality;
use dft_core::scf::{self, ScfOptions, System};

/// Quadrature budget, as in the closed-shell references: the engine's grid is a
/// modest one and PySCF's is essentially converged. The terms that do not touch
/// the grid are checked far more tightly below.
const GRID_TOLERANCE: f64 = 1e-4;

/// Third-row atoms whose 3s and 3p levels sit close enough together that the
/// occupied and empty orbitals swap places from one iteration to the next. No
/// amount of damping fixes that - the oscillation is between two occupations,
/// not two densities - so they need the level shift, which is exactly what the
/// driver escalates to. `a_level_shift_is_what_the_hard_atoms_need` below shows
/// they really do fail without it.
const NEEDS_A_LEVEL_SHIFT: [&str; 2] = ["al_atom", "si_atom"];

fn options_for(key: &str) -> ScfOptions {
    if NEEDS_A_LEVEL_SHIFT.contains(&key) {
        DriverOptions::default().persistent_scf
    } else {
        ScfOptions::default()
    }
}

fn system_of(reference: &OpenShellReference) -> System {
    System::build(reference.molecule(), BasisKind::Sto3g, GridQuality::Medium)
        .expect("basis must cover the molecule")
}

fn run(reference: &OpenShellReference) -> (System, scf::ScfResult) {
    let system = system_of(reference);
    let result = scf::run_unrestricted(&system, &options_for(&reference.key));
    (system, result)
}

#[test]
fn energy_terms_match_at_the_reference_density() {
    let references: OpenShellReferences = load("scf_open_shell.json");
    for reference in references.all() {
        let system = system_of(reference);
        assert_eq!(system.n_functions(), reference.nbf, "{}: basis size", reference.key);

        let alpha = reference.density(0);
        let beta = reference.density(1);
        let (terms, _, _, electrons) =
            scf::energy_and_fock_unrestricted(&system, &alpha, &beta);

        // Pure integral algebra: no grid involved, so these must be tight.
        assert!(
            (terms.core - reference.e_core).abs() < 1e-8,
            "{}: core energy {} vs {}",
            reference.key,
            terms.core,
            reference.e_core
        );
        assert!(
            (terms.coulomb - reference.e_coulomb).abs() < 1e-8,
            "{}: Coulomb energy {} vs {}",
            reference.key,
            terms.coulomb,
            reference.e_coulomb
        );
        assert!(
            (terms.nuclear_repulsion - reference.nuclear_repulsion).abs() < 1e-9,
            "{}: nuclear repulsion",
            reference.key
        );
        // This is the spin-polarised functional assembled over the grid, which
        // is the part that is new in this phase.
        assert!(
            (terms.exchange_correlation - reference.e_xc).abs() < GRID_TOLERANCE,
            "{}: E_xc {} vs {}",
            reference.key,
            terms.exchange_correlation,
            reference.e_xc
        );
        assert!(
            (terms.total() - reference.energy).abs() < GRID_TOLERANCE,
            "{}: total energy {} vs {}",
            reference.key,
            terms.total(),
            reference.energy
        );
        assert!(
            (electrons - reference.n_electrons as f64).abs() < 5e-4,
            "{}: grid integrated {electrons} electrons, expected {}",
            reference.key,
            reference.n_electrons
        );
    }
}

#[test]
fn converges_to_the_reference_energy() {
    let references: OpenShellReferences = load("scf_open_shell.json");
    for reference in references.all() {
        let (_, result) = run(reference);
        assert!(
            result.converged,
            "{}: SCF did not converge in {} iterations",
            reference.key,
            result.iterations
        );
        assert!(
            (result.energy - reference.energy).abs() < GRID_TOLERANCE,
            "{}: converged to {} Ha, reference {} Ha (after {} iterations)",
            reference.key,
            result.energy,
            reference.energy,
            result.iterations
        );
        // The two channels hold the electrons the multiplicity asks for. A
        // triplet that quietly relaxed into a singlet would still have a
        // plausible energy, so this is checked separately from it.
        assert_eq!(result.channels.len(), 2, "{}: two spin channels", reference.key);
        let alpha = result.channels[0].n_electrons();
        let beta = result.channels[1].n_electrons();
        assert!(
            (alpha - reference.n_alpha as f64).abs() < 1e-9
                && (beta - reference.n_beta as f64).abs() < 1e-9,
            "{}: ({alpha}, {beta}) electrons, expected ({}, {})",
            reference.key,
            reference.n_alpha,
            reference.n_beta
        );
    }
}

/// A closed-shell molecule solved unrestricted must land exactly on its
/// restricted answer: with the same number of alpha and beta electrons the two
/// channels never separate, so this is a check that nothing in the unrestricted
/// assembly double-counts.
#[test]
fn a_closed_shell_gives_the_same_energy_either_way() {
    let references: OpenShellReferences = load("scf_open_shell.json");
    let reference = references.get("o2_singlet");
    let system = system_of(reference);
    let restricted = scf::run_restricted(&system, &ScfOptions::default());
    let unrestricted = scf::run_unrestricted(&system, &ScfOptions::default());
    assert!(restricted.converged && unrestricted.converged);
    assert!(
        (restricted.energy - unrestricted.energy).abs() < 1e-7,
        "restricted {} Ha, unrestricted {} Ha",
        restricted.energy,
        unrestricted.energy
    );
    assert!(!restricted.is_unrestricted() && unrestricted.is_unrestricted());
    // And the two spin densities of that unrestricted solution are the same one.
    let spin = unrestricted.spin_density().expect("two channels");
    assert!(spin.amax() < 1e-6, "a closed shell polarised itself by {}", spin.amax());
}

#[test]
fn orbital_energies_match_the_reference() {
    let references: OpenShellReferences = load("scf_open_shell.json");
    // Atoms are left out on purpose: their partly filled p shell is exactly
    // degenerate, so which p orbital ends up occupied - and therefore how the
    // levels split - is arbitrary. The total energy, which is not, is checked
    // for them above.
    for reference in &references.systems {
        let (_, result) = run(reference);
        for (channel, set) in result.channels.iter().enumerate() {
            let expected = &reference.mo_energies[channel];
            assert_eq!(set.energies.len(), expected.len());
            for (i, (&mine, &theirs)) in set.energies.iter().zip(expected).enumerate() {
                assert!(
                    (mine - theirs).abs() < 1e-4,
                    "{}: channel {channel} orbital {i} at {mine} Ha, reference {theirs} Ha",
                    reference.key
                );
            }
        }
    }
}

#[test]
fn spin_squared_matches_the_reference() {
    let references: OpenShellReferences = load("scf_open_shell.json");
    for reference in references.all() {
        let (system, result) = run(reference);
        let mine = result.spin_squared(&system.overlap);
        assert!(
            (mine - reference.spin_squared).abs() < 1e-4,
            "{}: <S^2> = {mine}, reference {}",
            reference.key,
            reference.spin_squared
        );
        // For these systems the unrestricted determinant is close to a proper
        // spin eigenfunction, so it should also be near S(S+1) exactly. The
        // radicals are the furthest off, at 0.753 against 0.75.
        let s = 0.5 * (reference.multiplicity as f64 - 1.0);
        assert!(
            (mine - s * (s + 1.0)).abs() < 0.01,
            "{}: <S^2> = {mine}, exact {}",
            reference.key,
            s * (s + 1.0)
        );
    }
}

/// The shift is not decoration: without it these two do not converge at all, and
/// with it they land on PySCF's answer. If the escalation in the driver were
/// ever dropped, a user placing a single aluminium atom would see a diverging
/// molecule instead of a result.
#[test]
fn a_level_shift_is_what_the_hard_atoms_need() {
    let references: OpenShellReferences = load("scf_open_shell.json");
    for key in NEEDS_A_LEVEL_SHIFT {
        let reference = references.get(key);
        let system = system_of(reference);
        let plain = scf::run_unrestricted(&system, &ScfOptions::default());
        assert!(!plain.converged, "{key} converged without a level shift after all");

        let shifted = scf::run_unrestricted(&system, &options_for(key));
        assert!(shifted.converged, "{key} did not converge even with a level shift");
        assert!(
            (shifted.energy - reference.energy).abs() < GRID_TOLERANCE,
            "{key}: {} Ha, reference {} Ha",
            shifted.energy,
            reference.energy
        );
    }
}

/// The acceptance criterion of this phase, checked against the engine itself
/// rather than only against PySCF: with the same geometry and the same grid, the
/// triplet has to come out below the singlet.
#[test]
fn oxygen_is_a_triplet() {
    let references: OpenShellReferences = load("scf_open_shell.json");
    let triplet_reference = references.get("o2_triplet");
    let singlet_reference = references.get("o2_singlet");

    let triplet = scf::run_unrestricted(&system_of(triplet_reference), &ScfOptions::default());
    let singlet = scf::run_restricted(&system_of(singlet_reference), &ScfOptions::default());
    assert!(triplet.converged && singlet.converged);

    let gap = singlet.energy - triplet.energy;
    let reference_gap = singlet_reference.energy - triplet_reference.energy;
    assert!(gap > 0.0, "the triplet came out {gap} Ha above the singlet");
    assert!(
        (gap - reference_gap).abs() < 2.0 * GRID_TOLERANCE,
        "singlet-triplet gap {gap} Ha, reference {reference_gap} Ha"
    );
    // Two unpaired electrons, so the spin density has to integrate to two of
    // them; `tr(D_spin S)` is that count exactly.
    let system = system_of(triplet_reference);
    let spin = triplet.spin_density().expect("two channels");
    let unpaired = spin.component_mul(&system.overlap).sum();
    assert!((unpaired - 2.0).abs() < 1e-8, "{unpaired} unpaired electrons");
}
