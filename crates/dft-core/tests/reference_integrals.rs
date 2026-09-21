//! Integral matrices against PySCF/libcint.
//!
//! The reference files are produced by `scripts/gen_reference.py` and are already
//! in the engine's normalisation convention (every Cartesian function has unit
//! self-overlap), so the comparison is element for element with no fix-ups.

mod common;

use common::{load, IntegralReference};
use dft_core::basis::{BasisKind, BasisSet};
use dft_core::integrals::{self, eri};

/// Absolute tolerance. Both sides evaluate the same closed-form expressions in
/// double precision, so agreement should be near machine precision; anything
/// looser than this would hide a real error.
const TOLERANCE: f64 = 1e-11;

fn check_one_electron(file: &str) {
    let reference: IntegralReference = load(file);
    let basis = reference.basis();
    assert_eq!(basis.n_functions(), reference.nbf, "{file}: basis size");

    let molecule = reference.molecule();
    let (overlap, kinetic) = integrals::overlap_and_kinetic(&basis);
    let nuclear = integrals::nuclear_attraction(&basis, &molecule);

    for i in 0..reference.nbf {
        for j in 0..reference.nbf {
            for (name, mine, theirs) in [
                ("overlap", overlap[(i, j)], reference.at(&reference.overlap, i, j)),
                ("kinetic", kinetic[(i, j)], reference.at(&reference.kinetic, i, j)),
                ("nuclear", nuclear[(i, j)], reference.at(&reference.nuclear, i, j)),
            ] {
                assert!(
                    (mine - theirs).abs() < TOLERANCE,
                    "{file}: {name}[{i},{j}] = {mine}, reference {theirs} \
                     ({}, {})",
                    reference.ao_labels[i],
                    reference.ao_labels[j]
                );
            }
        }
    }

    assert!(
        (molecule.nuclear_repulsion() - reference.nuclear_repulsion).abs() < 1e-10,
        "{file}: nuclear repulsion"
    );
}

fn check_two_electron(file: &str) {
    let reference: IntegralReference = load(file);
    let basis = reference.basis();
    let tensor = eri::compute(&basis);
    let n = reference.nbf;

    if let Some(full) = &reference.eri_full {
        for i in 0..n {
            for j in 0..n {
                for k in 0..n {
                    for l in 0..n {
                        let theirs = full[((i * n + j) * n + k) * n + l];
                        let mine = tensor.get(i, j, k, l);
                        assert!(
                            (mine - theirs).abs() < TOLERANCE,
                            "{file}: ({i} {j}|{k} {l}) = {mine}, reference {theirs}"
                        );
                    }
                }
            }
        }
    }

    for sample in &reference.eri_samples {
        let [i, j, k, l] = sample.idx;
        let mine = tensor.get(i, j, k, l);
        assert!(
            (mine - sample.value).abs() < TOLERANCE,
            "{file}: ({i} {j}|{k} {l}) = {mine}, reference {}",
            sample.value
        );
    }
}

#[test]
fn one_electron_integrals_match_pyscf() {
    for file in [
        "integrals_h2_sto3g.json",
        "integrals_h2o_sto3g.json",
        "integrals_h2s_sto3g.json",
        "integrals_co2_sto3g.json",
    ] {
        check_one_electron(file);
    }
}

#[test]
fn two_electron_integrals_match_pyscf() {
    for file in [
        "integrals_h2_sto3g.json",
        "integrals_h2o_sto3g.json",
        "integrals_h2s_sto3g.json",
        "integrals_co2_sto3g.json",
    ] {
        check_two_electron(file);
    }
}

/// The McMurchie-Davidson code is written for arbitrary angular momentum, which
/// is why 6-31G* needed a table and no new integral kernels. This is the check
/// on its d shells.
#[test]
fn d_functions_are_handled() {
    let file = "integrals_h2o_631gs.json";
    let reference: IntegralReference = load(file);
    assert!(
        reference.shells.iter().any(|s| s.l == 2),
        "{file} was expected to contain d shells"
    );
    check_one_electron(file);
    check_two_electron(file);
}

/// Closes the loop on a generated basis table and on shell ordering: the
/// engine's own basis must be the same shells, in the same order, that PySCF
/// used to produce the reference matrices.
fn check_table(kind: BasisKind, file: &str) {
    let reference: IntegralReference = load(file);
    let basis = BasisSet::build(kind, &reference.molecule()).unwrap();
    // The reference's shells through the same constructor. PySCF writes out its
    // coefficients after renormalising each contraction, the table holds the
    // published ones; `Shell::new` normalises both, so what is compared is the
    // normalised contraction.
    let from_reference = reference.basis();
    assert_eq!(basis.n_shells(), reference.shells.len(), "{file}: shell count");
    for (s, (mine, theirs)) in basis.shells.iter().zip(&reference.shells).enumerate() {
        assert_eq!(mine.center, theirs.center, "{file}: shell {s} centre");
        assert_eq!(mine.l, theirs.l, "{file}: shell {s} angular momentum");
        assert_eq!(mine.exponents.len(), theirs.exponents.len(), "{file}: shell {s} primitives");
        for (a, b) in mine.exponents.iter().zip(&theirs.exponents) {
            assert!((a - b).abs() < 1e-12, "{file}: shell {s} exponent {a} vs {b}");
        }
        let normalised = &from_reference.shells[s].coefficients;
        for (a, b) in mine.coefficients.iter().zip(normalised) {
            assert!(
                (a - b).abs() <= 1e-12 * b.abs(),
                "{file}: shell {s} coefficient {a} vs {b}"
            );
        }
    }
    // Same geometry, same basis: the matrices must be identical to the ones
    // built from the reference's own shell list.
    let (mine, _) = integrals::overlap_and_kinetic(&basis);
    let (theirs, _) = integrals::overlap_and_kinetic(&from_reference);
    assert!((mine - theirs).abs().max() < 1e-13, "{file}: overlap differs");
}

#[test]
fn sto3g_table_matches_reference() {
    for file in [
        "integrals_h2_sto3g.json",
        "integrals_h2o_sto3g.json",
        "integrals_h2s_sto3g.json",
        "integrals_co2_sto3g.json",
    ] {
        check_table(BasisKind::Sto3g, file);
    }
}

#[test]
fn b631gs_table_matches_reference() {
    let file = "integrals_h2o_631gs.json";
    let reference: IntegralReference = load(file);
    assert!(
        reference.cartesian && reference.shells.iter().any(|s| s.l == 2),
        "{file} was expected to hold Cartesian d shells"
    );
    check_table(BasisKind::B631Gs, file);
}
