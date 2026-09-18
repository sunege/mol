//! Relaxing a structure to the nearest stationary point of the energy.
//!
//! Cartesian BFGS with a trust radius. Internal coordinates would converge in
//! fewer steps, but Cartesian steps are what the animation shows and what the
//! viewer consumes, and at this size the extra steps cost less than the machinery
//! would.
//!
//! Two decisions are worth stating because they are not free choices:
//!
//! * **The spin state is fixed before the first step.** [`crate::driver`] picks
//!   it once, on the structure as the user built it, and the optimiser holds it.
//!   Re-running the search at every geometry would multiply the cost by the
//!   number of states tried, and the state is not what the optimiser is looking
//!   for.
//! * **The grid is finer here than for a single point.** The gradient leaves out
//!   the derivatives of the Becke weights, and on the medium grid that omission
//!   is worth about 7e-5 Hartree/Bohr - a sixth of the force at which a
//!   structure is called relaxed. On the fine grid it is 1.2e-5, a few percent
//!   of it. Spending grid points rather than writing the term is the trade the
//!   design plan proposed, and `tests/gradients.rs` is where the numbers come
//!   from.
//!
//! Not converging is a value, not an error: running out of steps or out of
//! patience comes back as a [`Status`], and the interface turns that into an
//! animation rather than a message (requirement F5).

use nalgebra::{DMatrix, DVector};

use crate::gradient;
use crate::grid::GridQuality;
use crate::molecule::Molecule;
use crate::scf::{self, InitialGuess, ScfOptions, ScfResult, System};

/// The grid a geometry optimisation runs on. See the module note above.
pub const OPTIMIZER_GRID: GridQuality = GridQuality::Fine;

/// Starting guess for the diagonal of the Hessian, in Hartree per Bohr squared.
///
/// Roughly the curvature of a single bond stretch, which is the stiffest thing a
/// Cartesian step meets. Too large and the first step crawls; too small and it
/// overshoots into the trust radius, which is the safer way to be wrong.
const INITIAL_CURVATURE: f64 = 1.0;

/// A step is accepted if the energy does not rise by more than this, which
/// absorbs the quadrature jitter of rebuilding the grid at a new geometry.
const ENERGY_RISE_TOLERANCE: f64 = 1e-7;

/// Trust-radius retries within one step before the direction is given up on.
const MAX_REJECTIONS: usize = 3;

/// When to stop, and how hard to try.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub max_steps: usize,
    /// Largest force component, Hartree/Bohr.
    pub max_force: f64,
    /// Root-mean-square force, Hartree/Bohr.
    pub rms_force: f64,
    /// Energy change between accepted steps, Hartree.
    pub energy_change: f64,
    /// Longest step allowed at the start, in Bohr.
    pub initial_trust: f64,
    pub max_trust: f64,
    /// Below this the direction is abandoned rather than shortened again.
    pub min_trust: f64,
    pub scf: ScfOptions,
    pub quality: GridQuality,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            max_steps: 100,
            // The usual thresholds; the gradient is accurate to well under the
            // first of them on this grid.
            max_force: 4.5e-4,
            rms_force: 3.0e-4,
            energy_change: 1e-6,
            initial_trust: 0.3,
            max_trust: 0.5,
            min_trust: 0.01,
            scf: ScfOptions::default(),
            quality: OPTIMIZER_GRID,
        }
    }
}

/// How a relaxation ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Forces and energy change are all below their thresholds.
    Converged,
    /// The step limit was reached with the structure still moving.
    MaxSteps,
    /// The caller's callback asked to stop - a wall-clock budget, usually.
    Interrupted,
    /// An SCF along the way found no self-consistent density. The structure has
    /// walked somewhere the electrons cannot follow.
    ScfFailed,
}

impl Status {
    /// Whether the structure that came back is one to believe.
    pub fn is_success(self) -> bool {
        self == Status::Converged
    }
}

/// One accepted geometry, handed to the caller as it is produced.
#[derive(Debug, Clone, Copy)]
pub struct Step<'a> {
    /// Zero for the structure as given, then one per accepted move.
    pub index: usize,
    /// Flattened coordinates in Bohr.
    pub positions: &'a [f64],
    /// Total energy in Hartree.
    pub energy: f64,
    /// Largest force component in Hartree/Bohr.
    pub max_force: f64,
    pub rms_force: f64,
}

/// The end of a relaxation: the structure, its calculation, and why it stopped.
pub struct Relaxation {
    /// The system at the final geometry, ready to cut density surfaces from.
    pub system: System,
    /// The converged calculation at that geometry.
    pub result: ScfResult,
    pub status: Status,
    /// Accepted moves, not counting the starting structure.
    pub steps: usize,
    pub max_force: f64,
    pub rms_force: f64,
}

impl Relaxation {
    pub fn energy(&self) -> f64 {
        self.result.energy
    }
}

/// Relaxes `system` in place, calling `on_step` with each accepted geometry.
///
/// `system.molecule` must already carry the charge and multiplicity the driver
/// chose; they are held fixed throughout. `start`, when given, is a converged
/// calculation for the geometry as supplied, which saves repeating it.
///
/// `on_step` returning false stops the relaxation where it is, which is how a
/// caller imposes a wall-clock budget without this module needing a clock (there
/// is no `std::time` on `wasm32-unknown-unknown`).
pub fn relax(
    mut system: System,
    options: &Options,
    start: Option<ScfResult>,
    on_step: &mut dyn FnMut(Step) -> bool,
) -> Relaxation {
    let n = system.molecule.n_atoms();
    let dimension = 3 * n;

    let mut result = match start {
        Some(result) => result,
        None => single_point(&system, &options.scf),
    };
    if !result.converged {
        return finish(system, result, Status::ScfFailed, 0);
    }

    let mut coordinates = DVector::from_vec(system.molecule.coords());
    let mut forces = force_vector(&system, &result);
    let mut energy = result.energy;
    let mut inverse_hessian = DMatrix::identity(dimension, dimension) / INITIAL_CURVATURE;
    let mut trust = options.initial_trust;
    let mut energy_change = f64::INFINITY;
    let mut status = Status::MaxSteps;
    let mut accepted = 0;

    if !emit(on_step, 0, &coordinates, energy, &forces) {
        return finish(system, result, Status::Interrupted, 0);
    }

    for step in 1..=options.max_steps {
        if converged(options, &forces, energy_change, step) {
            status = Status::Converged;
            break;
        }

        // BFGS direction, shortened to the trust radius. The gradient is minus
        // the force, so the downhill direction is `H * force`.
        let mut direction = &inverse_hessian * &forces;
        let length = direction.norm();
        if length > trust {
            direction *= trust / length;
        }

        let mut moved = false;
        for _ in 0..MAX_REJECTIONS {
            let trial_coordinates = &coordinates + &direction;
            let Some(trial) = evaluate(&system, options, &result, &trial_coordinates) else {
                // The step put two nuclei on top of each other, or the SCF found
                // nothing there. Either way the direction was too long.
                trust *= 0.5;
                if trust < options.min_trust {
                    break;
                }
                direction *= 0.5;
                continue;
            };
            let (trial_system, trial_result) = trial;

            if trial_result.energy > energy + ENERGY_RISE_TOLERANCE {
                trust *= 0.5;
                if trust < options.min_trust {
                    break;
                }
                direction *= 0.5;
                continue;
            }

            // Accepted. Update the inverse Hessian from what the move revealed
            // about the curvature along it.
            let trial_forces = force_vector(&trial_system, &trial_result);
            update_inverse_hessian(&mut inverse_hessian, &direction, &(&forces - &trial_forces));

            energy_change = trial_result.energy - energy;
            system = trial_system;
            result = trial_result;
            coordinates = trial_coordinates;
            forces = trial_forces;
            energy = result.energy;
            trust = (trust * 1.3).min(options.max_trust);
            accepted = step;
            moved = true;
            break;
        }

        if !moved {
            // Nothing downhill within the shortest step worth taking. The
            // structure is at the bottom of whatever it is in, whether or not
            // the force thresholds agree.
            status = if converged(options, &forces, 0.0, step) {
                Status::Converged
            } else {
                Status::MaxSteps
            };
            break;
        }

        if !emit(on_step, step, &coordinates, energy, &forces) {
            status = Status::Interrupted;
            break;
        }
    }

    if status == Status::MaxSteps && converged(options, &forces, energy_change, accepted + 1) {
        status = Status::Converged;
    }
    finish(system, result, status, accepted)
}

/// Builds and solves a trial geometry, or `None` when it cannot be solved.
///
/// The previous density is the starting guess: after a step of a tenth of a Bohr
/// the electrons have barely moved, and starting from where they were roughly
/// halves the iterations. If that fails to converge it is tried once more from
/// the atomic guess, which is slower but knows nothing that could be wrong.
fn evaluate(
    system: &System,
    options: &Options,
    previous: &ScfResult,
    coordinates: &DVector<f64>,
) -> Option<(System, ScfResult)> {
    let mut molecule = system.molecule.clone();
    molecule.set_coords(coordinates.as_slice());
    molecule.validate().ok()?;

    let trial = System::build(molecule, options.quality).ok()?;
    let restart = ScfOptions {
        initial_guess: restart_guess(previous),
        ..options.scf.clone()
    };
    let result = single_point(&trial, &restart);
    if result.converged {
        return Some((trial, result));
    }
    let fresh = single_point(&trial, &options.scf);
    fresh.converged.then_some((trial, fresh))
}

/// The densities of a converged calculation, in the shape the restart guess
/// wants: one matrix for a restricted run, two for an unrestricted one.
fn restart_guess(result: &ScfResult) -> InitialGuess {
    match result.channels.as_slice() {
        [alpha, beta] => {
            InitialGuess::Previous(vec![alpha.density.clone(), beta.density.clone()])
        }
        _ => InitialGuess::Previous(vec![result.density.clone()]),
    }
}

fn single_point(system: &System, options: &ScfOptions) -> ScfResult {
    if system.molecule.multiplicity == 1 {
        scf::run_restricted(system, options)
    } else {
        scf::run_unrestricted(system, options)
    }
}

/// Forces - minus the gradient - as a flat vector, with the net force removed.
fn force_vector(system: &System, result: &ScfResult) -> DVector<f64> {
    let mut analytic = gradient::energy_gradient(system, result);
    gradient::remove_net_force(&mut analytic);
    DVector::from_iterator(
        3 * analytic.len(),
        analytic.iter().flat_map(|g| g.iter().map(|value| -value)),
    )
}

fn converged(options: &Options, forces: &DVector<f64>, energy_change: f64, step: usize) -> bool {
    let max = forces.amax();
    let rms = (forces.dot(forces) / forces.len() as f64).sqrt();
    max < options.max_force
        && rms < options.rms_force
        // Nothing has moved yet on the first pass, so there is no energy change
        // to judge; the forces decide on their own.
        && (step <= 1 || energy_change.abs() < options.energy_change)
}

/// BFGS update of the inverse Hessian.
///
/// `s` is the step taken and `y` the change in the *gradient* across it. The
/// update is skipped when the curvature along the step is not positive, which
/// happens near a saddle and would otherwise leave an inverse Hessian that
/// points uphill.
fn update_inverse_hessian(inverse: &mut DMatrix<f64>, s: &DVector<f64>, y: &DVector<f64>) {
    let curvature = s.dot(y);
    if curvature <= 1e-10 * s.norm() * y.norm() {
        return;
    }
    let rho = 1.0 / curvature;
    let identity = DMatrix::identity(s.len(), s.len());
    let left = &identity - (s * y.transpose()) * rho;
    let right = &identity - (y * s.transpose()) * rho;
    *inverse = &left * &*inverse * &right + (s * s.transpose()) * rho;
}

fn emit(
    on_step: &mut dyn FnMut(Step) -> bool,
    index: usize,
    coordinates: &DVector<f64>,
    energy: f64,
    forces: &DVector<f64>,
) -> bool {
    on_step(Step {
        index,
        positions: coordinates.as_slice(),
        energy,
        max_force: forces.amax(),
        rms_force: (forces.dot(forces) / forces.len() as f64).sqrt(),
    })
}

fn finish(system: System, result: ScfResult, status: Status, steps: usize) -> Relaxation {
    let (max_force, rms_force) = if result.converged {
        let analytic = gradient::energy_gradient(&system, &result);
        (gradient::max_force(&analytic), gradient::rms_force(&analytic))
    } else {
        (f64::NAN, f64::NAN)
    };
    Relaxation { system, result, status, steps, max_force, rms_force }
}

/// Bond length between two atoms of a molecule, in Bohr. Convenience for tests
/// and for anything that wants to describe a relaxed structure.
pub fn bond_length(molecule: &Molecule, a: usize, b: usize) -> f64 {
    let (p, q) = (molecule.atoms[a].pos, molecule.atoms[b].pos);
    (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f64>().sqrt()
}

/// Angle at `b` in the chain `a - b - c`, in degrees.
pub fn bond_angle(molecule: &Molecule, a: usize, b: usize, c: usize) -> f64 {
    let vector = |i: usize| {
        let (p, q) = (molecule.atoms[i].pos, molecule.atoms[b].pos);
        [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
    };
    let u = vector(a);
    let v = vector(c);
    let dot: f64 = (0..3).map(|k| u[k] * v[k]).sum();
    let norm = |w: [f64; 3]| (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
    (dot / (norm(u) * norm(v))).clamp(-1.0, 1.0).acos().to_degrees()
}
