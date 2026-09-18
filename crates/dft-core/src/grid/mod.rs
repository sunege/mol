//! The numerical integration grid used for the exchange-correlation term.
//!
//! Standard construction: an atom-centred product of a radial quadrature and a
//! Lebedev angular grid per atom, glued together by Becke's fuzzy-cell partition
//! of unity. The angular order is pruned near each nucleus, where the density is
//! almost spherical and a coarse sphere already integrates it exactly.

pub mod becke;
pub mod lebedev_data;
pub mod radial;

pub use becke::BeckePartition;

use crate::constants::BOHR_PER_ANGSTROM;
use crate::element;
use crate::molecule::Molecule;

/// Points whose total weight is smaller than this contribute nothing at double
/// precision and are dropped, which removes most of the far tail of every atom.
const MIN_WEIGHT: f64 = 1e-15;

/// How fine the exchange-correlation quadrature is.
///
/// The SCF defaults to [`GridQuality::Medium`]; the finer levels exist to show
/// in a test that the remaining quadrature error is small and shrinking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridQuality {
    Coarse,
    Medium,
    Fine,
}

impl GridQuality {
    /// Radial points per atom.
    pub fn radial_points(self) -> usize {
        match self {
            GridQuality::Coarse => 40,
            GridQuality::Medium => 60,
            GridQuality::Fine => 85,
        }
    }

    /// Index of the finest angular grid this level uses.
    fn max_angular(self) -> usize {
        match self {
            GridQuality::Coarse => 2, // 110 points
            GridQuality::Medium => 3, // 194 points
            GridQuality::Fine => 4,   // 302 points
        }
    }
}

/// Quadrature points in Bohr with their weights, ready to be summed over.
#[derive(Debug, Clone, Default)]
pub struct MolecularGrid {
    pub points: Vec<[f64; 3]>,
    pub weights: Vec<f64>,
}

impl MolecularGrid {
    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Integrates a scalar function of position over all space.
    pub fn integrate(&self, f: impl Fn([f64; 3]) -> f64) -> f64 {
        self.points.iter().zip(&self.weights).map(|(&p, &w)| w * f(p)).sum()
    }
}

/// Radius that places half the radial points inside the valence region.
///
/// Becke's prescription with Bragg-Slater radii, using the covalent radii the
/// element table already carries: half the radius, except for hydrogen and
/// helium, which are too small to halve.
fn midpoint_radius(z: u8) -> f64 {
    let covalent = element::get(z).map(|e| e.covalent_radius).unwrap_or(1.0) * BOHR_PER_ANGSTROM;
    if z <= 2 {
        covalent
    } else {
        0.5 * covalent
    }
}

/// Angular grid to use at radius `r`, coarsening towards the nucleus where the
/// density is nearly spherical.
fn pruned_angular(r: f64, midpoint: f64, max: usize) -> usize {
    let ratio = r / midpoint;
    let wanted = if ratio < 0.2 {
        0
    } else if ratio < 0.5 {
        1
    } else if ratio < 1.0 {
        2
    } else {
        max
    };
    wanted.min(max)
}

/// Builds the molecular grid.
pub fn build(molecule: &Molecule, quality: GridQuality) -> MolecularGrid {
    let mut partition = BeckePartition::new(molecule);
    let n_atoms = molecule.n_atoms();
    let mut cell_weights = vec![0.0; n_atoms];
    let mut grid = MolecularGrid::default();
    let four_pi = 4.0 * std::f64::consts::PI;

    for (a, atom) in molecule.atoms.iter().enumerate() {
        let midpoint = midpoint_radius(atom.z);
        let radial = radial::becke_chebyshev(quality.radial_points(), midpoint);
        for (&r, &radial_weight) in radial.radii.iter().zip(&radial.weights) {
            let angular = &lebedev_data::GRIDS[pruned_angular(r, midpoint, quality.max_angular())];
            for (unit, &angular_weight) in angular.points.iter().zip(angular.weights) {
                let point = [
                    atom.pos[0] + r * unit[0],
                    atom.pos[1] + r * unit[1],
                    atom.pos[2] + r * unit[2],
                ];
                partition.weights(molecule, point, &mut cell_weights);
                let weight = four_pi * radial_weight * angular_weight * cell_weights[a];
                if weight.abs() > MIN_WEIGHT {
                    grid.points.push(point);
                    grid.weights.push(weight);
                }
            }
        }
    }
    grid
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::molecule::Atom;
    use approx::assert_relative_eq;

    /// A normalised 1s-like density on each nucleus. Its integral is exactly the
    /// number of atoms, which makes it a reference the grid cannot fudge: it
    /// probes the cusp at every nucleus and the overlap region between them.
    fn slater_sum(molecule: &Molecule) -> impl Fn([f64; 3]) -> f64 + '_ {
        move |point: [f64; 3]| {
            molecule
                .atoms
                .iter()
                .map(|atom| {
                    let zeta = atom.z as f64;
                    let r = ((point[0] - atom.pos[0]).powi(2)
                        + (point[1] - atom.pos[1]).powi(2)
                        + (point[2] - atom.pos[2]).powi(2))
                    .sqrt();
                    zeta.powi(3) / std::f64::consts::PI * (-2.0 * zeta * r).exp()
                })
                .sum()
        }
    }

    fn water() -> Molecule {
        Molecule::from_angstrom(&[
            (8, [0.0, 0.0, 0.1173]),
            (1, [0.0, 0.7572, -0.4693]),
            (1, [0.0, -0.7572, -0.4693]),
        ])
        .unwrap()
    }

    #[test]
    fn integrates_atom_centred_densities() {
        let mol = water();
        let grid = build(&mol, GridQuality::Medium);
        let integral = grid.integrate(slater_sum(&mol));
        assert_relative_eq!(integral, 3.0, max_relative = 1e-6);
    }

    #[test]
    fn accuracy_improves_with_quality() {
        let mol = water();
        let mut previous = f64::INFINITY;
        for quality in [GridQuality::Coarse, GridQuality::Medium, GridQuality::Fine] {
            let grid = build(&mol, quality);
            let error = (grid.integrate(slater_sum(&mol)) - 3.0).abs();
            assert!(error < previous, "{quality:?} was not an improvement");
            previous = error;
        }
    }

    #[test]
    fn integrates_a_diffuse_function_far_from_every_nucleus() {
        // A wide Gaussian centred off all the nuclei: sensitive to the outer
        // region rather than the cusps, where point pruning could bite.
        let mol = water();
        let grid = build(&mol, GridQuality::Medium);
        let centre = [1.0, -0.5, 0.8];
        let alpha = 0.35;
        let value = grid.integrate(|p| {
            let r2: f64 = (0..3).map(|k| (p[k] - centre[k]).powi(2)).sum();
            (-alpha * r2).exp()
        });
        let exact = (std::f64::consts::PI / alpha).powf(1.5);
        assert_relative_eq!(value, exact, max_relative = 1e-6);
    }

    #[test]
    fn a_lone_atom_integrates_its_own_density() {
        for z in [1u8, 6, 18] {
            let mol = Molecule::new(vec![Atom { z, pos: [0.0; 3] }]).unwrap();
            let grid = build(&mol, GridQuality::Medium);
            assert_relative_eq!(grid.integrate(slater_sum(&mol)), 1.0, max_relative = 1e-6);
        }
    }

    #[test]
    fn total_weight_is_the_volume_partitioned_once() {
        // Summing the weights of a function that is 1 inside a large ball and 0
        // outside must give that ball's volume: the cells tile space exactly once.
        let mol = water();
        let grid = build(&mol, GridQuality::Fine);
        let centre = mol.center_of_mass();
        let radius = 3.0;
        let volume = grid.integrate(|p| {
            let r2: f64 = (0..3).map(|k| (p[k] - centre[k]).powi(2)).sum();
            if r2 < radius * radius {
                1.0
            } else {
                0.0
            }
        });
        // A sharp cutoff is not a quadrature-friendly integrand, so this is only
        // a sanity check on the scale, not a precision test.
        let exact = 4.0 / 3.0 * std::f64::consts::PI * radius.powi(3);
        assert_relative_eq!(volume, exact, max_relative = 0.02);
    }

    #[test]
    fn pruning_keeps_the_point_count_manageable() {
        let benzene_like: Vec<(u8, [f64; 3])> = (0..6)
            .map(|i| {
                let angle = i as f64 * std::f64::consts::TAU / 6.0;
                (6u8, [1.4 * angle.cos(), 1.4 * angle.sin(), 0.0])
            })
            .collect();
        let mol = Molecule::from_angstrom(&benzene_like).unwrap();
        let grid = build(&mol, GridQuality::Medium);
        // Six atoms at 60 radial points; without pruning and without dropping
        // negligible weights this would be 6 * 60 * 194 = 69 840 points.
        assert!(grid.len() < 60_000, "grid has {} points", grid.len());
        assert!(grid.len() > 10_000, "grid has only {} points", grid.len());
    }
}
