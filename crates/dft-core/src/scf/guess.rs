//! Initial densities for the SCF.
//!
//! The default is SAD: a superposition of atomic densities. Each element's atom
//! is converged once, spherically averaged, in the same basis the molecule uses,
//! and the atomic density matrices are then placed on the diagonal blocks. It
//! costs a handful of tiny SCFs and typically halves the number of molecular
//! iterations compared with starting from the core Hamiltonian.
//!
//! There are two superpositions, and they differ only for a charged molecule.
//!
//! * [`starting_density`], where the SCF starts: the neutral atoms, scaled to
//!   the molecule's electron count. It does not know which atom the charge was
//!   placed on, which is what makes the SCF depend on the total charge alone
//!   ([`crate::molecule::Molecule`]) - bit for bit, not just at convergence.
//!   Starting from the placed ions instead was tried (docs/dev-notes, "V7-1
//!   の実装メモ"): a symmetric cation such as Cl2+ or He2+ placed as Cl+ and Cl
//!   starts with the hole on one side, takes several times the iterations or
//!   does not converge at all, and on a stretched bond can settle on a
//!   different, lopsided answer depending on which atom was marked.
//! * [`superposition_of_atomic_densities`], what the "moved electrons" surface
//!   is drawn against ([`crate::bonding::DensityChannel::Deformation`]): the
//!   atoms as placed, ions included, a bare proton with no electrons at all.
//!   H3O+ placed as water and a proton then shows the electrons the proton took
//!   from the water, not a hydrogen atom's worth missing.
//!
//! Both hold exactly the molecule's electrons.
//!
//! Computing the atomic densities at run time rather than tabulating them means
//! a change of basis set needs no new data.

use std::collections::HashMap;

use nalgebra::{DMatrix, DVector};

use super::linalg::{canonical_orthogonalizer, symmetric_eigen_sorted, OVERLAP_THRESHOLD};
use super::{run_restricted, InitialGuess, Occupation, OrbitalSet, ScfOptions, System};
use crate::basis::BasisKind;
use crate::grid::GridQuality;
use crate::molecule::{Atom, GeometryError, Molecule};

/// Superposition of the placed atoms' densities, in the system's own basis:
/// the reference the deformation density is taken against.
///
/// Each atom is solved with the charge it was placed with
/// ([`Molecule::atom_charges`]), so the trace is the molecule's electron count
/// exactly, charged or not.
pub fn superposition_of_atomic_densities(system: &System) -> DMatrix<f64> {
    superpose(system, &system.molecule.atom_charges)
}

/// Where the SCF starts: the neutral atoms' superposition, scaled to hold the
/// molecule's electrons. For a neutral molecule the scale is exactly one, so
/// this is the guess the engine has always started from.
pub fn starting_density(system: &System) -> DMatrix<f64> {
    let neutral: i32 = system.molecule.total_nuclear_charge();
    let electrons = system.molecule.n_electrons();
    let density = superpose(system, &vec![0; system.molecule.n_atoms()]);
    if electrons == neutral {
        density
    } else {
        density * (electrons as f64 / neutral as f64)
    }
}

/// The atoms with `charges` on them, one block each.
///
/// The atoms are solved in `system.kind`: an atomic block has to be exactly the
/// size of the atom's range in the molecule's basis, and a block from another
/// basis would not fit.
fn superpose(system: &System, charges: &[i32]) -> DMatrix<f64> {
    let basis = &system.basis;
    let n = basis.n_functions();
    let mut density = DMatrix::zeros(n, n);
    // One atomic SCF per element and charge, not per atom. The whole call is in
    // one basis, so those two are the key.
    let mut cache: HashMap<(u8, i32), DMatrix<f64>> = HashMap::new();

    for (index, atom) in system.molecule.atoms.iter().enumerate() {
        let charge = charges[index];
        let block = cache
            .entry((atom.z, charge))
            .or_insert_with(|| atomic_density(atom.z, charge, system.kind));
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
///
/// `charge` is the ion's, as [`atomic_orbitals`] takes it, and a charge no atom
/// can carry is the error [`Molecule::with_atom_charges`] gives.
pub fn atomic_levels(z: u8, charge: i32, kind: BasisKind) -> Result<Vec<f64>, GeometryError> {
    Ok(atomic_orbitals(z, charge, kind)?.1.energies.iter().copied().collect())
}

/// Converges one isolated atom with its shells filled spherically.
///
/// Only ever asked for an atom of a molecule that has been built, whose charges
/// have therefore been checked already.
fn atomic_density(z: u8, charge: i32, kind: BasisKind) -> DMatrix<f64> {
    atomic_orbitals(z, charge, kind)
        .expect("a placed atom's charge was checked when the molecule was built")
        .1
        .density
}

/// The atomic calculation all of those read: one element with `charge` on it,
/// on its own at the origin, with its partly filled shell spread evenly over
/// the degenerate orbitals.
///
/// An ion is solved exactly as an atom is, with its electron count changed:
/// every +1 and -1 of H to Ar that a molecule accepts converges this way, in
/// both bases (docs/v7, "V7-0 で入ったもの"). A nucleus with
/// no electrons left - a proton, He2+ - has nothing to converge: its density is
/// zero and its orbitals are those of the core Hamiltonian, which is what a
/// Kohn-Sham matrix with no electrons in it is. It still has a whole ladder of
/// empty levels, one per basis function, which is what the end of a correlation
/// diagram needs.
///
/// The system comes back with the orbitals because a drawing of one atomic
/// orbital needs it: turning a degenerate p set to face a direction is done
/// against the atom's own basis and overlap ([`crate::orbital::atomic_column`]).
/// The columns of `coefficients` are in the order of `energies`, ascending -
/// the order [`atomic_levels`] hands out - since both come out of the same
/// sorted diagonalisation of the same Kohn-Sham matrix.
pub fn atomic_orbitals(
    z: u8,
    charge: i32,
    kind: BasisKind,
) -> Result<(System, OrbitalSet), GeometryError> {
    let atoms = vec![Atom { z, pos: [0.0; 3] }];
    let molecule = match Molecule::new(atoms.clone())?.with_atom_charges(vec![charge]) {
        Ok(ion) => ion,
        // A bare nucleus is not a molecule the SCF can be asked about, but its
        // basis, overlap and core Hamiltonian are all there is to it here.
        Err(GeometryError::NoElectrons) => {
            Molecule { atoms, atom_charges: vec![charge], charge, multiplicity: 1 }
        }
        Err(other) => return Err(other),
    };
    // A coarse grid is plenty: this density is only a starting point, and a
    // single atom is the easiest possible integrand.
    let system = System::build(molecule, kind, GridQuality::Coarse)
        .expect("the element table and the basis table cover the same range");
    if system.molecule.n_electrons() == 0 {
        let x = canonical_orthogonalizer(&system.overlap, OVERLAP_THRESHOLD);
        let (energies, vectors) = symmetric_eigen_sorted(x.transpose() * &system.core * &x);
        let n = system.n_functions();
        let empty = OrbitalSet {
            occupations: DVector::zeros(energies.len()),
            coefficients: x * vectors,
            energies,
            density: DMatrix::zeros(n, n),
        };
        return Ok((system, empty));
    }
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
    Ok((system, orbitals))
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
                let levels = atomic_levels(z, 0, kind).unwrap();
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
        let carbon = atomic_levels(6, 0, BasisKind::Sto3g).unwrap();
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
                let (atom, orbitals) = atomic_orbitals(z, 0, kind).unwrap();
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

    /// Both superpositions hold the molecule's electrons exactly when an atom is
    /// placed as an ion - a proton with none, an oxide with one extra, a salt
    /// with one of each - and the reference is made of those ions block by block.
    #[test]
    fn both_superpositions_of_placed_ions_hold_the_molecule_s_electrons() {
        let placed: [(&str, Vec<(u8, [f64; 3])>, Vec<i32>); 3] = [
            (
                "H3O+ as water and a proton",
                vec![
                    (8, [0.0, 0.0, 0.0]),
                    (1, [0.0, 0.94, 0.3]),
                    (1, [0.81, -0.47, 0.3]),
                    (1, [-0.81, -0.47, 0.3]),
                ],
                vec![0, 0, 0, 1],
            ),
            ("OH- as O- and H", vec![(8, [0.0; 3]), (1, [0.0, 0.0, 0.97])], vec![-1, 0]),
            ("NaCl as Na+ and Cl-", vec![(11, [0.0; 3]), (17, [0.0, 0.0, 2.36])], vec![1, -1]),
        ];
        for kind in KINDS {
            for (name, atoms, charges) in &placed {
                let molecule = Molecule::from_angstrom(atoms)
                    .unwrap()
                    .with_atom_charges(charges.clone())
                    .unwrap();
                let system = System::build(molecule, kind, GridQuality::Coarse).unwrap();
                let density = superposition_of_atomic_densities(&system);
                for guess in [&density, &starting_density(&system)] {
                    assert_relative_eq!(
                        electron_count(guess, &system.overlap),
                        system.molecule.n_electrons() as f64,
                        max_relative = 1e-8
                    );
                }
                // And each block of the reference holds its own atom's share, which is what makes
                // it the ion rather than the right total spread some other way.
                for (index, atom) in system.molecule.atoms.iter().enumerate() {
                    let range = system.basis.atom_range(index);
                    let at = (range.start, range.start);
                    let size = (range.len(), range.len());
                    let own = (density.view(at, size) * system.overlap.view(at, size)).trace();
                    let expected = atom.z as i32 - charges[index];
                    assert!(
                        (own - expected as f64).abs() < 1e-8,
                        "{kind:?}, {name}: atom {index} holds {own}, expected {expected}"
                    );
                }
            }
        }
    }

    /// Where the SCF starts does not depend on which atom carries the charge,
    /// and for a neutral molecule it is the superposition itself.
    #[test]
    fn the_starting_density_knows_only_the_total_charge() {
        let atoms = [
            (8u8, [0.0, 0.0, 0.0]),
            (1, [0.0, 0.94, 0.3]),
            (1, [0.81, -0.47, 0.3]),
            (1, [-0.81, -0.47, 0.3]),
        ];
        let placed = |charges: Vec<i32>| {
            let molecule =
                Molecule::from_angstrom(&atoms).unwrap().with_atom_charges(charges).unwrap();
            System::build(molecule, BasisKind::Sto3g, GridQuality::Coarse).unwrap()
        };
        let (proton, oxygen) = (placed(vec![0, 0, 0, 1]), placed(vec![1, 0, 0, 0]));
        assert_eq!(starting_density(&proton), starting_density(&oxygen));
        assert_ne!(
            superposition_of_atomic_densities(&proton),
            superposition_of_atomic_densities(&oxygen),
            "the reference is the one that knows"
        );
        let neutral = placed(vec![0, 0, 0, 0]);
        assert_eq!(starting_density(&neutral), superposition_of_atomic_densities(&neutral));
    }

    /// Every ion a molecule accepts comes out of the atomic calculation with
    /// its own electron count.
    #[test]
    fn every_ion_produces_a_usable_atomic_density() {
        for kind in KINDS {
            for z in 1..=crate::element::MAX_Z {
                for charge in [-1, 1] {
                    let Ok((atom, orbitals)) = atomic_orbitals(z, charge, kind) else {
                        assert!(
                            charge == -1 && [2, 10, 18].contains(&z),
                            "{kind:?}: z = {z}, charge {charge} was refused"
                        );
                        continue;
                    };
                    assert_relative_eq!(
                        electron_count(&orbitals.density, &atom.overlap),
                        (z as i32 - charge) as f64,
                        epsilon = 1e-8
                    );
                }
            }
        }
    }

    /// A proton has no electrons to converge, and still has a level per basis
    /// function: the core Hamiltonian's, which is its Kohn-Sham matrix.
    #[test]
    fn a_bare_nucleus_has_no_density_and_a_whole_ladder_of_empty_levels() {
        for kind in KINDS {
            for (z, charge) in [(1u8, 1), (2, 2), (3, 3)] {
                let (atom, orbitals) = atomic_orbitals(z, charge, kind).unwrap();
                let n = atom.n_functions();
                assert_eq!(orbitals.density, DMatrix::zeros(n, n), "{kind:?}, z = {z}");
                assert!(orbitals.occupations.iter().all(|&o| o == 0.0));
                let levels = atomic_levels(z, charge, kind).unwrap();
                assert_eq!(levels.len(), n, "{kind:?}, z = {z}");
                // Orthonormal in the atom's overlap, as the columns of an SCF are.
                let c = &orbitals.coefficients;
                let gram = c.transpose() * &atom.overlap * c;
                assert!((gram - DMatrix::<f64>::identity(n, n)).amax() < 1e-8);
                // And they are the core Hamiltonian's: H C = S C e.
                let e = DMatrix::from_diagonal(&orbitals.energies);
                let residual = &atom.core * c - &atom.overlap * c * e;
                assert!(residual.amax() < 1e-8, "{kind:?}, z = {z}: {}", residual.amax());
            }
        }
        // A charge no atom can carry is refused rather than solved with an
        // electron missing: helium's one function is already full.
        assert_eq!(
            atomic_levels(2, -1, BasisKind::Sto3g).unwrap_err(),
            GeometryError::UnsupportedAtomCharge { atom: 0, z: 2, charge: -1 }
        );
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
