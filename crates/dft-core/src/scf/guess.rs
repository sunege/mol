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

use super::{run_restricted, InitialGuess, Occupation, OrbitalSet, ScfOptions, System};
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

/// The orbital energies of one isolated atom, in Hartree and lowest first.
///
/// The two ends of a diatomic's correlation diagram: the levels the molecular
/// ones are drawn as having come from. They are the same atomic calculation the
/// guess is built out of - a few milliseconds - and the interesting part of
/// sharing it is the spherical averaging, which is what makes them levels of an
/// atom rather than of an arbitrarily oriented p orbital. Being spherical, they
/// are also the same for both spins, so a correlation diagram's ends are one
/// column however the molecule in the middle is solved.
///
/// Computed rather than tabulated, for the same reason the guess is: changing
/// the basis set needs no new data.
pub fn atomic_levels(z: u8, kind: BasisKind) -> Vec<f64> {
    atomic_orbitals(z, kind).1.energies.iter().copied().collect()
}

/// Converges one isolated atom with its shells filled spherically.
fn atomic_density(z: u8, kind: BasisKind) -> DMatrix<f64> {
    atomic_orbitals(z, kind).1.density
}

/// The atomic calculation all of those read: one element, on its own at the
/// origin, with its partly filled shell spread evenly over the degenerate
/// orbitals.
///
/// The system comes back with the orbitals because a drawing of one atomic
/// orbital needs it: turning a degenerate p set to face a direction is done
/// against the atom's own basis and overlap ([`crate::orbital::atomic_column`]).
/// The columns of `coefficients` are in the order of `energies`, ascending -
/// the order [`atomic_levels`] hands out - since both come out of the same
/// sorted diagonalisation of the same Kohn-Sham matrix.
pub fn atomic_orbitals(z: u8, kind: BasisKind) -> (System, OrbitalSet) {
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
    let mut result = run_restricted(&system, &options);
    let orbitals =
        result.channels.pop().expect("a restricted calculation has exactly one set of orbitals");
    (system, orbitals)
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

    /// The ends of a correlation diagram, which come out of the same atomic
    /// calculation as the guess.
    #[test]
    fn atomic_levels_are_one_per_orbital_and_spherically_degenerate() {
        for kind in KINDS {
            for z in 1..=crate::element::MAX_Z {
                let levels = atomic_levels(z, kind);
                // One level per basis function, whatever the element and the
                // basis: these are the whole ladder, empty orbitals included.
                assert_eq!(levels.len(), system(&[(z, [0.0; 3])], kind).n_functions());
                // Lowest first, as everything that reads them assumes.
                let mut sorted = levels.clone();
                sorted.sort_by(f64::total_cmp);
                assert_eq!(levels, sorted, "{kind:?}, z = {z}");
            }
        }

        // Carbon in the minimal basis is 1s, 2s and three 2p, and the spherical
        // averaging is what makes the last three one level rather than three
        // that happen to be close.
        let carbon = atomic_levels(6, BasisKind::Sto3g);
        assert_eq!(carbon.len(), 5);
        for level in &carbon[3..] {
            assert_relative_eq!(*level, carbon[2], epsilon = 1e-10);
        }
        assert!(carbon[1] - carbon[0] > 1.0, "the core sits far below the valence");
    }

    /// The columns of the atomic orbitals are in the order of the levels, which
    /// is what lets a click on the n-th atomic level draw the n-th column.
    /// Checked by parity rather than by energy: a lone level of a spherical atom
    /// is s-like and has nothing on a p shell, and a threefold level is p-like
    /// and has nothing on an s shell, so a column out of step with its level
    /// shows up as weight on the wrong shells.
    #[test]
    fn atomic_orbital_columns_follow_the_levels() {
        use crate::orbital::DEGENERACY_TOLERANCE;
        for kind in KINDS {
            for z in 1..=crate::element::MAX_Z {
                let (atom, orbitals) = atomic_orbitals(z, kind);
                let c = &orbitals.coefficients;
                let gram = c.transpose() * &atom.overlap * c;
                let identity = DMatrix::<f64>::identity(c.ncols(), c.ncols());
                assert!((gram - identity).amax() < 1e-8, "{kind:?}, z = {z}: not orthonormal");

                let e = &orbitals.energies;
                let mut start = 0;
                while start < e.len() {
                    let mut end = start + 1;
                    while end < e.len() && e[end] - e[start] <= DEGENERACY_TOLERANCE {
                        end += 1;
                    }
                    let silent_l = match end - start {
                        1 => Some(1),
                        3 => Some(0),
                        _ => None,
                    };
                    for (s, shell) in atom.basis.shells.iter().enumerate() {
                        if Some(shell.l) != silent_l {
                            continue;
                        }
                        let block = atom.basis.offset(s)..atom.basis.offset(s + 1);
                        for i in start..end {
                            for mu in block.clone() {
                                assert!(c[(mu, i)].abs() < 1e-6, "{kind:?}, z = {z}, level {i}");
                            }
                        }
                    }
                    start = end;
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
