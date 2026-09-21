//! SVWN5 energies against PySCF, in both of the engine's bases.
//!
//! Three levels of check, deliberately separated so a failure localises itself:
//!
//! 1. the energy expression evaluated on PySCF's *converged density matrix*,
//!    term by term - this tests the functional, the integrals and the grid with
//!    the SCF taken out of the picture;
//! 2. the converged total energy, which additionally tests the loop;
//! 3. the orbital energies, which test the Kohn-Sham matrix rather than just the
//!    energy it produces.

mod common;

use common::{load, AtomicReferences, ScfReference};
use dft_core::grid::GridQuality;
use dft_core::molecule::{Atom, Molecule};
use dft_core::scf::{self, Occupation, ScfOptions, System};
use nalgebra::DMatrix;

/// Molecules with a reference density matrix: STO-3G smallest first, then
/// 6-31G*. Each file names its basis, and the engine solves in that one.
const WITH_DENSITY: [&str; 9] = [
    "scf_h2.json",
    "scf_h2o.json",
    "scf_ch4.json",
    "scf_nh3.json",
    "scf_h2s.json",
    "scf_co2.json",
    "scf_h2o_631gs.json",
    "scf_ch4_631gs.json",
    "scf_nh3_631gs.json",
];

/// How far the engine's own grid may sit from PySCF's essentially converged one
/// (level 9, where PySCF's own level-3 answer is already within 3e-7).
///
/// This is purely a statement about quadrature: the terms that do not involve the
/// grid are checked at 1e-8 below, and `finer_grids_converge_towards_the_reference`
/// shows the remaining gap shrinking as the grid is refined. The largest error at
/// the default quality is 5e-5 Hartree, on H2S (in 6-31G*, 1.7e-5 on CH4).
const GRID_TOLERANCE: f64 = 1e-4;

fn system_of(reference: &ScfReference) -> System {
    let system = System::build(reference.molecule(), reference.kind(), GridQuality::Medium)
        .expect("basis must cover the molecule");
    // Six Cartesian d functions against five spherical ones: a 6-31G* reference
    // made without `cart=True` is for a different basis, and this is where that
    // shows.
    assert_eq!(system.n_functions(), reference.nbf, "{}: basis size", reference.molecule);
    system
}

#[test]
fn energy_terms_match_at_the_reference_density() {
    for file in WITH_DENSITY {
        let reference: ScfReference = load(file);
        let system = system_of(&reference);
        let n = reference.nbf;

        let flat = reference.density_matrix.as_ref().expect("reference density");
        let density = DMatrix::from_row_slice(n, n, flat);
        let (terms, _, electrons) = scf::energy_and_fock(&system, &density);

        // The one-electron and Coulomb terms are pure integral algebra: they must
        // agree far more tightly than the grid-dependent one.
        assert!(
            (terms.core - reference.e_core).abs() < 1e-8,
            "{file}: core energy {} vs {}",
            terms.core,
            reference.e_core
        );
        assert!(
            (terms.coulomb - reference.e_coulomb).abs() < 1e-8,
            "{file}: Coulomb energy {} vs {}",
            terms.coulomb,
            reference.e_coulomb
        );
        assert!(
            (terms.nuclear_repulsion - reference.nuclear_repulsion).abs() < 1e-9,
            "{file}: nuclear repulsion"
        );
        assert!(
            (terms.exchange_correlation - reference.e_xc).abs() < GRID_TOLERANCE,
            "{file}: E_xc {} vs {}",
            terms.exchange_correlation,
            reference.e_xc
        );
        assert!(
            (terms.total() - reference.energy).abs() < GRID_TOLERANCE,
            "{file}: total energy {} vs {}",
            terms.total(),
            reference.energy
        );
        // The grid must also account for every electron. The largest shortfall at
        // the default quality is 1.7e-4 of an electron, on H2S.
        assert!(
            (electrons - reference.n_electrons as f64).abs() < 5e-4,
            "{file}: grid integrated {electrons} electrons, expected {}",
            reference.n_electrons
        );
    }
}

#[test]
fn converges_to_the_reference_energy() {
    for file in WITH_DENSITY {
        let reference: ScfReference = load(file);
        let system = system_of(&reference);
        let result = scf::run_restricted(&system, &ScfOptions::default());
        assert!(result.converged, "{file}: SCF did not converge");
        assert!(
            (result.energy - reference.energy).abs() < GRID_TOLERANCE,
            "{file}: converged to {} Ha, reference {} Ha (after {} iterations)",
            result.energy,
            reference.energy,
            result.iterations
        );
        // A variational method reached from a different starting point should not
        // need anything like the iteration limit.
        assert!(result.iterations < 40, "{file}: took {} iterations", result.iterations);
    }
}

#[test]
fn orbital_energies_match_the_reference() {
    for file in WITH_DENSITY {
        let reference: ScfReference = load(file);
        let system = system_of(&reference);
        let result = scf::run_restricted(&system, &ScfOptions::default());
        assert!(result.converged, "{file}: SCF did not converge");
        // A restricted calculation has the one set of orbitals, standing for
        // both spins.
        assert_eq!(result.channels.len(), 1);
        let energies = &result.channels[0].energies;
        assert_eq!(energies.len(), reference.mo_energies.len());
        for (i, (&mine, &theirs)) in energies.iter().zip(&reference.mo_energies).enumerate() {
            assert!(
                (mine - theirs).abs() < 1e-4,
                "{file}: orbital {i} at {mine} Ha, reference {theirs} Ha"
            );
        }
        let (homo, _) = result.homo_lumo().expect("a closed shell has both");
        assert!((homo - reference.homo).abs() < 1e-4, "{file}: HOMO");
    }
}

/// Closed-shell atoms are the one case where the spherically averaged atomic
/// solver behind the SAD guess must reproduce an ordinary restricted calculation
/// exactly, so it is checked against PySCF directly.
#[test]
fn closed_shell_atoms_match_the_reference() {
    for file in ["scf_atoms.json", "scf_atoms_631gs.json"] {
        let references: AtomicReferences = load(file);
        for atom in &references.atoms {
            let molecule = Molecule::new(vec![Atom { z: atom.z, pos: [0.0; 3] }]).unwrap();
            let system = System::build(molecule, references.kind(), GridQuality::Fine).unwrap();
            assert_eq!(system.n_functions(), atom.nbf, "{file}: {}: basis size", atom.symbol);
            let options =
                ScfOptions { occupation: Occupation::SphericalAverage, ..ScfOptions::default() };
            let result = scf::run_restricted(&system, &options);
            assert!(result.converged, "{file}: {}: SCF did not converge", atom.symbol);
            assert!(
                (result.energy - atom.energy).abs() < GRID_TOLERANCE,
                "{file}: {}: {} Ha, reference {} Ha",
                atom.symbol,
                result.energy,
                atom.energy
            );
        }
    }
}

/// Proof that the gap to the reference is quadrature error rather than a bug: it
/// has to shrink when the grid is refined, and it does so for every system.
#[test]
fn finer_grids_converge_towards_the_reference() {
    for file in WITH_DENSITY {
        let reference: ScfReference = load(file);
        let n = reference.nbf;
        let flat = reference.density_matrix.as_ref().expect("reference density");
        let density = DMatrix::from_row_slice(n, n, flat);
        let error = |quality: GridQuality| {
            let system = System::build(reference.molecule(), reference.kind(), quality).unwrap();
            let (terms, _, _) = scf::energy_and_fock(&system, &density);
            (terms.total() - reference.energy).abs()
        };
        let coarse = error(GridQuality::Coarse);
        let medium = error(GridQuality::Medium);
        let fine = error(GridQuality::Fine);
        // H2 is converged to 1e-10 even on the coarse grid, so refining it only
        // moves noise; the floor keeps that from reading as a regression.
        let floor = 1e-8;
        assert!(
            medium < coarse.max(floor),
            "{file}: medium {medium:e} did not improve on {coarse:e}"
        );
        assert!(fine < medium.max(floor), "{file}: fine {fine:e} did not improve on {medium:e}");
        // The closest to this is CH4 in 6-31G*, at 6.7e-6.
        assert!(fine < 1e-5, "{file}: fine grid error {fine:e} is too large");
    }
}

/// The performance target of the project is benzene in seconds, so the largest
/// reference system gets its own check that the answer is right at that size.
#[test]
fn benzene_matches_the_reference() {
    let reference: ScfReference = load("scf_benzene.json");
    assert_eq!(reference.nbf, 36);
    let system = system_of(&reference);
    let result = scf::run_restricted(&system, &ScfOptions::default());
    assert!(result.converged, "benzene did not converge in {} iterations", result.iterations);
    assert!(
        (result.energy - reference.energy).abs() < GRID_TOLERANCE,
        "benzene converged to {} Ha, reference {} Ha",
        result.energy,
        reference.energy
    );
}
