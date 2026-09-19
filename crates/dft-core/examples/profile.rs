//! Native timing breakdown for the molecules the performance target is about.
//!
//! ```text
//! cargo run --release --example profile -- [h2o|ch4|benzene|all] [--optimize]
//! ```
//!
//! Prints, per molecule, the cost of every stage the browser pays for: the
//! integration grid, the one- and two-electron integrals, the spin search, one
//! SCF on its own, and the three parts of one gradient. `--optimize` also runs a
//! whole relaxation from the preset structure, the way the "安定な形にする"
//! button does. The geometries are the UI presets (`web/src/molecules/presets.ts`),
//! so the numbers describe what a user actually presses.
//!
//! Timing is wall-clock with `std::time::Instant`; run on an otherwise idle
//! machine and take the numbers as a breakdown, not a benchmark.

use std::time::Instant;

use dft_core::driver::{self, DriverOptions};
use dft_core::gradient;
use dft_core::grid::{self, GridQuality};
use dft_core::integrals::{self, deriv};
use dft_core::molecule::Molecule;
use dft_core::opt;
use dft_core::scf::{self, ScfOptions, System};

fn water() -> Molecule {
    Molecule::from_angstrom(&[
        (8, [0.0, 0.0, 0.1173]),
        (1, [0.0, 0.7572, -0.4693]),
        (1, [0.0, -0.7572, -0.4693]),
    ])
    .unwrap()
}

fn methane() -> Molecule {
    let a = 0.6276;
    Molecule::from_angstrom(&[
        (6, [0.0, 0.0, 0.0]),
        (1, [a, a, a]),
        (1, [-a, -a, a]),
        (1, [-a, a, -a]),
        (1, [a, -a, -a]),
    ])
    .unwrap()
}

/// The UI's idealised ring: C-C 1.39 A, C-H 1.09 A.
fn benzene() -> Molecule {
    let mut atoms = Vec::new();
    let (r_c, r_h) = (1.39, 1.39 + 1.09);
    for i in 0..6 {
        let angle = i as f64 * std::f64::consts::PI / 3.0;
        atoms.push((6, [r_c * angle.cos(), r_c * angle.sin(), 0.0]));
    }
    for i in 0..6 {
        let angle = i as f64 * std::f64::consts::PI / 3.0;
        atoms.push((1, [r_h * angle.cos(), r_h * angle.sin(), 0.0]));
    }
    Molecule::from_angstrom(&atoms).unwrap()
}

fn seconds(start: Instant) -> f64 {
    start.elapsed().as_secs_f64()
}

fn profile(name: &str, molecule: Molecule, optimize: bool) {
    println!("== {name} ==");
    for quality in [GridQuality::Medium, opt::OPTIMIZER_GRID] {
        let t = Instant::now();
        let grid = grid::build(&molecule, quality);
        let t_grid = seconds(t);

        let t = Instant::now();
        let basis = dft_core::BasisSet::sto3g(&molecule).unwrap();
        let _ = integrals::compute_eri(&basis);
        let t_eri = seconds(t);

        let t = Instant::now();
        let mut system = System::build_with_grid(molecule.clone(), grid.clone()).unwrap();
        let t_build = seconds(t);

        let t = Instant::now();
        let outcome = driver::solve(&mut system, &DriverOptions::default(), &mut || true);
        let t_search = seconds(t);
        let attempts: Vec<String> = outcome
            .attempts
            .iter()
            .map(|a| format!("M={} {}it {:.9}", a.state.multiplicity, a.iterations, a.energy))
            .collect();

        let t = Instant::now();
        let single = if system.molecule.multiplicity == 1 {
            scf::run_restricted(&system, &ScfOptions::default())
        } else {
            scf::run_unrestricted(&system, &ScfOptions::default())
        };
        let t_scf = seconds(t);

        let result = &outcome.result;
        let weighted = gradient::energy_weighted_density(result);
        let t = Instant::now();
        let molecule = &system.molecule;
        let _ = deriv::one_electron_gradient(&system.basis, molecule, &result.density, &weighted);
        let t_1e = seconds(t);
        let t = Instant::now();
        let _ = deriv::two_electron_gradient(
            &system.basis,
            &system.molecule,
            &result.density,
            deriv::GRADIENT_SCREENING,
        );
        let t_2e = seconds(t);
        let t = Instant::now();
        let _ = gradient::exchange_correlation_gradient(&system, result);
        let t_xc = seconds(t);

        println!(
            "{quality:?}: {} points | grid {:.3}s  ERI {:.3}s  build(total) {:.3}s | \
             search {:.3}s [{}] | SCF {:.3}s ({} it, E = {:.8}) | \
             grad 1e {:.4}s  2e {:.3}s  XC {:.3}s",
            grid.len(),
            t_grid,
            t_eri,
            t_build,
            t_search,
            attempts.join(", "),
            t_scf,
            single.iterations,
            single.energy,
            t_1e,
            t_2e,
            t_xc,
        );
    }

    if optimize {
        // The same sequence as `dft_wasm::optimize`: choose the state on the
        // medium grid, solve it again on the optimiser's.
        let t = Instant::now();
        let fine = grid::build(&molecule, opt::OPTIMIZER_GRID);
        let mut system = System::build(molecule.clone(), GridQuality::Medium).unwrap();
        let outcome =
            driver::solve_then_refine(&mut system, fine, &DriverOptions::default(), &mut || true);
        let t_start = seconds(t);
        let mut last = Instant::now();
        let relaxation = opt::relax(
            system,
            &opt::Options::default(),
            Some(outcome.result),
            &mut |step| {
                println!(
                    "  step {:>2}: E = {:.8}  max|F| = {:.2e}  (+{:.2}s)",
                    step.index,
                    step.energy,
                    step.max_force,
                    seconds(last)
                );
                last = Instant::now();
                true
            },
        );
        println!(
            "optimize: {:?} after {} steps, E = {:.8}, total {:.2}s (build + search {:.2}s)",
            relaxation.status,
            relaxation.steps,
            relaxation.energy(),
            seconds(t),
            t_start,
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let optimize = args.iter().any(|a| a == "--optimize");
    let which = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .map(String::as_str)
        .unwrap_or("all");
    let all = which == "all";
    if all || which == "h2o" {
        profile("H2O", water(), optimize);
    }
    if all || which == "ch4" {
        profile("CH4", methane(), optimize);
    }
    if all || which == "benzene" {
        profile("benzene", benzene(), optimize);
    }
}
