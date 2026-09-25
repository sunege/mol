//! Thin WebAssembly surface over `dft-core`.
//!
//! This module owns the unit conversion between the UI (Angstrom) and the
//! engine (Bohr), and nothing else: all physics lives in `dft-core` so it stays
//! testable on the host.

use std::ops::Range;

use dft_core::basis::BasisKind;
use dft_core::bonding::{self, DensityChannel, OrbitalRef};
use dft_core::constants::{ANGSTROM_PER_BOHR, BOHR_PER_ANGSTROM};
use dft_core::density::{self, DensityGrid, GridSpec};
use dft_core::driver::{self, DriverOptions, SpinState};
use dft_core::grid::GridQuality;
use dft_core::marching::{self, Side};
use dft_core::opt;
use dft_core::orbital::{self, OrbitalInfo};
use dft_core::scan::{self, ScanPoint};
use dft_core::scf::{guess, ScfResult, System};
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

/// How near +/-1 an orbital's mirror parity has to be before this boundary calls
/// it symmetric or antisymmetric about the molecular plane.
///
/// `dft-core` hands out the parity it measured as a real number and keeps its
/// own threshold to itself, because turning that number into a label is a
/// question about what the interface may say rather than about the physics.
/// Benzene's and ethylene's orbitals come out at +/-1.000, so anything short of
/// this is a geometry the reflection is not really a symmetry of, and the honest
/// answer there is no label at all.
const PARITY_THRESHOLD: f64 = 0.8;

/// Which of a calculation's sets of orbitals is meant: the one holding both
/// spins, or one of the two a molecule with unpaired electrons is solved as.
///
/// The names are the protocol's (`SpinChannel` in
/// `web/src/worker/protocol.ts`) and this is the only place they are read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpinChannel {
    Both,
    Up,
    Down,
}

impl SpinChannel {
    /// Reads the name a request carries. Omitted means `"both"`, which is what
    /// a closed-shell calculation has; a name this does not know is an error
    /// rather than a guess, for the same reason as in [`basis_for`].
    fn parse(name: Option<&str>) -> Result<SpinChannel, JsValue> {
        match name.unwrap_or("both") {
            "both" => Ok(SpinChannel::Both),
            "up" => Ok(SpinChannel::Up),
            "down" => Ok(SpinChannel::Down),
            other => Err(JsValue::from_str(&format!(
                "unknown spin {other:?}: expected \"both\", \"up\" or \"down\""
            ))),
        }
    }

    fn name(self) -> &'static str {
        match self {
            SpinChannel::Both => "both",
            SpinChannel::Up => "up",
            SpinChannel::Down => "down",
        }
    }

    /// Which spin the `channel`-th set of orbitals of `result` holds.
    fn of(result: &ScfResult, channel: usize) -> SpinChannel {
        match (result.is_unrestricted(), channel) {
            (false, _) => SpinChannel::Both,
            (true, 0) => SpinChannel::Up,
            (true, _) => SpinChannel::Down,
        }
    }

    /// The set of orbitals this spin names, as an index into
    /// [`ScfResult::channels`].
    ///
    /// A calculation answers to exactly one of the three names - one set holding
    /// both spins, or two holding one each - so the other two mean the caller
    /// has confused two calculations. A surface drawn from the wrong set would
    /// look like an answer, so this is an error instead.
    fn channel_in(self, result: &ScfResult) -> Result<usize, JsValue> {
        match (self, result.is_unrestricted()) {
            (SpinChannel::Both, false) => Ok(0),
            (SpinChannel::Up, true) => Ok(0),
            (SpinChannel::Down, true) => Ok(1),
            _ => Err(JsValue::from_str(&format!(
                "this calculation has no {} orbitals: it solved {}",
                self.name(),
                if result.is_unrestricted() {
                    "the two spins separately"
                } else {
                    "both spins together"
                }
            ))),
        }
    }
}

/// One rung of the orbital ladder, as `OrbitalLevel` in
/// `web/src/worker/protocol.ts`.
#[derive(Serialize)]
struct OrbitalLevelOutput {
    /// `"both"`, `"up"` or `"down"`.
    spin: &'static str,
    /// The lowest orbital on this rung, counted within its own spin channel.
    first: usize,
    /// Orbitals on it: one, or more where they are degenerate.
    count: usize,
    /// Electrons in one of them - two or zero for `"both"`, one or zero for a
    /// single spin.
    occupation: f64,
    /// Orbital energy in Hartree, which sets how high the rung is drawn and
    /// nothing else.
    ///
    /// Not a number for the screen, for the same reason as [`ScfOutput`]'s
    /// `multiplicity`: LDA's orbital energies are out by a factor of several, so
    /// the value would be wrong while the spacings built from it are right.
    energy: f64,
    /// `1`, `-1`, or `null` where the molecular plane does not sort this rung.
    parity: Option<i32>,
    /// `1` (gerade), `-1` (ungerade), or `null`: inversion through the midpoint,
    /// which only a homonuclear diatomic has. For two like atoms it is what the
    /// textbook's star means - sigma_g and pi_u bonding, sigma_u and pi_g
    /// antibonding - so the interface names the rung by it.
    inversion: Option<i32>,
    /// The rung of the other spin holding the same orbital, as an index into the
    /// array this arrives in, or `null` when there is none to name.
    partner: Option<usize>,
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
    /// The one orbital lattice kept, with the orbital and the spin it was built
    /// for, so that moving the threshold of the orbital on screen costs marching
    /// cubes alone the way a density's does.
    ///
    /// One, not one per orbital: WebAssembly's linear memory never shrinks, so
    /// every lattice held is held for the life of the worker, and an interface
    /// that walks up a ladder of thirty-six orbitals would keep all thirty-six.
    /// The spin is part of the key because it has to be - in an open-shell
    /// molecule the fifth alpha orbital and the fifth beta orbital are different
    /// orbitals, and an index alone would answer one with the other. So is the
    /// direction a degenerate set was turned to, and whether the orbital was the
    /// molecule's or one of its free atoms': see [`OrbitalKey`].
    orbital: Option<(OrbitalKey, DensityGrid)>,
}

/// Which orbital the one kept lattice was sampled from.
///
/// A free atom's orbitals share the one slot with the molecule's rather than
/// getting their own: they are drawn one at a time like any other, and a second
/// lattice would be held for the life of the worker for the same reason a
/// second molecular one would be.
#[derive(Debug, Clone, Copy, PartialEq)]
enum OrbitalKey {
    /// The `index`-th orbital of the ladder of `spin`, a degenerate set turned
    /// to face `along` when there is one (`orbital::molecular_oriented`).
    Molecular { index: usize, spin: SpinChannel, along: Option<[f64; 3]> },
    /// The `orbital`-th orbital of atom `atom` on its own, counted along its
    /// `atomLevels`, turned the same way (`orbital::atomic_column`). A free atom
    /// is solved with both spins together, so there is no spin to key it by.
    Atomic { atom: usize, orbital: usize, along: Option<[f64; 3]> },
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

    /// The ladder of orbital levels, lowest first, as a plain array for the UI
    /// (`OrbitalLevel` in `web/src/worker/protocol.ts`).
    ///
    /// Degenerate orbitals arrive as one rung rather than several: inside a
    /// degenerate set the split into individual orbitals is an arbitrary
    /// rotation, so the set is the smallest thing that is a fact about the
    /// molecule. A molecule with unpaired electrons gives two ladders, all of
    /// alpha's rungs and then all of beta's, told apart by `spin` - never folded
    /// together, because the two are genuinely different orbitals, and lined up
    /// by `partner` rather than by index because they do not even come in the
    /// same order.
    ///
    /// Cheap: a few matrix products on a calculation that is already solved, and
    /// no lattice at all.
    pub fn orbitals(&self) -> Result<JsValue, JsValue> {
        let channels = orbital::list(&self.system, &self.result);
        let groups: Vec<Vec<Range<usize>>> =
            channels.iter().map(|set| orbital::degenerate_groups(set)).collect();
        // Where each spin's rungs begin in the flattened array, which is what
        // `partner` points into.
        let mut offsets = Vec::with_capacity(groups.len());
        let mut rungs = 0;
        for set in &groups {
            offsets.push(rungs);
            rungs += set.len();
        }
        let pairing = orbital::spin_pairing(&self.system, &self.result);

        let mut levels = Vec::with_capacity(rungs);
        for (channel, set) in channels.iter().enumerate() {
            for group in &groups[channel] {
                let head = set[group.start];
                levels.push(OrbitalLevelOutput {
                    spin: SpinChannel::of(&self.result, channel).name(),
                    first: group.start,
                    count: group.len(),
                    occupation: head.occupation,
                    energy: head.energy,
                    parity: level_parity(&set[group.clone()], |info| info.parity),
                    inversion: level_parity(&set[group.clone()], |info| info.inversion),
                    partner: pairing.as_ref().and_then(|pairing| {
                        partner_level(channel, group.start, pairing, &groups, &offsets)
                    }),
                });
            }
        }

        // The contract says a missing parity or partner is `null`, and the
        // default serialiser writes `undefined` for a `None`.
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
        levels.serialize(&serializer).map_err(Into::into)
    }

    /// What orbital `index` of the ladder of `spin` does to each pair of nuclei,
    /// and where its sign changes along them (`OrbitalCharacter` in
    /// `web/src/worker/protocol.ts`).
    ///
    /// Cheap in the same way [`Calculation::orbitals`] is: sums over the basis
    /// functions of pairs of atoms, and one evaluation of the orbital per
    /// nucleus, with no lattice anywhere. It answers a change of orbital, not a
    /// change of threshold.
    ///
    /// The population is weighted by the orbital's own occupation, except that
    /// anything below one electron is read as one: an empty orbital has no
    /// population at all, and what is wanted of it is the one it would have if
    /// an electron were put in it. A single spin's orbitals hold one electron
    /// each, so an open-shell molecule's two spins are measured on the same
    /// scale either way.
    #[wasm_bindgen(js_name = orbitalCharacter)]
    pub fn orbital_character(
        &self,
        index: usize,
        spin: Option<String>,
    ) -> Result<OrbitalCharacter, JsValue> {
        let orbital = self.locate(index, SpinChannel::parse(spin.as_deref())?)?;
        let occupation = self.result.channels[orbital.channel].occupations[orbital.index].max(1.0);
        let atoms = self.system.molecule.atoms.len();
        let mut populations = Vec::with_capacity(atoms * atoms);
        for a in 0..atoms {
            for b in 0..atoms {
                populations.push(orbital::overlap_population(
                    &self.system,
                    &self.result,
                    orbital,
                    occupation,
                    a,
                    b,
                ));
            }
        }
        Ok(OrbitalCharacter {
            populations,
            amplitudes: orbital::probe_amplitudes(&self.system, &self.result, orbital),
        })
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
    /// `"orbital"` is not one of those: it draws a single orbital, `index`
    /// counting along the ladder of `spin` (`"both"`, `"up"` or `"down"`; omitted
    /// means `"both"`). Its two colours are the two signs of a wave function
    /// rather than electrons gained and lost, and the overall sign is fixed by
    /// convention so that the same orbital is coloured the same way every time it
    /// is solved (`orbital::signed_column`). Which model level an orbital may be
    /// shown for is not decided here: that is a rule about the interface, and the
    /// interface keeps it.
    ///
    /// Two more arguments belong to `"orbital"` alone. `atom` draws one of that
    /// atom's orbitals as a free atom instead of one of the molecule's - the left
    /// and right ends of a correlation diagram - with `index` counting along its
    /// `atomLevels` and `spin` ignored, since a free atom is solved with both
    /// spins together. `along` is a direction: inside a degenerate set the
    /// members are an arbitrary rotation of one another, and this turns the set
    /// so that the member drawn faces it. Only its direction is read, so it has
    /// no unit, but it has to be three numbers that are not all zero; an orbital
    /// that is not degenerate is drawn the same with or without it.
    ///
    /// The first call for a channel also samples its density, which is why it is
    /// slower than the ones that follow. The same holds for an orbital, except
    /// that only the last one asked for is kept.
    #[wasm_bindgen(js_name = isosurface)]
    pub fn isosurface(
        &mut self,
        channel: &str,
        iso_level: f64,
        index: Option<usize>,
        spin: Option<String>,
        atom: Option<usize>,
        along: Option<Vec<f64>>,
    ) -> Result<IsoMesh, JsValue> {
        if channel == "orbital" {
            let index = index.ok_or_else(|| {
                JsValue::from_str("an orbital surface needs the index of an orbital")
            })?;
            let along = direction(along.as_deref())?;
            let key = match atom {
                Some(atom) => OrbitalKey::Atomic { atom, orbital: index, along },
                None => {
                    let spin = SpinChannel::parse(spin.as_deref())?;
                    OrbitalKey::Molecular { index, spin, along }
                }
            };
            let grid = self.orbital_grid(key)?;
            return Ok(cut("orbital", grid, iso_level));
        }
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
        let position = match self.grids.iter().position(|(held, _)| *held == wanted) {
            Some(position) => position,
            None => {
                let grid = sample(&self.system, &self.result, &wanted);
                self.grids.push((wanted, grid));
                self.grids.len() - 1
            }
        };
        let (drawn, grid) = &self.grids[position];
        let name = match drawn {
            DensityChannel::Total => "total",
            DensityChannel::Pi(_) => "pi",
            DensityChannel::Deformation => "deformation",
        };
        Ok(cut(name, grid, iso_level))
    }
}

impl Calculation {
    /// The orbital an index and a spin name, or why there is none.
    ///
    /// A spin this calculation was not solved as, and an index past the end of
    /// the ladder, are both errors rather than another orbital: either would
    /// look like an answer.
    fn locate(&self, index: usize, spin: SpinChannel) -> Result<OrbitalRef, JsValue> {
        let channel = spin.channel_in(&self.result)?;
        let available = self.result.channels[channel].energies.len();
        if index >= available {
            return Err(JsValue::from_str(&format!(
                "orbital {index} is past the {available} this calculation has"
            )));
        }
        Ok(OrbitalRef { channel, index })
    }

    /// The sampled lattice of one orbital, built unless it is the one already
    /// held.
    ///
    /// Changing the threshold of the orbital on screen finds it here and costs
    /// nothing; moving to another orbital, or turning a degenerate one to face
    /// another way, replaces it, because only one is kept (see
    /// [`Calculation::orbital`]). An index past the end of the ladder, or an atom
    /// or free-atom orbital that is not there, is an error: there is no such
    /// orbital to draw.
    fn orbital_grid(&mut self, key: OrbitalKey) -> Result<&DensityGrid, JsValue> {
        let held = matches!(&self.orbital, Some((at, _)) if *at == key);
        if !held {
            let column = match key {
                OrbitalKey::Molecular { index, spin, along } => {
                    // Checked first: the engine panics on an orbital that is
                    // not there, and this is the place that says why instead.
                    let orbital = self.locate(index, spin)?;
                    orbital::molecular_oriented(&self.system, &self.result, orbital, along)
                }
                OrbitalKey::Atomic { atom, orbital, along } => {
                    orbital::atomic_column(&self.system, atom, orbital, along)
                        .map_err(|error| JsValue::from_str(&missing(error)))?
                }
            };
            let spec = GridSpec::for_molecule(&self.system.molecule);
            let grid = density::evaluate_orbital(&self.system.basis, column.as_slice(), &spec);
            self.orbital = Some((key, grid));
        }
        Ok(&self.orbital.as_ref().expect("just held or just built").1)
    }
}

/// The direction a request turns a degenerate set to, as a unit vector, or why
/// what it sent is not one.
///
/// Only the direction means anything, so it is normalised here; the engine
/// would divide by the length anyway, but a key that differs only in length
/// would then miss the lattice already held. No unit conversion is needed for
/// the same reason. What is refused is what has no direction: anything but
/// three numbers, a number that is not finite, or all three zero - which the
/// engine would quietly answer with whichever member came first.
fn direction(along: Option<&[f64]>) -> Result<Option<[f64; 3]>, JsValue> {
    let Some(along) = along else { return Ok(None) };
    let &[x, y, z] = along else {
        return Err(JsValue::from_str(&format!(
            "a direction is three numbers, not {}",
            along.len()
        )));
    };
    let length = (x * x + y * y + z * z).sqrt();
    if !length.is_finite() || length < 1e-12 {
        return Err(JsValue::from_str("a direction cannot be zero or infinite"));
    }
    Ok(Some([x / length, y / length, z / length]))
}

/// Why a free atom's orbital could not be drawn, in the words of the other
/// refusals here.
fn missing(error: orbital::OrbitalError) -> String {
    match error {
        orbital::OrbitalError::NoSuchAtom { atom, atoms } => {
            format!("atom {atom} is past the {atoms} this molecule has")
        }
        orbital::OrbitalError::NoSuchOrbital { orbital, orbitals } => {
            format!("orbital {orbital} is past the {orbitals} this atom has")
        }
    }
}

/// The level set of a sampled lattice: the region above `+iso_level`, and where
/// the field goes below zero at all the region below `-iso_level` as well.
///
/// A density has nothing under zero, so only a signed field gets the second
/// surface; asking for one anyway would just cost time. An orbital always has
/// one, unless it happens to be of one sign everywhere.
fn cut(name: &str, grid: &DensityGrid, iso_level: f64) -> IsoMesh {
    let lowest = grid.values.iter().copied().fold(f64::INFINITY, f64::min);
    let signed = lowest < -f64::EPSILON;
    let positive = surface(grid, iso_level, Side::Above);
    let negative = if signed {
        surface(grid, -iso_level, Side::Below)
    } else {
        marching::Mesh::default()
    };
    // At the level the surfaces were cut at, so the counts describe the meshes
    // beside them rather than the lattice in general.
    let (lobes_positive, lobes_negative) = density::count_lobes(grid, iso_level);

    IsoMesh {
        channel: name.to_string(),
        iso_level,
        positive,
        negative,
        density_max: grid.max(),
        density_min: lowest.min(0.0),
        lobes_positive,
        lobes_negative,
    }
}

/// Whether the molecular plane sorts a whole rung of the ladder into symmetric
/// or antisymmetric: `Some(1)`, `Some(-1)`, or `None` where it does not.
///
/// `None` covers three things that are one thing to the interface: a molecule
/// with no plane to reflect in - which is every molecule of three atoms or
/// fewer, water and O2 included - a geometry the reflection turns out not to be a
/// symmetry of, and a degenerate rung whose members disagree. The last is the
/// same argument as for showing a degenerate rung whole: within it the
/// individual orbitals are an arbitrary rotation, so a single member's parity is
/// not a fact about the rung.
///
/// The same holds for the inversion parity of a homonuclear diatomic, which
/// `parity_of` picks out instead of the mirror's.
fn level_parity(
    level: &[OrbitalInfo],
    parity_of: impl Fn(&OrbitalInfo) -> Option<f64>,
) -> Option<i32> {
    let mut sorted = None;
    for orbital in level {
        let sign = parity_sign(parity_of(orbital)?)?;
        if sorted.is_some_and(|held| held != sign) {
            return None;
        }
        sorted = Some(sign);
    }
    sorted
}

/// `1` or `-1` for a parity within [`PARITY_THRESHOLD`] of it, otherwise `None`.
fn parity_sign(parity: f64) -> Option<i32> {
    if parity >= PARITY_THRESHOLD {
        Some(1)
    } else if parity <= -PARITY_THRESHOLD {
        Some(-1)
    } else {
        None
    }
}

/// The rung of the other spin that holds the same orbital as the rung beginning
/// at `first`, as an index into the flattened ladder.
///
/// `orbital::spin_pairing` matches single orbitals, and matching the rungs by
/// their first members is enough: inside a degenerate rung the split is an
/// arbitrary rotation, so nothing finer would mean anything. Alpha's row says
/// which beta orbital it is, and beta reads the same row backwards - which is
/// single-valued because the pairing is a permutation or nothing at all.
fn partner_level(
    channel: usize,
    first: usize,
    pairing: &[Option<usize>],
    groups: &[Vec<Range<usize>>],
    offsets: &[usize],
) -> Option<usize> {
    let (other, orbital) = match channel {
        0 => (1, *pairing.get(first)?),
        _ => (0, pairing.iter().position(|matched| *matched == Some(first))),
    };
    let orbital = orbital?;
    let rung = groups.get(other)?.iter().position(|group| group.contains(&orbital))?;
    Some(offsets[other] + rung)
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

/// What one orbital does to the bonds, and where its sign changes.
///
/// Numbers rather than a verdict, because the verdict needs something the
/// engine does not have: which pairs of atoms count as bonded is the interface's
/// own guess from the geometry (`web/src/scene/bonds.ts`), so the whole matrix
/// crosses and the UI reads the pairs it draws out of it. None of it reaches the
/// screen as a number - only the sign and the size, in words (requirement F4).
#[wasm_bindgen]
pub struct OrbitalCharacter {
    populations: Vec<f64>,
    amplitudes: Option<Vec<f64>>,
}

#[wasm_bindgen]
impl OrbitalCharacter {
    /// Mulliken overlap population for every pair of nuclei, row-major over
    /// `atoms * atoms`: positive where the orbital piles electrons up between
    /// the two, negative where it pulls them out from between them, and around
    /// zero where it has nothing to do with that pair.
    #[wasm_bindgen(getter)]
    pub fn populations(&self) -> Vec<f64> {
        self.populations.clone()
    }

    /// The orbital's amplitude one Bohr off the molecular plane above each
    /// nucleus, in the order the atoms were submitted in - or nothing at all for
    /// a molecule with no plane to be above. The signs are the drawing's own.
    #[wasm_bindgen(getter)]
    pub fn amplitudes(&self) -> Option<Vec<f64>> {
        self.amplitudes.clone()
    }
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
    lobes_positive: usize,
    lobes_negative: usize,
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

    /// Separate blobs the positive surface came out in, at this same level.
    ///
    /// Counted on the lattice rather than on the mesh, which is what makes an
    /// orbital's nodes countable: two lobes of one sign with a node between them
    /// are two components here.
    #[wasm_bindgen(getter, js_name = lobesPositive)]
    pub fn lobes_positive(&self) -> usize {
        self.lobes_positive
    }

    /// The same for the negative surface; zero wherever that surface is empty.
    #[wasm_bindgen(getter, js_name = lobesNegative)]
    pub fn lobes_negative(&self) -> usize {
        self.lobes_negative
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
        orbital: None,
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
        orbital: None,
    })
}

/// One rung of one point of a distance scan, as `ScanLevel` in
/// `web/src/worker/protocol.ts`.
#[derive(Serialize)]
struct ScanLevelOutput {
    /// Orbital energy in Hartree, which sets how high the rung is drawn and
    /// nothing else - the same rule as [`OrbitalLevelOutput`]'s `energy`.
    energy: f64,
    /// Electrons in one of the orbitals on the rung.
    occupation: f64,
    /// Orbitals on the rung. For a diatomic this is what names the symmetry
    /// species - two for pi, one for sigma - which is what the lines of the
    /// figure are followed along.
    count: usize,
    /// Which set of orbitals it belongs to: always zero for a closed shell, and
    /// zero then one for a molecule with unpaired electrons, in the order
    /// [`SpinChannel::of`] reads them.
    spin: usize,
    /// Overlap population between the two nuclei, on `orbitalCharacter`'s
    /// scale: positive bonding, negative antibonding. What names a rung of two
    /// unlike atoms, which have no inversion to name it by.
    overlap: f64,
    /// `1`, `-1` or `null`, as [`OrbitalLevelOutput`]'s `inversion`. Also what
    /// a line is followed by: sigma_g and sigma_u are two species and may cross.
    inversion: Option<i32>,
}

/// One separation of a distance scan, as `ScanPoint` in
/// `web/src/worker/protocol.ts`.
#[derive(Serialize)]
struct ScanPointOutput {
    /// Distance between the two nuclei, in Angstrom - the one number of this
    /// figure that reaches the screen, because it is the same length the user
    /// is looking at in the viewer rather than a parameter of the method.
    distance: f64,
    /// Total energy in Hartree.
    energy: f64,
    converged: bool,
    levels: Vec<ScanLevelOutput>,
}

/// Solves two atoms at `points` separations evenly spaced from `from_angstrom`
/// to `to_angstrom`, handing each to `on_point` as it is produced.
///
/// The one figure that cannot be made out of a calculation already done: every
/// distance is its own SCF. It is affordable because a diatomic in the smallest
/// basis is small - hydrogen at 27 points is under half a second natively - and
/// because the scan is always solved at the level a shape is found at, which is
/// also the level whose two-orbital picture is the textbook one.
///
/// The spin state is chosen once, at the shortest distance, and held for the
/// whole scan, exactly as [`optimize`] holds it for a whole relaxation; the
/// reason is in `dft_core::scan`.
///
/// `on_point` receives `{ distance, energy, converged, levels }` with the
/// distance in Angstrom. Its return value is not read: a caller that wants to
/// stop early *throws* from it, as it does from [`optimize`]'s `on_step`, and
/// the scan ends with the points it has already handed over standing.
///
/// Nothing here holds on to a calculation, so a scan neither replaces nor
/// disturbs the one the surfaces are being drawn from.
#[wasm_bindgen(js_name = scan)]
pub fn scan(
    z: &[u8],
    from_angstrom: f64,
    to_angstrom: f64,
    points: usize,
    on_point: &js_sys::Function,
) -> Result<(), JsValue> {
    let &[first, second] = z else {
        return Err(JsValue::from_str(&format!(
            "a distance scan is of two atoms, not {}",
            z.len()
        )));
    };
    for element in [first, second] {
        if element::get(element).is_none() {
            return Err(JsValue::from_str(&format!("unsupported element {element}")));
        }
    }
    // The scan is always at the level a shape is found at, which is what the
    // interface offers it for (`docs/plan-v4.md`); as everywhere else, which
    // basis that means is decided in one place.
    let kind = basis_for(None)?;

    scan::distance_scan(
        [first, second],
        from_angstrom * BOHR_PER_ANGSTROM,
        to_angstrom * BOHR_PER_ANGSTROM,
        points,
        kind,
        &mut |point: ScanPoint| {
            let payload = ScanPointOutput {
                distance: point.distance * ANGSTROM_PER_BOHR,
                energy: point.energy,
                converged: point.converged,
                levels: point
                    .levels
                    .iter()
                    .map(|level| ScanLevelOutput {
                        energy: level.energy,
                        occupation: level.occupation,
                        count: level.count,
                        spin: level.spin,
                        overlap: level.overlap,
                        inversion: level.inversion.and_then(parity_sign),
                    })
                    .collect(),
            };
            // A callback that cannot be built or that throws stops the scan the
            // way it stops a relaxation: there is nobody left to send points to.
            // A missing inversion is `null`, as the contract says, where the
            // default serialiser would write `undefined`.
            let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
            let Ok(value) = payload.serialize(&serializer) else {
                return false;
            };
            on_point.call1(&JsValue::NULL, &value).is_ok()
        },
    );
    Ok(())
}

/// The orbital levels of each element of `z` as a free atom, in Hartree, as an
/// array of arrays.
///
/// The two ends of a correlation diagram. One column per element and not two,
/// however the molecule in the middle is solved: a free atom is solved with its
/// partly filled shell spread evenly over the degenerate orbitals, so its levels
/// are the same for both spins.
///
/// A few milliseconds per element - it is the same atomic calculation every
/// molecular SCF already starts from - and at the level the scan beside it runs
/// at.
#[wasm_bindgen(js_name = atomLevels)]
pub fn atom_levels(z: &[u8]) -> Result<JsValue, JsValue> {
    let kind = basis_for(None)?;
    let mut levels = Vec::with_capacity(z.len());
    for &element in z {
        if element::get(element).is_none() {
            return Err(JsValue::from_str(&format!("unsupported element {element}")));
        }
        levels.push(guess::atomic_levels(element, kind));
    }
    serde_wasm_bindgen::to_value(&levels).map_err(Into::into)
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
