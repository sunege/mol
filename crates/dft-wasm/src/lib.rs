//! Thin WebAssembly surface over `dft-core`.
//!
//! This module owns the unit conversion between the UI (Angstrom) and the
//! engine (Bohr), and nothing else: all physics lives in `dft-core` so it stays
//! testable on the host.

use dft_core::bonding::{self, DensityChannel};
use dft_core::constants::ANGSTROM_PER_BOHR;
use dft_core::density::{self, DensityGrid, GridSpec};
use dft_core::driver::{self, DriverOptions, SpinState};
use dft_core::grid::GridQuality;
use dft_core::marching::{self, Side};
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
    /// One sampled lattice per channel, each built on its first request and kept
    /// for the threshold changes that follow.
    total: Option<DensityGrid>,
    bonding: Option<(DensityChannel, DensityGrid)>,
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
        };
        serde_wasm_bindgen::to_value(&output).map_err(Into::into)
    }

    /// Triangulates a surface of the electron density at `iso_level`, in
    /// electrons per cubic Bohr.
    ///
    /// `channel` is what the user asked to see: `"total"` for every electron, or
    /// `"bonding"` for the electrons that made the bonds. The engine decides how
    /// to answer the second one - the pi system of a planar molecule, otherwise
    /// the deformation density - and the answer says which it chose, because the
    /// two look different enough that the UI has to explain them differently.
    ///
    /// The first call for a channel also samples its density, which is why it is
    /// slower than the ones that follow.
    #[wasm_bindgen(js_name = isosurface)]
    pub fn isosurface(&mut self, channel: &str, iso_level: f64) -> Result<IsoMesh, JsValue> {
        let (name, grid) = match channel {
            "total" => {
                let grid = self.total.get_or_insert_with(|| {
                    sample(&self.system, &self.result, &DensityChannel::Total)
                });
                ("total", &*grid)
            }
            "bonding" => {
                let entry = self.bonding.get_or_insert_with(|| {
                    let chosen = bonding::bonding_channel(&self.system, &self.result);
                    let grid = sample(&self.system, &self.result, &chosen);
                    (chosen, grid)
                });
                let name = match entry.0 {
                    DensityChannel::Pi(_) => "pi",
                    DensityChannel::Deformation => "deformation",
                    DensityChannel::Total => "total",
                };
                (name, &entry.1)
            }
            other => {
                return Err(JsValue::from_str(&format!("unknown density channel {other:?}")))
            }
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

/// Runs a Kohn-Sham LDA single point on a geometry given in Angstrom, choosing
/// the charge and spin state itself (requirement F4).
///
/// Non-convergence comes back through `summary().converged`, never as a thrown
/// error: the UI turns it into an animation rather than a message
/// (requirement F5).
#[wasm_bindgen(js_name = scf)]
pub fn scf(z: &[u8], xyz_angstrom: &[f64]) -> Result<Calculation, JsValue> {
    let molecule = build_molecule(z, xyz_angstrom)?;
    let mut system = System::build(molecule, GridQuality::Medium)
        .map_err(|e| JsValue::from_str(&format!("{e:?}")))?;
    let deadline = js_sys::Date::now() + SEARCH_BUDGET_SECONDS * 1000.0;
    let outcome = driver::solve(&mut system, &DriverOptions::default(), &mut || {
        js_sys::Date::now() < deadline
    });
    Ok(Calculation {
        system,
        result: outcome.result,
        state: outcome.state,
        attempts: outcome.attempts.len(),
        total: None,
        bonding: None,
    })
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
