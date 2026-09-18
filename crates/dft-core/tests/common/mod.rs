//! Loaders for the reference values in `tests/data`, all produced by
//! `scripts/gen_reference.py` (PySCF + libxc). Nothing here is typed from memory.
//!
//! Shared by several test binaries, each of which uses a different part of it.
#![allow(dead_code)]

use std::path::PathBuf;

use dft_core::basis::{BasisSet, Shell};
use dft_core::molecule::{Atom, Molecule};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct RefAtom {
    pub z: u8,
    /// Bohr.
    pub pos: [f64; 3],
}

#[derive(Debug, Deserialize)]
pub struct RefShell {
    pub center: usize,
    pub l: u8,
    pub exponents: Vec<f64>,
    pub coefficients: Vec<f64>,
}

#[derive(Debug, Deserialize)]
pub struct EriSample {
    pub idx: [usize; 4],
    pub value: f64,
}

/// One-electron matrices and two-electron integrals for a fixed geometry and
/// basis, in the engine's normalisation convention.
#[derive(Debug, Deserialize)]
pub struct IntegralReference {
    pub molecule: String,
    pub basis: String,
    pub cartesian: bool,
    pub atoms: Vec<RefAtom>,
    pub shells: Vec<RefShell>,
    pub ao_labels: Vec<String>,
    pub nbf: usize,
    pub nuclear_repulsion: f64,
    pub overlap: Vec<f64>,
    pub kinetic: Vec<f64>,
    pub nuclear: Vec<f64>,
    #[serde(default)]
    pub eri_full: Option<Vec<f64>>,
    pub eri_samples: Vec<EriSample>,
}

/// Converged SVWN5/STO-3G results with the energy broken down term by term.
#[derive(Debug, Deserialize)]
pub struct ScfReference {
    pub molecule: String,
    pub atoms: Vec<RefAtom>,
    pub n_electrons: usize,
    pub nbf: usize,
    pub nuclear_repulsion: f64,
    pub energy: f64,
    pub e_core: f64,
    pub e_coulomb: f64,
    pub e_xc: f64,
    pub mo_energies: Vec<f64>,
    pub homo: f64,
    #[serde(default)]
    pub density_matrix: Option<Vec<f64>>,
    /// The same energy on PySCF's default (level 3) grid: the gap to `energy`
    /// bounds how much of any disagreement can be quadrature.
    pub energy_grid_level_3: f64,
}

#[derive(Debug, Deserialize)]
pub struct AtomReference {
    pub symbol: String,
    pub z: u8,
    pub n_electrons: usize,
    pub nbf: usize,
    pub energy: f64,
}

#[derive(Debug, Deserialize)]
pub struct AtomicReferences {
    pub atoms: Vec<AtomReference>,
}

/// One open-shell (or, for a comparison case, closed-shell) reference solved
/// with UKS. The two spin channels are written out separately, alpha first.
#[derive(Debug, Deserialize)]
pub struct OpenShellReference {
    pub key: String,
    pub charge: i32,
    pub multiplicity: u32,
    pub n_alpha: usize,
    pub n_beta: usize,
    /// False for the closed-shell cases, which PySCF solved with RKS and then
    /// wrote in the same two-channel shape.
    pub unrestricted: bool,
    pub atoms: Vec<RefAtom>,
    pub nbf: usize,
    pub n_electrons: usize,
    pub nuclear_repulsion: f64,
    pub energy: f64,
    pub e_core: f64,
    pub e_coulomb: f64,
    pub e_xc: f64,
    /// Orbital energies per spin channel.
    pub mo_energies: Vec<Vec<f64>>,
    /// Density matrix per spin channel, each flattened row-major.
    pub density_matrix: Vec<Vec<f64>>,
    pub spin_squared: f64,
    pub energy_grid_level_3: f64,
}

#[derive(Debug, Deserialize)]
pub struct OpenShellReferences {
    pub systems: Vec<OpenShellReference>,
    pub atoms: Vec<OpenShellReference>,
}

impl OpenShellReferences {
    /// Every entry, molecules and atoms alike.
    pub fn all(&self) -> impl Iterator<Item = &OpenShellReference> {
        self.systems.iter().chain(&self.atoms)
    }

    pub fn get(&self, key: &str) -> &OpenShellReference {
        self.all().find(|s| s.key == key).unwrap_or_else(|| panic!("no reference {key:?}"))
    }
}

impl OpenShellReference {
    /// The geometry with the charge and multiplicity PySCF was given, so the
    /// engine solves for exactly the same state.
    pub fn molecule(&self) -> Molecule {
        let atoms = self.atoms.iter().map(|a| Atom { z: a.z, pos: a.pos }).collect();
        let mut molecule = Molecule::new(atoms).expect("reference geometry must be valid");
        molecule.charge = self.charge;
        molecule.multiplicity = self.multiplicity;
        assert_eq!(
            molecule.spin_occupation(),
            Some((self.n_alpha, self.n_beta)),
            "{}: electron counts disagree with the reference",
            self.key
        );
        molecule
    }

    /// One spin channel's reference density matrix.
    pub fn density(&self, channel: usize) -> nalgebra::DMatrix<f64> {
        nalgebra::DMatrix::from_row_slice(self.nbf, self.nbf, &self.density_matrix[channel])
    }
}

#[derive(Debug, Deserialize)]
pub struct XcUnpolarized {
    pub rho: f64,
    pub exc: f64,
    pub vrho: f64,
}

#[derive(Debug, Deserialize)]
pub struct XcPolarized {
    pub rho_a: f64,
    pub rho_b: f64,
    pub exc: f64,
    pub vrho_a: f64,
    pub vrho_b: f64,
}

#[derive(Debug, Deserialize)]
pub struct XcReference {
    pub functional: String,
    pub unpolarized: Vec<XcUnpolarized>,
    pub polarized: Vec<XcPolarized>,
}

fn data_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data").join(name)
}

pub fn load<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = data_path(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display()))
}

impl IntegralReference {
    pub fn molecule(&self) -> Molecule {
        let atoms = self.atoms.iter().map(|a| Atom { z: a.z, pos: a.pos }).collect();
        Molecule::new(atoms).expect("reference geometry must be valid")
    }

    /// Builds the basis from the reference's own shell list, so an integral test
    /// is independent of the engine's built-in STO-3G table (which
    /// `sto3g_table_matches_reference` checks separately).
    pub fn basis(&self) -> BasisSet {
        let shells = self
            .shells
            .iter()
            .map(|s| {
                Shell::new(
                    s.center,
                    self.atoms[s.center].pos,
                    s.l,
                    &s.exponents,
                    &s.coefficients,
                )
            })
            .collect();
        BasisSet::from_shells(shells)
    }

    pub fn at(&self, matrix: &[f64], i: usize, j: usize) -> f64 {
        matrix[i * self.nbf + j]
    }
}

impl ScfReference {
    pub fn molecule(&self) -> Molecule {
        let atoms = self.atoms.iter().map(|a| Atom { z: a.z, pos: a.pos }).collect();
        Molecule::new(atoms).expect("reference geometry must be valid")
    }

    /// Quadrature spread of the reference itself, a floor on any comparison.
    pub fn grid_uncertainty(&self) -> f64 {
        (self.energy - self.energy_grid_level_3).abs()
    }
}
