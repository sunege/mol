//! Thin WebAssembly surface over `dft-core`.
//!
//! This module owns the unit conversion between the UI (Angstrom) and the
//! engine (Bohr), and nothing else: all physics lives in `dft-core` so it stays
//! testable on the host.

use dft_core::basis::BasisKind;
use dft_core::bonding::{self, DensityChannel};
use dft_core::constants::{ANGSTROM_PER_BOHR, BOHR_PER_ANGSTROM};
use dft_core::density::{self, DensityGrid, GridSpec};
use dft_core::driver::{self, DriverOptions, SpinState};
use dft_core::grid::GridQuality;
use dft_core::marching::{self, Side};
use dft_core::opt;
use dft_core::scf::{ScfResult, System};
use dft_core::{element, Molecule};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Installs a panic hook that reports Rust panics to the browser console.
/// Called once when the worker boots.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Element data the UI needs for the periodic table picker and 3D rendering.
#[derive(Serialize)]
struct ElementInfo {
    z: u8,
    symbol: &'static str,
    mass: f64,
    #[serde(rename = "covalentRadius")]
    covalent_radius: f64,
    #[serde(rename = "vdwRadius")]
    vdw_radius: f64,
    color: u32,
}

/// Returns every supported element (H-Ar) as an array of objects.
#[wasm_bindgen(js_name = supportedElements)]
pub fn supported_elements() -> Result<JsValue, JsValue> {
    let list: Vec<ElementInfo> = element::all()
        .iter()
        .map(|e| ElementInfo {
            z: e.z,
            symbol: e.symbol,
            mass: e.mass,
            covalent_radius: e.covalent_radius,
            vdw_radius: e.vdw_radius,
            color: e.color,
        })
        .collect();
    serde_wasm_bindgen::to_value(&list).map_err(Into::into)
}

/// The energy split into its physical terms, all in Hartree.
#[derive(Serialize)]
struct EnergyComponents {
    core: f64,
    coulomb: f64,
    #[serde(rename = "exchangeCorrelation")]
    exchange_correlation: f64,
    #[serde(rename = "nuclearRepulsion")]
    nuclear_repulsion: f64,
}

/// How a geometry optimisation ended, as part of [`Calculation::summary`].
#[derive(Serialize, Clone)]
struct OptimizationOutput {
    /// Whether the structure reached a stationary point. Running out of steps
    /// or out of time is a normal outcome (requirement F5), not an error, and
    /// arrives here as `false` with a `reason` saying which.
    converged: bool,
    /// `"converged"`, `"maxSteps"`, `"interrupted"` or `"scf"`.
    reason: &'static str,
    /// Accepted moves, not counting the structure as it was given.
    steps: usize,
    /// The relaxed geometry in Angstrom, flattened. Only meaningful when
    /// `converged`.
    xyz: Vec<f64>,
    /// Largest remaining force, in Hartree per Angstrom.
    #[serde(rename = "maxForce")]
    max_force: f64,
}

/// One accepted geometry, handed to the caller's callback as it is produced.
#[derive(Serialize)]
struct StepOutput {
    step: usize,
    /// Coordinates in Angstrom, flattened.
    xyz: Vec<f64>,
    /// Total energy in Hartree.
    energy: f64,
    /// Largest force component, in Hartree per Angstrom.
    #[serde(rename = "maxForce")]
    max_force: f64,
}

/// The scalar part of a single-point calculation, as [`Calculation::summary`]
/// hands it to the UI.
#[derive(Serialize)]
struct ScfOutput {
    converged: bool,
    iterations: usize,
    /// The spin multiplicity the engine settled on, and the charge it used.
    ///
    /// Diagnostics, not interface: requirement F4 keeps both off the screen.
    /// They are here so a developer can confirm from the console that O2 really
    /// was treated as a triplet, and so phase 5 can hold the state fixed across
    /// an optimisation.
    multiplicity: u32,
    charge: i32,
    /// How many spin states were solved before settling on this one.
    attempts: usize,
    /// Total energy in Hartree.
    energy: f64,
    components: EnergyComponents,
    /// Gap between the highest occupied and lowest empty orbital, in Hartree.
    /// Absent when the basis has no room for an empty orbital.
    #[serde(rename = "homoLumoGap")]
    homo_lumo_gap: Option<f64>,
    #[serde(rename = "basisFunctions")]
    basis_functions: usize,
    /// Electrons the integration grid accounts for. It should equal the electron
    /// count; the difference is the quadrature error.
    #[serde(rename = "electronsOnGrid")]
    electrons_on_grid: f64,
    /// Whether this molecule has electrons standing above and below a plane.
    ///
    /// Not a DFT parameter and not hidden by requirement F4: being flat is
    /// geometry, visible on screen. It is here because only the engine can say
    /// whether the reflection really is a symmetry of these orbitals, and the
    /// interface offers the pi picture only where there is one to show.
    #[serde(rename = "hasPi")]
    has_pi: bool,
    /// Present only when this calculation came from [`optimize`].
    #[serde(skip_serializing_if = "Option::is_none")]
    optimization: Option<OptimizationOutput>,
}

/// A converged calculation, kept alive on the worker side.
///
/// The SCF is the expensive part and every surface is drawn from its density, so
/// the two are separate calls over the same handle: moving the threshold slider
/// re-runs marching cubes on a density that is already sampled, which is a few
/// milliseconds rather than seconds.
#[wasm_bindgen]
pub struct Calculation {
    system: System,
    result: ScfResult,
    state: SpinState,
    attempts: usize,
    /// How the geometry optimisation that produced this ended, when one did.
    optimization: Option<OptimizationOutput>,
    /// One sampled lattice per channel, each built on its first request and kept
    /// for the threshold changes that follow. Three at most, and fewer when two
    /// requests land on the same channel: a molecule with no pi system answers
    /// `"bonding"` with the deformation density, which is then the same lattice
    /// `"deformation"` asks for. Each is 300,000 samples, so they are looked up
    /// by channel rather than kept per request.
    grids: Vec<(DensityChannel, DensityGrid)>,
}

#[wasm_bindgen]
impl Calculation {
    /// The scalar results, as a plain object for the UI.
    pub fn summary(&self) -> Result<JsValue, JsValue> {
        let output = ScfOutput {
            converged: self.result.converged,
            iterations: self.result.iterations,
            multiplicity: self.state.multiplicity,
            charge: self.state.charge,
            attempts: self.attempts,
            energy: self.result.energy,
            components: EnergyComponents {
                core: self.result.components.core,
                coulomb: self.result.components.coulomb,
                exchange_correlation: self.result.components.exchange_correlation,
                nuclear_repulsion: self.result.components.nuclear_repulsion,
            },
            homo_lumo_gap: self.result.homo_lumo().map(|(homo, lumo)| lumo - homo),
            basis_functions: self.system.n_functions(),
            electrons_on_grid: self.result.electrons_on_grid,
            has_pi: bonding::has_pi_system(&self.system, &self.result),
            optimization: self.optimization.clone(),
        };
        serde_wasm_bindgen::to_value(&output).map_err(Into::into)
    }

    /// Triangulates a surface of the electron density at `iso_level`, in
    /// electrons per cubic Bohr.
    ///
    /// `channel` is what the user asked to see: `"total"` for every electron,
    /// `"deformation"` for the electrons that moved when the free atoms became
    /// this molecule, or `"bonding"` for the electrons that made the bonds. Only
    /// the last is a question rather than an instruction - the engine answers it
    /// with the pi system of a planar molecule and otherwise with the
    /// deformation density - and the answer always says which of the three it
    /// drew, because they look different enough that the UI has to explain them
    /// differently.
    ///
    /// The first call for a channel also samples its density, which is why it is
    /// slower than the ones that follow.
    #[wasm_bindgen(js_name = isosurface)]
    pub fn isosurface(&mut self, channel: &str, iso_level: f64) -> Result<IsoMesh, JsValue> {
        let wanted = match channel {
            "total" => DensityChannel::Total,
            "deformation" => DensityChannel::Deformation,
            "bonding" => bonding::bonding_channel(&self.system, &self.result),
            other => {
                return Err(JsValue::from_str(&format!("unknown density channel {other:?}")))
            }
        };
        // Choosing the bonding channel is a pair of matrix products and is
        // redone on every request; what is kept is the lattice behind it, which
        // is the expensive part and the reason the threshold slider is cheap.
        let index = match self.grids.iter().position(|(held, _)| *held == wanted) {
            Some(index) => index,
            None => {
                let grid = sample(&self.system, &self.result, &wanted);
                self.grids.push((wanted, grid));
                self.grids.len() - 1
            }
        };
        let (drawn, grid) = &self.grids[index];
        let name = match drawn {
            DensityChannel::Total => "total",
            DensityChannel::Pi(_) => "pi",
            DensityChannel::Deformation => "deformation",
        };

        let lowest = grid.values.iter().copied().fold(f64::INFINITY, f64::min);
        // A density has nothing below zero, so only a signed channel gets a
        // second surface. Asking for one anyway would just cost time.
        let signed = lowest < -f64::EPSILON;
        let positive = surface(grid, iso_level, Side::Above);
        let negative = if signed {
            surface(grid, -iso_level, Side::Below)
        } else {
            marching::Mesh::default()
        };

        Ok(IsoMesh {
            channel: name.to_string(),
            iso_level,
            positive,
            negative,
            density_max: grid.max(),
            density_min: lowest.min(0.0),
        })
    }
}

fn sample(system: &System, result: &ScfResult, channel: &DensityChannel) -> DensityGrid {
    let matrix = bonding::channel_density(system, result, channel);
    density::evaluate(&system.basis, &matrix, &GridSpec::for_molecule(&system.molecule))
}

/// One side of a level set, converted from Bohr to the Angstrom the UI works in.
/// Normals are directions, so a uniform scaling leaves them alone.
fn surface(grid: &DensityGrid, iso_level: f64, side: Side) -> marching::Mesh {
    let mut mesh = marching::extract_side(grid, iso_level, side);
    for coordinate in &mut mesh.positions {
        *coordinate *= ANGSTROM_PER_BOHR as f32;
    }
    mesh
}

/// The triangulated level set, laid out for GPU vertex buffers.
///
/// Two surfaces, not one: a signed density needs the region above `+isoLevel`
/// and the region below `-isoLevel` drawn separately so the UI can colour them
/// apart. For an ordinary density the second one is empty.
#[wasm_bindgen]
pub struct IsoMesh {
    channel: String,
    iso_level: f64,
    positive: marching::Mesh,
    negative: marching::Mesh,
    density_max: f64,
    density_min: f64,
}

#[wasm_bindgen]
impl IsoMesh {
    /// Which electrons this was drawn from: `"total"`, `"pi"` or
    /// `"deformation"`.
    #[wasm_bindgen(getter)]
    pub fn channel(&self) -> String {
        self.channel.clone()
    }

    /// The level cut, in electrons per cubic Bohr.
    #[wasm_bindgen(getter, js_name = isoLevel)]
    pub fn iso_level(&self) -> f64 {
        self.iso_level
    }

    /// Three coordinates per vertex, in Angstrom.
    #[wasm_bindgen(getter, js_name = positivePositions)]
    pub fn positive_positions(&self) -> Vec<f32> {
        self.positive.positions.clone()
    }

    /// Unit normals pointing away from the enclosed region.
    #[wasm_bindgen(getter, js_name = positiveNormals)]
    pub fn positive_normals(&self) -> Vec<f32> {
        self.positive.normals.clone()
    }

    /// Three vertex indices per triangle.
    #[wasm_bindgen(getter, js_name = positiveIndices)]
    pub fn positive_indices(&self) -> Vec<u32> {
        self.positive.indices.clone()
    }

    #[wasm_bindgen(getter, js_name = negativePositions)]
    pub fn negative_positions(&self) -> Vec<f32> {
        self.negative.positions.clone()
    }

    #[wasm_bindgen(getter, js_name = negativeNormals)]
    pub fn negative_normals(&self) -> Vec<f32> {
        self.negative.normals.clone()
    }

    #[wasm_bindgen(getter, js_name = negativeIndices)]
    pub fn negative_indices(&self) -> Vec<u32> {
        self.negative.indices.clone()
    }

    /// Largest sample on the lattice, which bounds the levels that can produce a
    /// positive surface at all.
    #[wasm_bindgen(getter, js_name = densityMax)]
    pub fn density_max(&self) -> f64 {
        self.density_max
    }

    /// Most negative sample, or zero for a channel that cannot go negative.
    #[wasm_bindgen(getter, js_name = densityMin)]
    pub fn density_min(&self) -> f64 {
        self.density_min
    }
}

/// Wall-clock seconds the automatic spin search may spend before giving up on
/// the states it has not tried yet.
///
/// It bounds only the search, never the first calculation, which always runs to
/// its own iteration limit: a caller that gets nothing back has nothing to draw.
/// Cancelling a calculation outright is the worker's job and is done by
/// terminating it, since a single-threaded WebAssembly computation cannot be
/// interrupted from outside.
const SEARCH_BUDGET_SECONDS: f64 = 60.0;

/// The parts of a calculation long enough to be worth naming while they run.
///
/// Reported to the caller's `on_progress(stage, step)` as each one starts. The
/// names say what the time is being spent on and nothing about how: which spin
/// states the search tries, and how many, stays inside the engine like every
/// other DFT parameter (requirement F4).
mod stage {
    /// Integrals and integration grid for the structure as given.
    pub const PREPARING: &str = "preparing";
    /// Finding how the electrons arrange themselves: the spin search, and for an
    /// optimisation the chosen state solved again on the finer grid.
    pub const SEARCHING: &str = "searching";
    /// Electrons at a geometry the optimiser is trying; `step` is its index.
    pub const SOLVING: &str = "solving";
    /// Forces on the nuclei of geometry `step`; zero is the structure as given.
    pub const FORCES: &str = "forces";
}

/// Tells the caller which part of the calculation is starting.
///
/// Only a report: a listener that throws is ignored rather than allowed to stop
/// the calculation, because nothing about the answer depends on it.
fn report(on_progress: Option<&js_sys::Function>, stage: &str, step: usize) {
    if let Some(callback) = on_progress {
        let _ = callback.call2(
            &JsValue::NULL,
            &JsValue::from_str(stage),
            &JsValue::from_f64(step as f64),
        );
    }
}

/// The basis a calculation is solved in, from the level it was asked for.
///
/// A level is named for what the user wants from the calculation - `"shape"`
/// to see what a molecule settles into, `"measure"` to read its bond lengths
/// and angles as numbers (`ModelLevel` in `web/src/worker/protocol.ts`) - and
/// that name is all that crosses the boundary: which basis it means stays
/// here, like every other DFT parameter (requirement F4).
///
/// Omitted means `"shape"`, which is what every calculation was before there
/// were levels. A name this does not know is an error rather than the default:
/// solving in a smaller basis than was asked for would put numbers on the
/// screen that claim an accuracy they do not have.
fn basis_for(level: Option<&str>) -> Result<BasisKind, JsValue> {
    match level.unwrap_or("shape") {
        "shape" => Ok(BasisKind::Sto3g),
        "measure" => Ok(BasisKind::B631Gs),
        other => Err(JsValue::from_str(&format!(
            "unknown model level {other:?}: expected \"shape\" or \"measure\""
        ))),
    }
}

/// Runs a Kohn-Sham LDA single point on a geometry given in Angstrom, choosing
/// the charge and spin state itself (requirement F4).
///
/// Non-convergence comes back through `summary().converged`, never as a thrown
/// error: the UI turns it into an animation rather than a message
/// (requirement F5).
///
/// `on_progress(stage, step)`, when given, is called as each part of the
/// calculation starts (see [`stage`]).
///
/// `level` is what the calculation is for: `"shape"` (the default) or
/// `"measure"`. Any other name throws rather than being solved at the default.
#[wasm_bindgen(js_name = scf)]
pub fn scf(
    z: &[u8],
    xyz_angstrom: &[f64],
    on_progress: Option<js_sys::Function>,
    level: Option<String>,
) -> Result<Calculation, JsValue> {
    let on_progress = on_progress.as_ref();
    let kind = basis_for(level.as_deref())?;
    let molecule = build_molecule(z, xyz_angstrom)?;
    report(on_progress, stage::PREPARING, 0);
    let mut system = System::build(molecule, kind, GridQuality::Medium)
        .map_err(|e| JsValue::from_str(&format!("{e:?}")))?;
    report(on_progress, stage::SEARCHING, 0);
    let deadline = js_sys::Date::now() + SEARCH_BUDGET_SECONDS * 1000.0;
    let outcome = driver::solve(&mut system, &DriverOptions::default(), &mut || {
        js_sys::Date::now() < deadline
    });
    Ok(Calculation {
        system,
        result: outcome.result,
        state: outcome.state,
        attempts: outcome.attempts.len(),
        optimization: None,
        grids: Vec::new(),
    })
}

/// Wall-clock seconds a geometry optimisation may run before it stops where it
/// is and reports `"interrupted"`.
///
/// A backstop against a tab left running unattended, not a policy about how long
/// an answer may take. It cannot catch a computation that hangs - it is only
/// tested between steps, so a step that never returns is never seen - and the
/// real control is the 中止 button, which terminates the worker outright.
/// All it can actually do is truncate a run that is making progress, so it is
/// set far beyond what the largest supported molecule needs. Benzene relaxes in
/// about fifteen seconds since phase 6 (it took fifteen to twenty-five minutes
/// before), so there is now room to tighten this; it has been left alone because
/// a backstop that fires on a healthy calculation is worse than one that fires
/// late.
const OPTIMIZE_BUDGET_SECONDS: f64 = 1800.0;

/// Relaxes a geometry given in Angstrom, calling `on_step` with each accepted
/// structure as it is produced (requirement F2).
///
/// The charge and spin state are chosen once, on the structure as given, and
/// held for the whole optimisation: running the search at every geometry would
/// multiply the cost by the number of states tried, and the state is not what is
/// being optimised.
///
/// `on_step` receives `{ step, xyz, energy, maxForce }` with coordinates in
/// Angstrom. Its return value is not read; a caller that wants to stop early
/// *throws* from it, and the relaxation ends where it is with `"interrupted"`
/// and the structure it had reached - which is how the candidate pool gives
/// itself a budget shorter than [`OPTIMIZE_BUDGET_SECONDS`] without a worker
/// being terminated (`web/src/search/`).
///
/// Nothing here throws at the caller: a structure the engine cannot solve comes
/// back as a calculation whose `optimization.converged` is false, which the
/// interface turns into an animation rather than a message (requirement F5).
///
/// `on_progress(stage, step)`, when given, is called as each part of the
/// calculation starts (see [`stage`]). Most of the wait before the first step is
/// in parts that move no atoms, and this is how the caller can say so.
///
/// `level` is what the calculation is for, as for [`scf`], and holds for every
/// step: the optimiser builds each new geometry in the basis of the one before.
#[wasm_bindgen(js_name = optimize)]
pub fn optimize(
    z: &[u8],
    xyz_angstrom: &[f64],
    on_step: &js_sys::Function,
    on_progress: Option<js_sys::Function>,
    level: Option<String>,
) -> Result<Calculation, JsValue> {
    let on_progress = on_progress.as_ref();
    let kind = basis_for(level.as_deref())?;
    let molecule = build_molecule(z, xyz_angstrom)?;
    report(on_progress, stage::PREPARING, 0);
    // The spin state is chosen on the grid a single point uses and only the
    // winner is solved again on the optimiser's finer one: the choice does not
    // depend on the grid, and every losing state tried on the fine grid was
    // most of the first step's cost (see `driver::solve_then_refine`).
    let fine = dft_core::grid::build(&molecule, opt::OPTIMIZER_GRID);
    let mut system = System::build(molecule, kind, GridQuality::Medium)
        .map_err(|e| JsValue::from_str(&format!("{e:?}")))?;

    report(on_progress, stage::SEARCHING, 0);
    let search_deadline = js_sys::Date::now() + SEARCH_BUDGET_SECONDS * 1000.0;
    let outcome =
        driver::solve_then_refine(&mut system, fine, &DriverOptions::default(), &mut || {
            js_sys::Date::now() < search_deadline
        });
    let state = outcome.state;
    let attempts = outcome.attempts.len();

    // The driver has already solved the starting geometry at the state it chose,
    // so hand that calculation straight to the optimiser rather than repeating
    // it. A calculation that did not converge is handed over too: the optimiser
    // recognises it and stops before moving anything, which is the outcome the
    // divergence animation is for.
    let start = outcome.result;
    let deadline = js_sys::Date::now() + OPTIMIZE_BUDGET_SECONDS * 1000.0;
    let relaxation = opt::relax(
        system,
        &opt::Options::default(),
        Some(start),
        &mut |step: opt::Step| {
            let payload = StepOutput {
                step: step.index,
                xyz: to_angstrom(step.positions),
                energy: step.energy,
                max_force: step.max_force * BOHR_PER_ANGSTROM,
            };
            // A callback that cannot be built or that throws stops the
            // relaxation the same way a budget running out does: there is
            // nobody left to send steps to.
            let Ok(value) = serde_wasm_bindgen::to_value(&payload) else {
                return false;
            };
            if on_step.call1(&JsValue::NULL, &value).is_err() {
                return false;
            }
            js_sys::Date::now() < deadline
        },
        &mut |current: opt::Stage| match current {
            opt::Stage::Solving { step } => report(on_progress, stage::SOLVING, step),
            opt::Stage::Forces { step } => report(on_progress, stage::FORCES, step),
        },
    );

    let reason = match relaxation.status {
        opt::Status::Converged => "converged",
        opt::Status::MaxSteps => "maxSteps",
        opt::Status::Interrupted => "interrupted",
        opt::Status::ScfFailed => "scf",
    };
    let optimization = OptimizationOutput {
        converged: relaxation.status.is_success(),
        reason,
        steps: relaxation.steps,
        xyz: to_angstrom(&relaxation.system.molecule.coords()),
        max_force: relaxation.max_force * BOHR_PER_ANGSTROM,
    };

    Ok(Calculation {
        system: relaxation.system,
        result: relaxation.result,
        state,
        attempts,
        optimization: Some(optimization),
        grids: Vec::new(),
    })
}

/// Bohr to Angstrom, for a flattened coordinate list crossing the boundary.
fn to_angstrom(bohr: &[f64]) -> Vec<f64> {
    bohr.iter().map(|value| value * ANGSTROM_PER_BOHR).collect()
}

fn build_molecule(z: &[u8], xyz_angstrom: &[f64]) -> Result<Molecule, JsValue> {
    if xyz_angstrom.len() != z.len() * 3 {
        return Err(JsValue::from_str(
            "coordinate array length must be three times the atom count",
        ));
    }
    let atoms: Vec<(u8, [f64; 3])> = z
        .iter()
        .enumerate()
        .map(|(i, &zi)| {
            (zi, [xyz_angstrom[3 * i], xyz_angstrom[3 * i + 1], xyz_angstrom[3 * i + 2]])
        })
        .collect();
    Molecule::from_angstrom(&atoms).map_err(|e| JsValue::from_str(&format!("{e:?}")))
}
