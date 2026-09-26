//! Ions: SVWN5/STO-3G energies of charged molecules and free ions against
//! PySCF (`scf_ions.json`), and what the charge placed on each atom does and
//! does not change.
//!
//! The per-atom split is the application's, not PySCF's - PySCF knows only the
//! total - so it is checked from inside the engine by routes that do not need a
//! reference: the electron count `tr(D S)`, and the same molecule placed two
//! ways giving the same SCF.

mod common;

use common::{load, OpenShellReference, OpenShellReferences};
use dft_core::basis::BasisKind;
use dft_core::bonding::{channel_density, DensityChannel};
use dft_core::driver::{self, DriverOptions};
use dft_core::grid::GridQuality;
use dft_core::molecule::Molecule;
use dft_core::opt::{self, bond_angle, bond_length, Options, Status, OPTIMIZER_GRID};
use dft_core::scf::{self, guess, Occupation, ScfOptions, ScfResult, System};
use nalgebra::DMatrix;

/// Quadrature budget, as in the neutral references.
const GRID_TOLERANCE: f64 = 1e-4;
/// Bohr and degrees: the tolerances of `optimize.rs`.
const BOND_TOLERANCE: f64 = 5e-3;
const ANGLE_TOLERANCE: f64 = 0.5;

fn references() -> OpenShellReferences {
    load("scf_ions.json")
}

/// `tr(D S)`: the number of electrons a density matrix describes.
fn electron_count(density: &DMatrix<f64>, system: &System) -> f64 {
    density.component_mul(&system.overlap).sum()
}

fn solve(reference: &OpenShellReference, molecule: Molecule) -> (System, ScfResult) {
    let system = System::build(molecule, BasisKind::Sto3g, GridQuality::Medium).unwrap();
    let result = if reference.unrestricted {
        scf::run_unrestricted(&system, &ScfOptions::default())
    } else {
        scf::run_restricted(&system, &ScfOptions::default())
    };
    (system, result)
}

#[test]
fn charged_molecules_converge_to_the_reference_energy() {
    let references = references();
    for reference in &references.systems {
        let (system, result) = solve(reference, reference.molecule());
        assert_eq!(system.n_functions(), reference.nbf, "{}: basis size", reference.key);
        assert!(result.converged, "{}: SCF did not converge", reference.key);
        assert!(
            (result.energy - reference.energy).abs() < GRID_TOLERANCE,
            "{}: {} Ha, reference {} Ha",
            reference.key,
            result.energy,
            reference.energy
        );
        assert!(
            (electron_count(&result.density, &system) - reference.n_electrons as f64).abs()
                < 1e-8,
            "{}: the density holds the wrong number of electrons",
            reference.key
        );
    }
}

/// The free ions, solved as the atoms of `reference_scf.rs` are: spherically
/// averaged, on the fine grid.
#[test]
fn free_ions_match_the_reference() {
    let references = references();
    for reference in &references.atoms {
        let system = System::build(reference.molecule(), BasisKind::Sto3g, GridQuality::Fine)
            .unwrap();
        let options =
            ScfOptions { occupation: Occupation::SphericalAverage, ..ScfOptions::default() };
        let result = scf::run_restricted(&system, &options);
        assert!(result.converged, "{}: SCF did not converge", reference.key);
        assert!(
            (result.energy - reference.energy).abs() < GRID_TOLERANCE,
            "{}: {} Ha, reference {} Ha",
            reference.key,
            result.energy,
            reference.energy
        );
    }
}

/// H3O+ placed as water and a proton, and as O+ with three hydrogen atoms: the
/// same nuclei and the same total, so the same SCF - the same one exactly,
/// since even the starting density knows only the total. What differs is what
/// the molecule is compared with: the free atoms the "moved electrons" surface
/// is drawn against.
#[test]
fn where_the_charge_sits_changes_the_reference_atoms_and_nothing_else() {
    let references = references();
    let reference = references.get("h3o_plus");
    let with_a_proton = reference.molecule_with(vec![0, 0, 0, 1]);
    let with_an_oxygen_cation = reference.molecule_with(vec![1, 0, 0, 0]);

    let (proton_system, proton) = solve(reference, with_a_proton);
    let (oxygen_system, oxygen) = solve(reference, with_an_oxygen_cation);
    assert!(proton.converged && oxygen.converged);
    assert!(
        (proton.energy - reference.energy).abs() < GRID_TOLERANCE,
        "{} Ha, reference {} Ha",
        proton.energy,
        reference.energy
    );
    assert!(
        (proton.energy - oxygen.energy).abs() < 1e-8,
        "{} Ha against {} Ha",
        proton.energy,
        oxygen.energy
    );
    assert_eq!(proton.density, oxygen.density);

    let deformation = |system: &System, result: &ScfResult| {
        channel_density(system, result, &DensityChannel::Deformation)
    };
    let moved_with_a_proton = deformation(&proton_system, &proton);
    let moved_with_an_oxygen_cation = deformation(&oxygen_system, &oxygen);
    // Both reference sets hold the molecule's ten electrons, so neither
    // difference creates or destroys any.
    for moved in [&moved_with_a_proton, &moved_with_an_oxygen_cation] {
        let net = electron_count(moved, &proton_system);
        assert!(net.abs() < 1e-8, "the deformation density carries {net} electrons");
    }
    // But they are different pictures: against a bare proton, the proton's
    // block gains about an electron; against a hydrogen atom it loses some.
    let proton_block = proton_system.basis.atom_range(3);
    let on_the_proton = |moved: &DMatrix<f64>| {
        let at = (proton_block.start, proton_block.start);
        let size = (proton_block.len(), proton_block.len());
        (moved.view(at, size) * proton_system.overlap.view(at, size)).trace()
    };
    let gained = on_the_proton(&moved_with_a_proton);
    let lost = on_the_proton(&moved_with_an_oxygen_cation);
    assert!(gained > 0.3, "the bare proton gained only {gained} electrons");
    assert!(lost < 0.0, "a neutral hydrogen gained {lost} electrons");
    assert!((gained - lost - 1.0).abs() < 1e-8, "the two references differ by one electron");
}

/// The charge is solved as placed: the driver searches the spin, never the
/// charge, and every state it tries carries the molecule's.
#[test]
fn the_driver_solves_the_charge_it_was_given() {
    let references = references();
    for (key, charges) in
        [("h3o_plus", vec![0, 0, 0, 1]), ("oh_minus", vec![-1, 0]), ("h2_plus", vec![1, 0])]
    {
        let reference = references.get(key);
        let molecule = reference.molecule_with(charges);
        let mut system = System::build(molecule, BasisKind::Sto3g, GridQuality::Medium).unwrap();
        let outcome = driver::solve(&mut system, &DriverOptions::default(), &mut || true);
        assert!(outcome.converged(), "{key}");
        assert_eq!(outcome.state.charge, reference.charge, "{key}");
        assert_eq!(outcome.state.multiplicity, reference.multiplicity, "{key}");
        assert!(outcome.attempts.iter().all(|a| a.state.charge == reference.charge), "{key}");
        assert_eq!(system.molecule.charge, reference.charge, "{key}");
        assert!(
            (outcome.result.energy - reference.energy).abs() < GRID_TOLERANCE,
            "{key}: {} Ha, reference {} Ha",
            outcome.result.energy,
            reference.energy
        );
    }
}

/// Where the SCF starts and what the deformation is taken against both hold the
/// molecule's electrons. Checked here on the references' own geometries; the
/// unit tests in `scf/guess.rs` check the reference atom by atom.
#[test]
fn the_guess_of_a_charged_molecule_holds_its_electrons() {
    let references = references();
    for (key, charges) in [
        ("h3o_plus", vec![0, 0, 0, 1]),
        ("nh4_plus", vec![0, 0, 0, 0, 1]),
        ("oh_minus", vec![-1, 0]),
        ("heh_plus", vec![0, 1]),
    ] {
        let reference = references.get(key);
        let molecule = reference.molecule_with(charges);
        let system = System::build(molecule, BasisKind::Sto3g, GridQuality::Coarse).unwrap();
        for density in [
            guess::starting_density(&system),
            guess::superposition_of_atomic_densities(&system),
        ] {
            let electrons = electron_count(&density, &system);
            assert!(
                (electrons - reference.n_electrons as f64).abs() < 1e-8,
                "{key}: a superposition holds {electrons} electrons, not {}",
                reference.n_electrons
            );
        }
    }
}

fn relax(molecule: Molecule) -> opt::Relaxation {
    let system = System::build(molecule, BasisKind::Sto3g, OPTIMIZER_GRID).unwrap();
    opt::relax(system, &Options::default(), None, &mut |_| true, &mut |_| {})
}

/// Water and a proton placed off to one side: the proton binds, and what
/// comes out is a trigonal pyramid - three equal O-H bonds, three equal
/// angles, and not flat.
#[test]
fn hydronium_relaxes_to_a_trigonal_pyramid() {
    let start = Molecule::from_angstrom(&[
        (8, [0.0, 0.0, 0.1]),
        (1, [0.0, 0.78, -0.45]),
        (1, [0.0, -0.78, -0.45]),
        (1, [0.95, 0.1, 0.45]),
    ])
    .and_then(|molecule| molecule.with_atom_charges(vec![0, 0, 0, 1]))
    .unwrap();
    let relaxation = relax(start);
    assert_eq!(relaxation.status, Status::Converged, "{} steps", relaxation.steps);
    let relaxed = &relaxation.system.molecule;
    assert_eq!(relaxed.atom_charges, vec![0, 0, 0, 1], "the charges travel with the atoms");

    let bonds: Vec<f64> = (1..4).map(|h| bond_length(relaxed, 0, h)).collect();
    let angles = [(1, 2), (2, 3), (3, 1)].map(|(a, b)| bond_angle(relaxed, a, 0, b));
    for pair in [(0, 1), (1, 2), (2, 0)] {
        assert!((bonds[pair.0] - bonds[pair.1]).abs() < BOND_TOLERANCE, "O-H {bonds:?} Bohr");
        assert!((angles[pair.0] - angles[pair.1]).abs() < ANGLE_TOLERANCE, "{angles:?} degrees");
    }
    // Three angles in a plane add up to a full turn; a pyramid's fall short.
    let sum: f64 = angles.iter().sum();
    assert!(sum < 350.0, "H3O+ came out flat: the angles add up to {sum} degrees");
}

/// Ammonia and a proton: four equal N-H bonds and six equal angles, which is a
/// regular tetrahedron.
#[test]
fn ammonium_relaxes_to_four_equal_bonds() {
    let start = Molecule::from_angstrom(&[
        (7, [0.0, 0.0, 0.0]),
        (1, [0.0, 0.95, -0.35]),
        (1, [0.82, -0.47, -0.35]),
        (1, [-0.82, -0.47, -0.35]),
        (1, [0.1, -0.05, 1.1]),
    ])
    .and_then(|molecule| molecule.with_atom_charges(vec![0, 0, 0, 0, 1]))
    .unwrap();
    let relaxation = relax(start);
    assert_eq!(relaxation.status, Status::Converged, "{} steps", relaxation.steps);
    let relaxed = &relaxation.system.molecule;

    let bonds: Vec<f64> = (1..5).map(|h| bond_length(relaxed, 0, h)).collect();
    for &bond in &bonds {
        assert!((bond - bonds[0]).abs() < BOND_TOLERANCE, "N-H {bonds:?} Bohr");
    }
    let mut angles = Vec::new();
    for a in 1..5 {
        for b in (a + 1)..5 {
            angles.push(bond_angle(relaxed, a, 0, b));
        }
    }
    for &angle in &angles {
        assert!((angle - angles[0]).abs() < ANGLE_TOLERANCE, "{angles:?} degrees");
    }
}
