//! Initial densities for the SCF.
//!
//! The default is SAD: a superposition of atomic densities. Each element's atom
//! is converged once, spherically averaged, in the same basis the molecule uses,
//! and the atomic density matrices are then placed on the diagonal blocks. It
//! costs a handful of tiny SCFs and typically halves the number of molecular
//! iterations compared with starting from the core Hamiltonian.
//!
//! Computing the atomic densities at run time rather than tabulating them means
//! a change of basis set needs no new data.

use std::collections::HashMap;

use nalgebra::DMatrix;

use super::{run_restricted, InitialGuess, Occupation, ScfOptions, System};
use crate::basis::BasisKind;
use crate::grid::GridQuality;
use crate::molecule::{Atom, Molecule};

/// Superposition of neutral-atom densities, in the system's own basis.
///
/// For a charged molecule the trace comes out as the neutral electron count; the
/// SCF corrects that within a few iterations, and using the neutral atoms keeps a
/// single cache valid for every charge state.
///
/// The atoms are solved in `system.kind`: an atomic block has to be exactly the
/// size of the atom's range in the molecule's basis, and a block from another
/// basis would not fit.
pub fn superposition_of_atomic_densities(system: &System) -> DMatrix<f64> {
    let basis = &system.basis;
    let n = basis.n_functions();
    let mut density = DMatrix::zeros(n, n);
    // One atomic SCF per element, not per atom. The whole call is in one basis,
    // so the element alone is the key.
    let mut cache: HashMap<u8, DMatrix<f64>> = HashMap::new();

    for (index, atom) in system.molecule.atoms.iter().enumerate() {
        let block = cache.entry(atom.z).or_insert_with(|| atomic_density(atom.z, system.kind));
        let range = basis.atom_range(index);
        debug_assert_eq!(range.len(), block.nrows(), "atomic block size mismatch");
        for (i, row) in range.clone().enumerate() {
            for (j, column) in range.clone().enumerate() {
                density[(row, column)] = block[(i, j)];
            }
        }
    }
    density
}

/// Converges one isolated atom with its shells filled spherically.
fn atomic_density(z: u8, kind: BasisKind) -> DMatrix<f64> {
    let molecule = Molecule::new(vec![Atom { z, pos: [0.0; 3] }])
        .expect("a single supported atom is always a valid molecule");
    // A coarse grid is plenty: this density is only a starting point, and a
    // single atom is the easiest possible integrand.
    let system = System::build(molecule, kind, GridQuality::Coarse)
        .expect("the element table and the basis table cover the same range");
    let options = ScfOptions {
        // Starting from the core Hamiltonian is what stops this from recursing
        // back into the atomic guess.
        initial_guess: InitialGuess::Core,
        occupation: Occupation::SphericalAverage,
        max_iterations: 80,
        damping_iterations: 8,
        ..ScfOptions::default()
    };
    // A non-converged atom still gives a perfectly serviceable guess, so the
    // flag is deliberately ignored here.
    run_restricted(&system, &options).density
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    const KINDS: [BasisKind; 2] = [BasisKind::Sto3g, BasisKind::B631Gs];

    fn system(atoms: &[(u8, [f64; 3])], kind: BasisKind) -> System {
        let molecule = Molecule::from_angstrom(atoms).unwrap();
        System::build(molecule, kind, GridQuality::Coarse).unwrap()
    }

    /// `trace(D S)` is the number of electrons a density matrix describes.
    fn electron_count(density: &DMatrix<f64>, overlap: &DMatrix<f64>) -> f64 {
        (density * overlap).trace()
    }

    #[test]
    fn guess_holds_the_right_number_of_electrons() {
        for kind in KINDS {
            for atoms in [
                vec![
                    (8u8, [0.0, 0.0, 0.1173]),
                    (1, [0.0, 0.7572, -0.4693]),
                    (1, [0.0, -0.7572, -0.4693]),
                ],
                vec![(6, [0.0, 0.0, 0.0]), (8, [0.0, 0.0, 1.16])],
                vec![(16, [0.0, 0.0, 0.0]), (1, [0.0, 0.96, 0.6])],
            ] {
                let system = system(&atoms, kind);
                let density = superposition_of_atomic_densities(&system);
                assert_relative_eq!(
                    electron_count(&density, &system.overlap),
                    system.molecule.n_electrons() as f64,
                    max_relative = 1e-8
                );
            }
        }
    }

    #[test]
    fn guess_is_symmetric_and_block_diagonal() {
        for kind in KINDS {
            let system = system(&[(8, [0.0; 3]), (1, [0.0, 0.0, 0.96])], kind);
            let density = superposition_of_atomic_densities(&system);
            let basis = &system.basis;
            let n = basis.n_functions();
            for i in 0..n {
                for j in 0..n {
                    assert_relative_eq!(density[(i, j)], density[(j, i)], epsilon = 1e-14);
                }
            }
            // There is no overlap between the oxygen and the hydrogen blocks in a
            // superposition of isolated atoms.
            for i in basis.atom_range(0) {
                for j in basis.atom_range(1) {
                    assert_eq!(density[(i, j)], 0.0);
                }
            }
        }
    }

    #[test]
    fn atomic_densities_are_spherical() {
        // Carbon has two electrons in a threefold degenerate 2p shell. A
        // spherical density puts the same population in each p function, so the
        // three diagonal entries of every p block must agree. The same holds for
        // the d shell's xx, yy, zz and, separately, for its xy, xz, yz.
        for kind in KINDS {
            let system = system(&[(6, [0.0; 3])], kind);
            let density = superposition_of_atomic_densities(&system);
            let basis = &system.basis;
            for (s, shell) in basis.shells.iter().enumerate() {
                let at = |i: usize| density[(basis.offset(s) + i, basis.offset(s) + i)];
                let alike: &[&[usize]] = match shell.l {
                    1 => &[&[0, 1, 2]],
                    // Cartesian order: xx, xy, xz, yy, yz, zz.
                    2 => &[&[0, 3, 5], &[1, 2, 4]],
                    _ => &[],
                };
                for set in alike {
                    for &i in &set[1..] {
                        assert_relative_eq!(at(i), at(set[0]), max_relative = 1e-8);
                    }
                }
                if shell.l == 1 {
                    assert!(at(0) > 0.0, "{kind:?}: empty p shell");
                }
            }
        }
    }

    #[test]
    fn every_element_produces_a_usable_atomic_density() {
        for kind in KINDS {
            for z in 1..=crate::element::MAX_Z {
                let molecule = Molecule::new(vec![Atom { z, pos: [0.0; 3] }]).unwrap();
                let system = System::build(molecule, kind, GridQuality::Coarse).unwrap();
                let density = superposition_of_atomic_densities(&system);
                assert_relative_eq!(
                    electron_count(&density, &system.overlap),
                    z as f64,
                    max_relative = 1e-8
                );
            }
        }
    }
}
