//! Becke's fuzzy-cell partition of molecular space.
//!
//! The molecular integral is split into atomic contributions with a smooth
//! partition of unity, `sum_A w_A(r) = 1`, so each piece can be integrated on an
//! atom-centred radial/angular grid.
//!
//! A. D. Becke, J. Chem. Phys. 88, 2547 (1988), including the atomic size
//! adjustment of its appendix. Becke's Bragg-Slater radii are replaced by the
//! covalent radii the engine already carries; only the *ratio* of two radii
//! enters, and the choice affects how fast the quadrature converges, never what
//! it converges to.

use crate::constants::BOHR_PER_ANGSTROM;
use crate::element;
use crate::molecule::Molecule;

/// Becke's smoothing polynomial `f(f(f(mu)))`, iterated three times as the
/// paper recommends. The cell function is `s(mu) = (1 - g(mu)) / 2`.
fn smoothing(mu: f64) -> f64 {
    let f = |x: f64| 1.5 * x - 0.5 * x * x * x;
    f(f(f(mu)))
}

/// Becke's step function `s(mu)`.
#[cfg(test)]
fn smooth_step(mu: f64) -> f64 {
    0.5 * (1.0 - smoothing(mu))
}

/// Precomputed geometry for the cell weights of one molecule.
#[derive(Debug, Clone)]
pub struct BeckePartition {
    n: usize,
    /// `1 / R_AB`, row-major `n x n`, zero on the diagonal.
    inverse_distance: Vec<f64>,
    /// Size-adjustment parameter `a_AB`, row-major `n x n`.
    adjustment: Vec<f64>,
    /// Distances from the current point to each nucleus. Held here rather than
    /// allocated per call: `weights` runs once per grid point, tens of thousands
    /// of times per molecule.
    distance: Vec<f64>,
    /// `s(nu_AB)` for the current point, row-major `n x n`.
    step: Vec<f64>,
}

impl BeckePartition {
    pub fn new(molecule: &Molecule) -> Self {
        let n = molecule.n_atoms();
        let mut inverse_distance = vec![0.0; n * n];
        let mut adjustment = vec![0.0; n * n];
        let radius = |z: u8| {
            element::get(z).map(|e| e.covalent_radius).unwrap_or(1.0) * BOHR_PER_ANGSTROM
        };
        for a in 0..n {
            for b in 0..n {
                if a == b {
                    continue;
                }
                let pa = molecule.atoms[a].pos;
                let pb = molecule.atoms[b].pos;
                let d = ((pa[0] - pb[0]).powi(2)
                    + (pa[1] - pb[1]).powi(2)
                    + (pa[2] - pb[2]).powi(2))
                .sqrt();
                inverse_distance[a * n + b] = 1.0 / d;

                // Antisymmetric by construction: swapping the atoms inverts
                // chi and flips the sign of u and of a. It is computed once per
                // pair and mirrored, so the identity `weights` relies on holds
                // exactly rather than to the last bit.
                if a < b {
                    let chi = radius(molecule.atoms[a].z) / radius(molecule.atoms[b].z);
                    let u = (chi - 1.0) / (chi + 1.0);
                    // a = u / (u^2 - 1), capped at Becke's recommended 0.5.
                    let value = (u / (u * u - 1.0)).clamp(-0.5, 0.5);
                    adjustment[a * n + b] = value;
                    adjustment[b * n + a] = -value;
                }
            }
        }
        BeckePartition {
            n,
            inverse_distance,
            adjustment,
            distance: vec![0.0; n],
            step: vec![0.0; n * n],
        }
    }

    /// Fills `out` with the cell weight of every atom at `point`; the values sum
    /// to one unless the point is so far out that every cell function
    /// underflows, in which case they are all zero and the point contributes
    /// nothing.
    pub fn weights(&mut self, molecule: &Molecule, point: [f64; 3], out: &mut [f64]) {
        debug_assert_eq!(out.len(), self.n);
        let n = self.n;
        if n == 1 {
            out[0] = 1.0;
            return;
        }

        // Distances from the point to each nucleus, reused by every pair.
        let distance = &mut self.distance;
        for (a, atom) in molecule.atoms.iter().enumerate() {
            distance[a] = ((point[0] - atom.pos[0]).powi(2)
                + (point[1] - atom.pos[1]).powi(2)
                + (point[2] - atom.pos[2]).powi(2))
            .sqrt();
        }

        // One smoothing per unordered pair. The adjustment is antisymmetric
        // (`a_BA = -a_AB`) and so is `mu`, so `nu_BA = -nu_AB`, and because the
        // polynomial is odd, `s(nu_BA) = (1 + g(nu_AB)) / 2`: both halves of the
        // pair come from one evaluation, without the cancellation of `1 - s`.
        let step = &mut self.step;
        for a in 0..n {
            for b in (a + 1)..n {
                let mu = (distance[a] - distance[b]) * self.inverse_distance[a * n + b];
                let nu = mu + self.adjustment[a * n + b] * (1.0 - mu * mu);
                let g = smoothing(nu);
                step[a * n + b] = 0.5 * (1.0 - g);
                step[b * n + a] = 0.5 * (1.0 + g);
            }
        }

        let mut total = 0.0;
        for a in 0..n {
            let mut cell = 1.0;
            for b in 0..n {
                if a == b {
                    continue;
                }
                cell *= step[a * n + b];
                if cell == 0.0 {
                    break;
                }
            }
            out[a] = cell;
            total += cell;
        }
        if total > 0.0 {
            for value in out.iter_mut() {
                *value /= total;
            }
        }
    }
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

    #[test]
    fn smoothing_step_is_a_partition_pair() {
        // s(-mu) = 1 - s(mu), which is what makes the two-atom partition sum
        // to one, and the step is flat at the ends.
        for mu in [-1.0, -0.6, -0.2, 0.0, 0.3, 0.75, 1.0] {
            assert_relative_eq!(smooth_step(mu) + smooth_step(-mu), 1.0, epsilon = 1e-14);
        }
        assert_relative_eq!(smooth_step(-1.0), 1.0, epsilon = 1e-14);
        assert_relative_eq!(smooth_step(1.0), 0.0, epsilon = 1e-14);
        assert_relative_eq!(smooth_step(0.0), 0.5, epsilon = 1e-14);
    }

    #[test]
    fn weights_form_a_partition_of_unity() {
        let mol = water();
        let partition = BeckePartition::new(&mol);
        let mut out = vec![0.0; mol.n_atoms()];
        let mut partition = partition;
        // A deterministic scatter of points, including some far outside.
        for i in 0..200 {
            let t = i as f64;
            let point = [
                (t * 0.7).sin() * 4.0,
                (t * 1.3).cos() * 4.0,
                ((t * 0.31).sin() - 0.2) * 4.0,
            ];
            partition.weights(&mol, point, &mut out);
            let total: f64 = out.iter().sum();
            assert_relative_eq!(total, 1.0, epsilon = 1e-12);
            assert!(out.iter().all(|&w| (-1e-15..=1.0 + 1e-15).contains(&w)));
        }
    }

    #[test]
    fn a_nucleus_owns_its_own_position() {
        let mol = water();
        let mut partition = BeckePartition::new(&mol);
        let mut out = vec![0.0; mol.n_atoms()];
        for (a, atom) in mol.atoms.iter().enumerate() {
            partition.weights(&mol, atom.pos, &mut out);
            assert_relative_eq!(out[a], 1.0, epsilon = 1e-12);
        }
    }

    #[test]
    fn identical_atoms_split_the_midpoint_evenly() {
        let h2 = Molecule::new(vec![
            Atom { z: 1, pos: [0.0, 0.0, -0.7] },
            Atom { z: 1, pos: [0.0, 0.0, 0.7] },
        ])
        .unwrap();
        let mut partition = BeckePartition::new(&h2);
        let mut out = vec![0.0; 2];
        partition.weights(&h2, [0.0, 0.0, 0.0], &mut out);
        assert_relative_eq!(out[0], 0.5, epsilon = 1e-12);
        assert_relative_eq!(out[1], 0.5, epsilon = 1e-12);
    }

    #[test]
    fn the_larger_atom_takes_more_of_the_midpoint() {
        // The size adjustment exists precisely so the boundary between unequal
        // atoms does not sit at the geometric midpoint.
        let mol = Molecule::new(vec![
            Atom { z: 1, pos: [0.0, 0.0, 0.0] },
            Atom { z: 17, pos: [0.0, 0.0, 2.4] },
        ])
        .unwrap();
        let mut partition = BeckePartition::new(&mol);
        let mut out = vec![0.0; 2];
        partition.weights(&mol, [0.0, 0.0, 1.2], &mut out);
        assert!(out[1] > out[0], "chlorine should dominate the midpoint");
    }

    #[test]
    fn a_single_atom_owns_everything() {
        let mol = Molecule::new(vec![Atom { z: 6, pos: [0.0; 3] }]).unwrap();
        let mut partition = BeckePartition::new(&mol);
        let mut out = vec![0.0];
        partition.weights(&mol, [3.0, -1.0, 2.0], &mut out);
        assert_eq!(out[0], 1.0);
    }
}
