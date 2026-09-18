//! Central differences, for checking the analytic gradient against.
//!
//! This exists before the analytic gradient does, and deliberately so: a wrong
//! Pulay term or a sign slip in one derivative integral changes a force by a few
//! percent, which no energy test notices and no picture of a relaxing molecule
//! gives away. The only thing that catches it is displacing a nucleus and
//! watching what the energy actually does.
//!
//! Two shapes are provided because the gradient is checked at two levels. The
//! scalar version differences an energy and is what the acceptance test uses;
//! the matrix version differences a whole integral matrix, which is how a
//! failure is traced to `dS/dR`, `dT/dR` or `dV/dR` individually rather than
//! only to "the gradient is wrong".
//!
//! Step size: the differencing error goes as `h^2 f'''` and the rounding error
//! as `eps |f| / h`, which for a molecular energy of order 100 Hartree meet
//! around `h = 1e-4` Bohr with roughly ten digits left. [`DEFAULT_STEP`] is that
//! value, and it is what the tests use unless they are differencing something
//! much larger or much smaller.

use nalgebra::DMatrix;

use crate::molecule::Molecule;

/// Displacement in Bohr that leaves the most digits in a central difference of
/// a molecular energy.
pub const DEFAULT_STEP: f64 = 1.0e-4;

/// Central difference of a scalar function of the geometry, one nuclear
/// coordinate at a time. Shape: `[n_atoms][3]`, in units of `f` per Bohr.
///
/// `f` is called `6 n_atoms` times, so for anything involving an SCF this is a
/// test-only tool and no part of the application.
pub fn scalar(molecule: &Molecule, step: f64, mut f: impl FnMut(&Molecule) -> f64) -> Vec<[f64; 3]> {
    let mut gradient = vec![[0.0; 3]; molecule.n_atoms()];
    for atom in 0..molecule.n_atoms() {
        for axis in 0..3 {
            let (plus, minus) = displace(molecule, atom, axis, step);
            gradient[atom][axis] = (f(&plus) - f(&minus)) / (2.0 * step);
        }
    }
    gradient
}

/// The same for a matrix-valued function - an integral matrix - giving one
/// derivative matrix per nuclear coordinate.
pub fn matrix(
    molecule: &Molecule,
    step: f64,
    mut f: impl FnMut(&Molecule) -> DMatrix<f64>,
) -> Vec<[DMatrix<f64>; 3]> {
    let mut out = Vec::with_capacity(molecule.n_atoms());
    for atom in 0..molecule.n_atoms() {
        let mut per_axis = Vec::with_capacity(3);
        for axis in 0..3 {
            let (plus, minus) = displace(molecule, atom, axis, step);
            per_axis.push((f(&plus) - f(&minus)) / (2.0 * step));
        }
        let mut per_axis = per_axis.into_iter();
        out.push([
            per_axis.next().unwrap(),
            per_axis.next().unwrap(),
            per_axis.next().unwrap(),
        ]);
    }
    out
}

/// The molecule with one nucleus moved forwards and backwards along one axis.
fn displace(molecule: &Molecule, atom: usize, axis: usize, step: f64) -> (Molecule, Molecule) {
    let mut plus = molecule.clone();
    let mut minus = molecule.clone();
    plus.atoms[atom].pos[axis] += step;
    minus.atoms[atom].pos[axis] -= step;
    (plus, minus)
}

/// Largest absolute disagreement between two gradients, for a test's assertion
/// message to quote.
pub fn max_deviation(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    assert_eq!(a.len(), b.len(), "gradients have different atom counts");
    let mut worst = 0.0f64;
    for (x, y) in a.iter().zip(b) {
        for axis in 0..3 {
            worst = worst.max((x[axis] - y[axis]).abs());
        }
    }
    worst
}

/// Largest absolute value in a gradient, which sets the scale a deviation has to
/// be read against.
pub fn max_component(gradient: &[[f64; 3]]) -> f64 {
    gradient
        .iter()
        .flat_map(|g| g.iter())
        .fold(0.0f64, |worst, value| worst.max(value.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::molecule::Atom;
    use approx::assert_relative_eq;

    fn water() -> Molecule {
        Molecule::from_angstrom(&[
            (8, [0.0, 0.0, 0.1173]),
            (1, [0.0, 0.7572, -0.4693]),
            (1, [0.0, -0.7572, -0.4693]),
        ])
        .unwrap()
    }

    /// The harness has to be right before anything is checked with it, so it is
    /// pointed at the one gradient that was already known to be correct: the
    /// nuclear repulsion, whose analytic derivative predates this module.
    #[test]
    fn reproduces_the_nuclear_repulsion_gradient() {
        let mol = water();
        let analytic = mol.nuclear_repulsion_gradient();
        let numeric = scalar(&mol, DEFAULT_STEP, |m| m.nuclear_repulsion());
        assert!(max_deviation(&analytic, &numeric) < 1e-8);
        assert!(max_component(&analytic) > 1.0, "nothing to compare against");
    }

    /// A quadratic in one coordinate, whose derivative a central difference gets
    /// exactly: this separates "the harness displaces the right atom along the
    /// right axis" from any question about accuracy.
    #[test]
    fn differences_the_coordinate_it_says_it_does() {
        let mol = Molecule::new(vec![
            Atom { z: 1, pos: [0.3, -0.7, 1.1] },
            Atom { z: 1, pos: [2.0, 0.5, -0.4] },
        ])
        .unwrap();
        // f = 3 x1 - 2 y0^2, so only two components are non-zero.
        let f = |m: &Molecule| 3.0 * m.atoms[1].pos[0] - 2.0 * m.atoms[0].pos[1].powi(2);
        let numeric = scalar(&mol, 1e-3, f);
        assert_relative_eq!(numeric[1][0], 3.0, epsilon = 1e-9);
        assert_relative_eq!(numeric[0][1], -4.0 * mol.atoms[0].pos[1], epsilon = 1e-9);
        assert_relative_eq!(numeric[0][0], 0.0, epsilon = 1e-12);
        assert_relative_eq!(numeric[1][2], 0.0, epsilon = 1e-12);
    }

    #[test]
    fn matrix_version_differences_every_entry() {
        let mol = water();
        // A matrix whose entries are the pair distances: its derivative is known
        // without any integral code.
        let distances = |m: &Molecule| {
            DMatrix::from_fn(m.n_atoms(), m.n_atoms(), |i, j| {
                let (p, q) = (m.atoms[i].pos, m.atoms[j].pos);
                (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f64>().sqrt()
            })
        };
        let derivative = matrix(&mol, DEFAULT_STEP, distances);
        let r01 = distances(&mol)[(0, 1)];
        let expected = (mol.atoms[0].pos[1] - mol.atoms[1].pos[1]) / r01;
        assert_relative_eq!(derivative[0][1][(0, 1)], expected, epsilon = 1e-7);
        // Moving atom 0 cannot change the distance between 1 and 2.
        assert_relative_eq!(derivative[0][1][(1, 2)], 0.0, epsilon = 1e-9);
    }
}
