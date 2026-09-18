//! Geometry optimisation: does it stop, does it stop in the right place, and
//! does it produce something to watch on the way.
//!
//! "The right place" is decided from outside the engine. `gradients.json` holds
//! structures relaxed by scipy's BFGS over PySCF energies and gradients - a
//! different minimiser over a different program - so agreeing with it means two
//! independent routes found the same minimum, not that this one is
//! self-consistent.

mod common;

use common::GradientReferences;
use dft_core::molecule::{Atom, Molecule};
use dft_core::opt::{self, bond_angle, bond_length, Options, Status, OPTIMIZER_GRID};
use dft_core::scf::System;

/// Bohr. The two optimisers stop on the same force threshold but not at
/// identical points, and the grids differ; a thousandth of a Bohr is half a
/// thousandth of an Angstrom, which is far below anything the picture shows.
const BOND_TOLERANCE: f64 = 5e-3;
/// Degrees, for the same reason.
const ANGLE_TOLERANCE: f64 = 0.5;

/// Relaxes a molecule, collecting the geometries it emitted.
fn relax(molecule: Molecule) -> (opt::Relaxation, Vec<Vec<f64>>) {
    let system = System::build(molecule, OPTIMIZER_GRID).unwrap();
    let mut trajectory = Vec::new();
    let relaxation = opt::relax(system, &Options::default(), None, &mut |step| {
        trajectory.push(step.positions.to_vec());
        true
    });
    (relaxation, trajectory)
}

fn water_reference() -> Molecule {
    let references: GradientReferences = common::load("gradients.json");
    references.relaxed("h2o").starting_molecule(&[8, 1, 1])
}

#[test]
fn water_relaxes_to_the_structure_pyscf_finds() {
    let references: GradientReferences = common::load("gradients.json");
    let reference = references.relaxed("h2o");
    let (relaxation, trajectory) = relax(reference.starting_molecule(&[8, 1, 1]));

    assert_eq!(relaxation.status, Status::Converged, "{} steps", relaxation.steps);
    assert!(
        relaxation.max_force < Options::default().max_force,
        "stopped with a force of {:.3e}",
        relaxation.max_force
    );

    let relaxed = &relaxation.system.molecule;
    for (i, &expected) in reference.bonds_from_first_atom.iter().enumerate() {
        let got = bond_length(relaxed, 0, i + 1);
        assert!(
            (got - expected).abs() < BOND_TOLERANCE,
            "O-H {} came out at {got:.5} Bohr against PySCF's {expected:.5}",
            i + 1
        );
    }
    let angle = bond_angle(relaxed, 1, 0, 2);
    assert!(
        (angle - reference.angle_1_0_2).abs() < ANGLE_TOLERANCE,
        "H-O-H came out at {angle:.3} degrees against PySCF's {:.3}",
        reference.angle_1_0_2
    );
    assert!(
        (relaxation.energy() - reference.energy).abs() < 1e-4,
        "energy {} against PySCF's {}",
        relaxation.energy(),
        reference.energy
    );

    // And there is something to watch: the starting structure plus at least a
    // few moves. One frame would be a correct answer and a blank animation.
    assert!(trajectory.len() >= 3, "only {} frames", trajectory.len());
    assert_eq!(trajectory.len(), relaxation.steps + 1);
}

#[test]
fn methane_relaxes_to_the_structure_pyscf_finds() {
    let references: GradientReferences = common::load("gradients.json");
    let reference = references.relaxed("ch4");
    let (relaxation, _) = relax(reference.starting_molecule(&[6, 1, 1, 1, 1]));

    assert_eq!(relaxation.status, Status::Converged);
    let relaxed = &relaxation.system.molecule;
    for (i, &expected) in reference.bonds_from_first_atom.iter().enumerate() {
        let got = bond_length(relaxed, 0, i + 1);
        assert!(
            (got - expected).abs() < BOND_TOLERANCE,
            "C-H {} came out at {got:.5} Bohr against PySCF's {expected:.5}",
            i + 1
        );
    }
    assert!(
        (bond_angle(relaxed, 1, 0, 2) - reference.angle_1_0_2).abs() < ANGLE_TOLERANCE,
        "the tetrahedron came out distorted"
    );
}

/// A badly distorted start has to reach the same minimum as a good one. This is
/// the case the application actually meets: a user drops three atoms roughly
/// where they think they go.
#[test]
fn a_distorted_start_reaches_the_same_minimum() {
    let references: GradientReferences = common::load("gradients.json");
    let reference = references.relaxed("h2o");
    let distorted = Molecule::from_angstrom(&[
        (8, [0.03, -0.11, 0.17]),
        (1, [0.21, 0.88, -0.31]),
        (1, [-0.05, -0.62, -0.83]),
    ])
    .unwrap();
    let (relaxation, trajectory) = relax(distorted);

    assert_eq!(relaxation.status, Status::Converged, "{} steps", relaxation.steps);
    let relaxed = &relaxation.system.molecule;
    for i in 1..=2 {
        let got = bond_length(relaxed, 0, i);
        let expected = reference.bonds_from_first_atom[i - 1];
        assert!(
            (got - expected).abs() < BOND_TOLERANCE,
            "O-H {i} came out at {got:.5} Bohr against PySCF's {expected:.5}"
        );
    }
    assert!((bond_angle(relaxed, 1, 0, 2) - reference.angle_1_0_2).abs() < ANGLE_TOLERANCE);
    // The two O-H bonds started 0.008 Bohr apart and have to end up equal: the
    // minimum is symmetric even though nothing on the way there was.
    assert!(
        (bond_length(relaxed, 0, 1) - bond_length(relaxed, 0, 2)).abs() < 1e-3,
        "the relaxed structure is not symmetric"
    );
    assert!(trajectory.len() >= 4, "only {} frames to animate", trajectory.len());
}

/// Every accepted step goes downhill. The optimiser rejects and shortens a step
/// that does not, so this is a statement about what reaches the animation: the
/// molecule never visibly backs out of a move it has already made.
#[test]
fn accepted_steps_only_ever_lower_the_energy() {
    let system = System::build(water_reference(), OPTIMIZER_GRID).unwrap();
    let mut energies = Vec::new();
    let relaxation = opt::relax(system, &Options::default(), None, &mut |step| {
        energies.push(step.energy);
        true
    });
    assert_eq!(relaxation.status, Status::Converged);
    for pair in energies.windows(2) {
        assert!(
            pair[1] <= pair[0] + 1e-7,
            "the energy rose from {} to {}",
            pair[0],
            pair[1]
        );
    }
    assert!(
        energies.last().unwrap() < &(energies[0] - 1e-6),
        "nothing was gained by relaxing"
    );
}

/// Stopping the caller's way: the callback returns false and the relaxation ends
/// where it is, with the structure it has. This is how the worker imposes a
/// wall-clock budget.
#[test]
fn the_callback_can_stop_it() {
    let system = System::build(water_reference(), OPTIMIZER_GRID).unwrap();
    let mut seen = 0;
    let relaxation = opt::relax(system, &Options::default(), None, &mut |_| {
        seen += 1;
        seen < 2
    });
    assert_eq!(relaxation.status, Status::Interrupted);
    assert_eq!(seen, 2);
    // Interrupted or not, there is a converged calculation to draw.
    assert!(relaxation.result.converged);
}

/// Running out of steps is a value, not an error (requirement F5): the caller
/// gets a status it can turn into an animation.
#[test]
fn running_out_of_steps_is_reported_rather_than_thrown() {
    let distorted = Molecule::from_angstrom(&[
        (8, [0.0, 0.0, 0.0]),
        (1, [0.0, 0.0, 1.6]),
        (1, [1.5, 0.0, -0.4]),
    ])
    .unwrap();
    let system = System::build(distorted, OPTIMIZER_GRID).unwrap();
    let options = Options { max_steps: 2, ..Options::default() };
    let relaxation = opt::relax(system, &options, None, &mut |_| true);
    assert_eq!(relaxation.status, Status::MaxSteps);
    assert_eq!(relaxation.steps, 2);
}

/// The one outcome that is a failure of the molecule rather than of the clock.
///
/// A starting calculation that never converged means there is no bound
/// arrangement of electrons for these nuclei, so there is nothing to walk
/// downhill from and nothing moves. It is the only status the interface turns
/// into the molecule coming apart; running out of steps or out of time keeps the
/// structure it reached instead.
#[test]
fn an_unsolved_starting_point_stops_before_moving_anything() {
    let system = System::build(water_reference(), OPTIMIZER_GRID).unwrap();
    // One iteration can converge nothing, so the calculation handed in is the
    // shape of a failed SCF.
    let hopeless = dft_core::scf::ScfOptions {
        max_iterations: 1,
        ..dft_core::scf::ScfOptions::default()
    };
    let start = dft_core::scf::run_restricted(&system, &hopeless);
    assert!(!start.converged, "this test needs an SCF that did not converge");

    let before = system.molecule.clone();
    let mut emitted = 0;
    let relaxation = opt::relax(system, &Options::default(), Some(start), &mut |_| {
        emitted += 1;
        true
    });
    assert_eq!(relaxation.status, opt::Status::ScfFailed);
    assert_eq!(relaxation.steps, 0);
    assert_eq!(emitted, 0, "a structure with no electrons has no frames to show");
    // The geometry is untouched, so the caller still has what the user built.
    assert_eq!(relaxation.system.molecule, before);
}

/// Oxygen: the open-shell case, and the one the spin search exists for. The
/// multiplicity chosen before the first step has to survive to the last one.
#[test]
fn oxygen_relaxes_as_a_triplet_throughout() {
    let mut stretched = Molecule::new(vec![
        Atom { z: 8, pos: [0.0, 0.0, 0.0] },
        Atom { z: 8, pos: [0.0, 0.0, 2.9] },
    ])
    .unwrap();
    stretched.multiplicity = 3;
    let start = bond_length(&stretched, 0, 1);

    let system = System::build(stretched, OPTIMIZER_GRID).unwrap();
    let relaxation = opt::relax(system, &Options::default(), None, &mut |_| true);

    assert_eq!(relaxation.status, Status::Converged, "{} steps", relaxation.steps);
    assert!(relaxation.result.is_unrestricted(), "the triplet was solved restricted");
    assert_eq!(relaxation.system.molecule.multiplicity, 3);
    let relaxed = bond_length(&relaxation.system.molecule, 0, 1);
    assert!(relaxed < start, "the stretched bond did not contract: {relaxed:.4} Bohr");
    // Two atoms have nowhere to go but towards or away from each other, so the
    // relaxed bond is the whole answer, and it has to be a bond rather than two
    // separated atoms.
    assert!(relaxed > 1.5 && relaxed < 3.0, "O-O came out at {relaxed:.4} Bohr");
}

/// A structure that is already relaxed stops at once rather than wandering.
#[test]
fn an_already_relaxed_structure_converges_immediately() {
    let references: GradientReferences = common::load("gradients.json");
    let reference = references.relaxed("h2o");
    let atoms = (0..3)
        .map(|i| Atom {
            z: if i == 0 { 8 } else { 1 },
            pos: [
                reference.coords[3 * i],
                reference.coords[3 * i + 1],
                reference.coords[3 * i + 2],
            ],
        })
        .collect();
    let system = System::build(Molecule::new(atoms).unwrap(), OPTIMIZER_GRID).unwrap();
    let relaxation = opt::relax(system, &Options::default(), None, &mut |_| true);
    assert_eq!(relaxation.status, Status::Converged);
    assert_eq!(relaxation.steps, 0, "a relaxed structure was moved anyway");
}
