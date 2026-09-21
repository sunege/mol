//! What a larger basis costs this engine, stage by stage (the v3-0 measurement).
//!
//! ```text
//! cargo run --release --example basis_cost -- <input.json> [molecule ...]
//! ```
//!
//! `input.json` is `{"molecules": {name: {z: [...], xyz: [...]}}}` with `xyz`
//! flat and in Angstrom; other keys are ignored. Every molecule is run in both
//! of the engine's bases, through `System::build` like the app.
//!
//! Printed per (molecule, basis): the integration grid, the one- and
//! two-electron integrals, one SCF, one gradient, and - because a hybrid
//! functional would need it - one Coulomb and one exchange matrix built from
//! the stored tensor. The SCF starts from the atomic guess, as the app's does.
//!
//! The v3-0 table in dev-notes predates `BasisKind`: it built each basis from a
//! PySCF shell table in the input file, also ran 6-31G, and started every SCF
//! from the core Hamiltonian (the atomic guess only knew STO-3G then). Its
//! iteration counts are therefore higher than these; what carries over is the
//! cost per iteration.

use std::time::Instant;

use nalgebra::DMatrix;
use serde_json::Value;

use dft_core::basis::BasisKind;
use dft_core::grid;
use dft_core::integrals::{self, deriv};
use dft_core::molecule::Molecule;
use dft_core::opt;
use dft_core::scf::{self, ScfOptions, System};
use dft_core::gradient;

fn seconds(start: Instant) -> f64 {
    start.elapsed().as_secs_f64()
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

fn run(name: &str, molecule: &Molecule, kind: BasisKind) {
    // `System::build_with_grid` does the three stages below in one go; they are
    // repeated here on their own only to time them, and the system it returns is
    // the one everything after is measured on.
    let t = Instant::now();
    let grid = grid::build(molecule, opt::OPTIMIZER_GRID);
    let t_grid = seconds(t);

    let basis = dft_core::BasisSet::build(kind, molecule).unwrap();
    let t = Instant::now();
    let (_, kinetic) = integrals::overlap_and_kinetic(&basis);
    let _ = kinetic + integrals::nuclear_attraction(&basis, molecule);
    let t_1e = seconds(t);

    let t = Instant::now();
    let _ = integrals::compute_eri(&basis);
    let t_eri = seconds(t);

    let system = System::build_with_grid(molecule.clone(), kind, grid).unwrap();
    let mib = (system.eri.len() * 8) as f64 / (1024.0 * 1024.0);

    let t = Instant::now();
    let result = scf::run_restricted(&system, &ScfOptions::default());
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
    let basis_name = format!("{kind:?}");
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
        for kind in [BasisKind::Sto3g, BasisKind::B631Gs] {
            run(name, &molecule, kind);
        }
    }
}
