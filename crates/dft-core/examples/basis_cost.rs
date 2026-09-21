//! What a larger basis costs this engine, stage by stage (the v3-0 measurement).
//!
//! ```text
//! cargo run --release --example basis_cost -- <input.json> [molecule ...]
//! ```
//!
//! `input.json` is `{"bases": {name: {z: [{l, exponents, coefficients}]}},
//! "molecules": {name: {z: [...], xyz: [...]}}, "order": [name, ...]}`, with the
//! shells straight out of PySCF:
//!
//! ```python
//! from pyscf import gto
//! from pyscf.data.elements import ELEMENTS
//! [{"l": sh[0], "exponents": [p[0] for p in sh[1:]],
//!   "coefficients": [p[1] for p in sh[1:]]}
//!  for sh in gto.basis.load("6-31g*", ELEMENTS[z])]
//! ```
//!
//! `System::build` hardcodes STO-3G, so this assembles a `System` itself from a
//! shell table supplied as JSON (generated from PySCF, like every other table
//! here). It is a measurement tool, not a route into the engine: nothing else
//! may build a basis this way.
//!
//! Printed per (molecule, basis): the integration grid, the one- and
//! two-electron integrals, one SCF, one gradient, and - because a hybrid
//! functional would need it - one Coulomb and one exchange matrix built from
//! the stored tensor. The initial guess is the core Hamiltonian in every run,
//! since the atomic guess only knows STO-3G; iteration counts are therefore
//! higher than the app's, and what to compare is the cost per iteration.

use std::time::Instant;

use nalgebra::DMatrix;
use serde_json::Value;

use dft_core::basis::{BasisSet, Shell};
use dft_core::grid;
use dft_core::integrals::{self, deriv};
use dft_core::molecule::Molecule;
use dft_core::opt;
use dft_core::scf::{self, InitialGuess, ScfOptions, System};
use dft_core::gradient;

fn seconds(start: Instant) -> f64 {
    start.elapsed().as_secs_f64()
}

/// Shells for one element, as `basis_tables.json` stores them.
fn shells_for(table: &Value, z: u8, center: usize, origin: [f64; 3]) -> Vec<Shell> {
    let defs = table
        .get(z.to_string())
        .unwrap_or_else(|| panic!("no shells tabulated for Z = {z}"))
        .as_array()
        .unwrap();
    defs.iter()
        .map(|def| {
            let l = def["l"].as_u64().unwrap() as u8;
            let e: Vec<f64> = def["exponents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            let c: Vec<f64> = def["coefficients"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            Shell::new(center, origin, l, &e, &c)
        })
        .collect()
}

fn basis_for(table: &Value, molecule: &Molecule) -> BasisSet {
    let mut shells = Vec::new();
    for (center, atom) in molecule.atoms.iter().enumerate() {
        shells.extend(shells_for(table, atom.z, center, atom.pos));
    }
    BasisSet::from_shells(shells)
}

/// Naive exchange matrix from the stored tensor: K[i,j] = sum_kl P[k,l] (ik|jl).
/// Times what a hybrid functional would add to every SCF iteration.
fn exchange(eri: &integrals::EriTensor, density: &DMatrix<f64>) -> DMatrix<f64> {
    let n = eri.n_functions();
    let mut k = DMatrix::zeros(n, n);
    for i in 0..n {
        for j in 0..=i {
            let mut sum = 0.0;
            for a in 0..n {
                for b in 0..n {
                    sum += density[(a, b)] * eri.get(i, a, j, b);
                }
            }
            k[(i, j)] = sum;
            k[(j, i)] = sum;
        }
    }
    k
}

fn run(name: &str, molecule: &Molecule, basis_name: &str, table: &Value) {
    let t = Instant::now();
    let grid = grid::build(molecule, opt::OPTIMIZER_GRID);
    let t_grid = seconds(t);

    let t = Instant::now();
    let basis = basis_for(table, molecule);
    let (overlap, kinetic) = integrals::overlap_and_kinetic(&basis);
    let core = kinetic + integrals::nuclear_attraction(&basis, molecule);
    let t_1e = seconds(t);

    let t = Instant::now();
    let eri = integrals::compute_eri(&basis);
    let t_eri = seconds(t);
    let mib = (eri.len() * 8) as f64 / (1024.0 * 1024.0);

    let system = System {
        molecule: molecule.clone(),
        basis,
        overlap,
        core,
        eri,
        grid,
        nuclear_repulsion: molecule.nuclear_repulsion(),
    };

    let options = ScfOptions { initial_guess: InitialGuess::Core, ..ScfOptions::default() };
    let t = Instant::now();
    let result = scf::run_restricted(&system, &options);
    let t_scf = seconds(t);

    let weighted = gradient::energy_weighted_density(&result);
    let t = Instant::now();
    let _ = deriv::one_electron_gradient(&system.basis, molecule, &result.density, &weighted);
    let t_g1e = seconds(t);
    let t = Instant::now();
    let _ = deriv::two_electron_gradient(
        &system.basis,
        molecule,
        &result.density,
        deriv::GRADIENT_SCREENING,
    );
    let t_g2e = seconds(t);
    let t = Instant::now();
    let _ = gradient::exchange_correlation_gradient(&system, &result);
    let t_gxc = seconds(t);

    let t = Instant::now();
    let _ = system.eri.coulomb(&result.density);
    let t_j = seconds(t);
    let t = Instant::now();
    let _ = exchange(&system.eri, &result.density);
    let t_k = seconds(t);

    let per_step = t_grid + t_1e + t_eri + t_scf + t_g1e + t_g2e + t_gxc;
    println!(
        "{name:14} {basis_name:8} n={:3} eri={:>10} ({mib:7.1} MiB) | \
         grid {t_grid:6.3}  1e {t_1e:6.3}  ERI {t_eri:7.3} | \
         SCF {t_scf:7.3} ({:2} it, E={:.6}) | \
         grad 1e {t_g1e:6.3} 2e {t_g2e:7.3} XC {t_gxc:6.3} | \
         J {t_j:6.3} K {t_k:6.3} | step {per_step:7.3}s",
        system.n_functions(),
        system.eri.len(),
        result.iterations,
        result.energy,
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("give the JSON input");
    let wanted: Vec<String> = args.collect();
    let input: Value = serde_json::from_reader(std::fs::File::open(&path).unwrap()).unwrap();

    let molecules = input["molecules"].as_object().unwrap();
    let bases = input["bases"].as_object().unwrap();
    let order: Vec<&str> = input["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();

    for (name, entry) in molecules {
        if !wanted.is_empty() && !wanted.iter().any(|w| w == name) {
            continue;
        }
        let z: Vec<u8> = entry["z"].as_array().unwrap().iter()
            .map(|v| v.as_u64().unwrap() as u8).collect();
        let xyz: Vec<f64> = entry["xyz"].as_array().unwrap().iter()
            .map(|v| v.as_f64().unwrap()).collect();
        let atoms: Vec<(u8, [f64; 3])> = z.iter().enumerate()
            .map(|(i, &zi)| (zi, [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]))
            .collect();
        let molecule = Molecule::from_angstrom(&atoms).unwrap();
        for basis_name in &order {
            if let Some(table) = bases.get(*basis_name) {
                run(name, &molecule, basis_name, table);
            }
        }
    }
}
