//! Molecular geometry in atomic units.

use crate::constants::BOHR_PER_ANGSTROM;
use crate::element::{self, MAX_Z};

/// A single nucleus with its position in Bohr.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Atom {
    pub z: u8,
    /// Position in Bohr.
    pub pos: [f64; 3],
}

/// Reasons a geometry cannot be handed to the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeometryError {
    /// No atoms were supplied.
    Empty,
    /// An atomic number outside the supported H-Ar range.
    UnsupportedElement { z: u8 },
    /// Two nuclei sit on top of each other, which makes the nuclear repulsion
    /// energy diverge.
    CoincidentAtoms { a: usize, b: usize },
    /// The requested charge would leave the system with no electrons at all.
    NoElectrons,
}

/// Nuclei closer than this (in Bohr) are treated as coincident.
const MIN_SEPARATION: f64 = 1.0e-3;

/// A non-periodic molecule: nuclei, total charge and spin multiplicity.
///
/// `charge` and `multiplicity` are chosen automatically by the driver and are
/// never exposed to the user, but they are explicit here so the SCF code can be
/// driven deterministically and tested against reference values.
#[derive(Debug, Clone, PartialEq)]
pub struct Molecule {
    pub atoms: Vec<Atom>,
    /// Total charge in units of the elementary charge.
    pub charge: i32,
    /// Spin multiplicity 2S+1.
    pub multiplicity: u32,
}

impl Molecule {
    /// Builds a neutral molecule from positions given in Bohr, with the
    /// multiplicity guessed from the electron count parity.
    pub fn new(atoms: Vec<Atom>) -> Result<Self, GeometryError> {
        let mut mol = Molecule { atoms, charge: 0, multiplicity: 1 };
        mol.validate()?;
        mol.multiplicity = mol.default_multiplicity();
        Ok(mol)
    }

    /// Builds a neutral molecule from positions given in Angstrom.
    pub fn from_angstrom(atoms: &[(u8, [f64; 3])]) -> Result<Self, GeometryError> {
        let atoms = atoms
            .iter()
            .map(|&(z, p)| Atom {
                z,
                pos: [
                    p[0] * BOHR_PER_ANGSTROM,
                    p[1] * BOHR_PER_ANGSTROM,
                    p[2] * BOHR_PER_ANGSTROM,
                ],
            })
            .collect();
        Molecule::new(atoms)
    }

    /// Rejects geometries the engine cannot handle. Called on construction and
    /// again whenever coordinates are replaced by the optimizer.
    pub fn validate(&self) -> Result<(), GeometryError> {
        if self.atoms.is_empty() {
            return Err(GeometryError::Empty);
        }
        for atom in &self.atoms {
            if atom.z == 0 || atom.z > MAX_Z {
                return Err(GeometryError::UnsupportedElement { z: atom.z });
            }
        }
        for a in 0..self.atoms.len() {
            for b in (a + 1)..self.atoms.len() {
                if distance(&self.atoms[a], &self.atoms[b]) < MIN_SEPARATION {
                    return Err(GeometryError::CoincidentAtoms { a, b });
                }
            }
        }
        if self.n_electrons() < 1 {
            return Err(GeometryError::NoElectrons);
        }
        Ok(())
    }

    pub fn n_atoms(&self) -> usize {
        self.atoms.len()
    }

    /// Sum of nuclear charges.
    pub fn total_nuclear_charge(&self) -> i32 {
        self.atoms.iter().map(|a| a.z as i32).sum()
    }

    /// Electron count after applying the total charge. Can be negative for an
    /// absurd charge, which `validate` rejects.
    pub fn n_electrons(&self) -> i32 {
        self.total_nuclear_charge() - self.charge
    }

    /// Singlet for an even electron count, doublet for an odd one. This is the
    /// starting point of the automatic spin search, not the final answer:
    /// O2, for instance, is corrected to a triplet by trying both.
    pub fn default_multiplicity(&self) -> u32 {
        if self.n_electrons() % 2 == 0 {
            1
        } else {
            2
        }
    }

    /// Alpha and beta electron counts implied by `charge` and `multiplicity`.
    /// Returns `None` when the combination is impossible (wrong parity, or more
    /// unpaired electrons than there are electrons).
    pub fn spin_occupation(&self) -> Option<(usize, usize)> {
        let n = self.n_electrons();
        if n < 1 {
            return None;
        }
        // multiplicity = 2S + 1, so the number of unpaired electrons is 2S.
        let unpaired = self.multiplicity as i32 - 1;
        if unpaired < 0 || (n - unpaired) % 2 != 0 || n < unpaired {
            return None;
        }
        let beta = (n - unpaired) / 2;
        let alpha = beta + unpaired;
        Some((alpha as usize, beta as usize))
    }

    /// Nuclear repulsion energy in Hartree.
    pub fn nuclear_repulsion(&self) -> f64 {
        let mut e = 0.0;
        for a in 0..self.atoms.len() {
            for b in (a + 1)..self.atoms.len() {
                let za = self.atoms[a].z as f64;
                let zb = self.atoms[b].z as f64;
                e += za * zb / distance(&self.atoms[a], &self.atoms[b]);
            }
        }
        e
    }

    /// Gradient of the nuclear repulsion energy with respect to each nuclear
    /// coordinate, in Hartree/Bohr. Shape: `[n_atoms][3]`.
    pub fn nuclear_repulsion_gradient(&self) -> Vec<[f64; 3]> {
        let mut grad = vec![[0.0; 3]; self.atoms.len()];
        for a in 0..self.atoms.len() {
            for b in (a + 1)..self.atoms.len() {
                let za = self.atoms[a].z as f64;
                let zb = self.atoms[b].z as f64;
                let r = distance(&self.atoms[a], &self.atoms[b]);
                let f = za * zb / (r * r * r);
                for k in 0..3 {
                    let d = self.atoms[a].pos[k] - self.atoms[b].pos[k];
                    grad[a][k] -= f * d;
                    grad[b][k] += f * d;
                }
            }
        }
        grad
    }

    /// Mass-weighted centre of the molecule, in Bohr.
    pub fn center_of_mass(&self) -> [f64; 3] {
        let mut total = 0.0;
        let mut c = [0.0; 3];
        for atom in &self.atoms {
            let m = element::get(atom.z).map(|e| e.mass).unwrap_or(1.0);
            total += m;
            for k in 0..3 {
                c[k] += m * atom.pos[k];
            }
        }
        for k in 0..3 {
            c[k] /= total;
        }
        c
    }

    /// Flattened coordinates in Bohr, `[x0, y0, z0, x1, ...]`. Used by the
    /// geometry optimizer, which works on a plain vector.
    pub fn coords(&self) -> Vec<f64> {
        self.atoms.iter().flat_map(|a| a.pos).collect()
    }

    /// Replaces all coordinates from a flattened vector in Bohr.
    pub fn set_coords(&mut self, coords: &[f64]) {
        debug_assert_eq!(coords.len(), self.atoms.len() * 3);
        for (i, atom) in self.atoms.iter_mut().enumerate() {
            atom.pos = [coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]];
        }
    }
}

fn distance(a: &Atom, b: &Atom) -> f64 {
    let dx = a.pos[0] - b.pos[0];
    let dy = a.pos[1] - b.pos[1];
    let dz = a.pos[2] - b.pos[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    /// Experimental water geometry, in Angstrom.
    fn water() -> Molecule {
        Molecule::from_angstrom(&[
            (8, [0.000_000, 0.000_000, 0.117_300]),
            (1, [0.000_000, 0.757_200, -0.469_300]),
            (1, [0.000_000, -0.757_200, -0.469_300]),
        ])
        .unwrap()
    }

    #[test]
    fn water_has_ten_electrons_and_is_a_singlet() {
        let mol = water();
        assert_eq!(mol.n_electrons(), 10);
        assert_eq!(mol.multiplicity, 1);
        assert_eq!(mol.spin_occupation(), Some((5, 5)));
    }

    #[test]
    fn h2_nuclear_repulsion_is_exact() {
        // Two protons one Bohr apart: Z_a Z_b / r = 1 exactly.
        let h2 = Molecule::new(vec![
            Atom { z: 1, pos: [0.0, 0.0, 0.0] },
            Atom { z: 1, pos: [0.0, 0.0, 1.0] },
        ])
        .unwrap();
        assert_relative_eq!(h2.nuclear_repulsion(), 1.0, epsilon = 1e-12);
    }

    #[test]
    fn water_nuclear_repulsion_matches_longhand_sum() {
        // Recomputed from the three pair distances written out explicitly, so a
        // bug in the pair loop or in the Angstrom conversion shows up here.
        let mol = water();
        let r = |a: usize, b: usize| {
            let (p, q) = (mol.atoms[a].pos, mol.atoms[b].pos);
            ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
        };
        let expected = 8.0 / r(0, 1) + 8.0 / r(0, 2) + 1.0 / r(1, 2);
        assert_relative_eq!(mol.nuclear_repulsion(), expected, epsilon = 1e-12);
        // O-H bond length of this geometry is 0.9578 A = 1.8100 Bohr.
        assert_relative_eq!(r(0, 1), 1.810_049, epsilon = 1e-5);
    }

    #[test]
    fn nuclear_repulsion_gradient_matches_finite_difference() {
        let mol = water();
        let analytic = mol.nuclear_repulsion_gradient();
        let h = 1e-6;
        for a in 0..mol.n_atoms() {
            for k in 0..3 {
                let mut plus = mol.clone();
                let mut minus = mol.clone();
                plus.atoms[a].pos[k] += h;
                minus.atoms[a].pos[k] -= h;
                let fd = (plus.nuclear_repulsion() - minus.nuclear_repulsion()) / (2.0 * h);
                assert_relative_eq!(analytic[a][k], fd, epsilon = 1e-6);
            }
        }
    }

    #[test]
    fn oxygen_triplet_occupation() {
        let mut o2 = Molecule::from_angstrom(&[
            (8, [0.0, 0.0, 0.0]),
            (8, [0.0, 0.0, 1.208]),
        ])
        .unwrap();
        assert_eq!(o2.multiplicity, 1);
        o2.multiplicity = 3;
        assert_eq!(o2.spin_occupation(), Some((9, 7)));
        // A triplet is impossible for an odd electron count.
        o2.charge = 1;
        assert_eq!(o2.spin_occupation(), None);
    }

    #[test]
    fn invalid_geometries_are_rejected() {
        assert_eq!(Molecule::new(vec![]).unwrap_err(), GeometryError::Empty);
        assert_eq!(
            Molecule::from_angstrom(&[(26, [0.0, 0.0, 0.0])]).unwrap_err(),
            GeometryError::UnsupportedElement { z: 26 }
        );
        assert_eq!(
            Molecule::from_angstrom(&[(1, [0.0; 3]), (1, [0.0; 3])]).unwrap_err(),
            GeometryError::CoincidentAtoms { a: 0, b: 1 }
        );
    }

    #[test]
    fn coords_round_trip() {
        let mut mol = water();
        let mut coords = mol.coords();
        coords[0] += 0.5;
        mol.set_coords(&coords);
        assert_relative_eq!(mol.atoms[0].pos[0], 0.5, epsilon = 1e-12);
    }
}
