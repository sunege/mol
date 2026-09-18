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
use crate::basis::BasisSet;
use crate::grid::GridQuality;
use crate::molecule::{Atom, Molecule};

/// Superposition of neutral-atom densities.
///
/// For a charged molecule the trace comes out as the neutral electron count; the
/// SCF corrects that within a few iterations, and using the neutral atoms keeps a
/// single cache valid for every charge state.
pub fn superposition_of_atomic_densities(molecule: &Molecule, basis: &BasisSet) -> DMatrix<f64> {
    let n = basis.n_functions();
    let mut density = DMatrix::zeros(n, n);
    // One atomic SCF per element, not per atom.
    let mut cache: HashMap<u8, DMatrix<f64>> = HashMap::new();

    for (index, atom) in molecule.atoms.iter().enumerate() {
        let block = cache.entry(atom.z).or_insert_with(|| atomic_density(atom.z));
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
fn atomic_density(z: u8) -> DMatrix<f64> {
    let molecule = Molecule::new(vec![Atom { z, pos: [0.0; 3] }])
        .expect("a single supported atom is always a valid molecule");
    // A coarse grid is plenty: this density is only a starting point, and a
    // single atom is the easiest possible integrand.
    let system = System::build(molecule, GridQuality::Coarse)
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
    use crate::integrals;
    use approx::assert_relative_eq;

    /// `trace(D S)` is the number of electrons a density matrix describes.
    fn electron_count(density: &DMatrix<f64>, overlap: &DMatrix<f64>) -> f64 {
        (density * overlap).trace()
    }

    #[test]
    fn guess_holds_the_right_number_of_electrons() {
        for atoms in [
            vec![(8u8, [0.0, 0.0, 0.1173]), (1, [0.0, 0.7572, -0.4693]), (1, [0.0, -0.7572, -0.4693])],
            vec![(6, [0.0, 0.0, 0.0]), (8, [0.0, 0.0, 1.16])],
            vec![(16, [0.0, 0.0, 0.0]), (1, [0.0, 0.96, 0.6])],
        ] {
            let molecule = Molecule::from_angstrom(&atoms).unwrap();
            let basis = BasisSet::sto3g(&molecule).unwrap();
            let overlap = integrals::overlap(&basis);
            let density = superposition_of_atomic_densities(&molecule, &basis);
            assert_relative_eq!(
                electron_count(&density, &overlap),
                molecule.n_electrons() as f64,
                max_relative = 1e-8
            );
        }
    }

    #[test]
    fn guess_is_symmetric_and_block_diagonal() {
        let molecule =
            Molecule::from_angstrom(&[(8, [0.0; 3]), (1, [0.0, 0.0, 0.96])]).unwrap();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let density = superposition_of_atomic_densities(&molecule, &basis);
        let n = basis.n_functions();
        for i in 0..n {
            for j in 0..n {
                assert_relative_eq!(density[(i, j)], density[(j, i)], epsilon = 1e-14);
            }
        }
        // Oxygen owns functions 0..5, hydrogen function 5; there is no overlap
        // between the blocks in a superposition of isolated atoms.
        for i in basis.atom_range(0) {
            for j in basis.atom_range(1) {
                assert_eq!(density[(i, j)], 0.0);
            }
        }
    }

    #[test]
    fn atomic_densities_are_spherical() {
        // Carbon has two electrons in a threefold degenerate 2p shell. A
        // spherical density puts the same population in each p function, so the
        // three diagonal entries of the 2p block must agree.
        let molecule = Molecule::new(vec![Atom { z: 6, pos: [0.0; 3] }]).unwrap();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let density = superposition_of_atomic_densities(&molecule, &basis);
        // STO-3G carbon: 1s, 2s, then 2px, 2py, 2pz.
        let (px, py, pz) = (density[(2, 2)], density[(3, 3)], density[(4, 4)]);
        assert_relative_eq!(px, py, max_relative = 1e-8);
        assert_relative_eq!(py, pz, max_relative = 1e-8);
        assert!(px > 0.0);
    }

    #[test]
    fn every_element_produces_a_usable_atomic_density() {
        for z in 1..=crate::element::MAX_Z {
            let molecule = Molecule::new(vec![Atom { z, pos: [0.0; 3] }]).unwrap();
            let basis = BasisSet::sto3g(&molecule).unwrap();
            let overlap = integrals::overlap(&basis);
            let density = superposition_of_atomic_densities(&molecule, &basis);
            assert_relative_eq!(
                electron_count(&density, &overlap),
                z as f64,
                max_relative = 1e-8
            );
        }
    }
}
