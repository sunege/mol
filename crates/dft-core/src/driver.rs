//! Choosing the charge and spin state the user is never asked about.
//!
//! Requirement F4 is that no DFT parameter reaches the interface: the user
//! places nuclei and the engine works out the rest. Charge is the easy half -
//! neutral, unless nothing else works - and spin is the interesting one, because
//! the electron count alone does not determine it. An even number of electrons
//! is *usually* a closed shell, but O2 is not: its two highest electrons sit in
//! a degenerate pair of orbitals and stay unpaired, and the triplet is 0.07
//! Hartree below the singlet. Nothing in the geometry says so, so the only way
//! to find out is to solve both and compare.
//!
//! The search is a sequence of rounds. Each round is a set of states to try and
//! how hard to push the SCF at them; the first round whose attempts converge
//! decides the answer, and later rounds exist only for the geometries that fail.
//! Within a round every state has the same electron count, so comparing their
//! energies is meaningful; across the charged states of the last round it would
//! not be, and there the first state that converges wins instead.
//!
//! Nothing here loops over geometries: the search runs once, on the structure as
//! placed, and the state it settles on is then held fixed. Repeating it at every
//! step of a geometry optimisation would multiply the cost of phase 5 by the
//! number of states tried.

use crate::molecule::Molecule;
use crate::scf::{self, ScfOptions, ScfResult, System};

/// A charge and spin multiplicity to solve for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpinState {
    /// Total charge in units of the elementary charge.
    pub charge: i32,
    /// Spin multiplicity `2S + 1`.
    pub multiplicity: u32,
}

impl SpinState {
    /// A multiplicity of one means every electron is paired, which is what the
    /// restricted formalism assumes; anything else needs the two spins solved
    /// separately.
    pub fn is_restricted(&self) -> bool {
        self.multiplicity == 1
    }
}

/// What one attempt produced, kept whether or not it converged.
///
/// The list of them is what lets a caller tell "every state was tried and none
/// converged" apart from "the search ran out of time", without either being an
/// error.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Attempt {
    pub state: SpinState,
    pub converged: bool,
    pub energy: f64,
    pub iterations: usize,
}

/// How hard to look.
#[derive(Debug, Clone, PartialEq)]
pub struct DriverOptions {
    /// Settings for the first, ordinary pass.
    pub scf: ScfOptions,
    /// Settings for the rounds that follow a failure: more damping and more
    /// iterations, which is slower but steadier.
    pub persistent_scf: ScfOptions,
    /// How many multiplicities above the ground-state guess to try, in steps of
    /// two, once the obvious ones have failed.
    pub extra_multiplicities: usize,
    /// Whether to try adding or removing an electron as a last resort.
    pub try_charges: bool,
}

impl Default for DriverOptions {
    fn default() -> Self {
        DriverOptions {
            scf: ScfOptions::default(),
            persistent_scf: ScfOptions {
                max_iterations: 250,
                // Heavy damping for longer: the geometries that reach this round
                // are the ones oscillating between two densities, and slowing the
                // step down is what breaks that.
                damping_iterations: 20,
                damping_factor: 0.8,
                // Damping alone does not help when the oscillation is between
                // two *occupations* rather than two densities, which is what a
                // partly filled, nearly degenerate shell gives (an aluminium or
                // silicon atom). Holding the empty orbitals up is what fixes
                // that, and it costs nothing at convergence.
                level_shift: 0.5,
                ..ScfOptions::default()
            },
            extra_multiplicities: 2,
            try_charges: true,
        }
    }
}

/// The state the search settled on and the calculation that goes with it.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// The calculation to draw and report. When nothing converged this is the
    /// first state tried - the one the electron count suggested - because its
    /// density is still the most sensible thing to show, and because a caller
    /// that wants to animate a failure (requirement F5) needs something to
    /// animate.
    pub result: ScfResult,
    pub state: SpinState,
    /// Every state tried, in order.
    pub attempts: Vec<Attempt>,
}

impl Outcome {
    pub fn converged(&self) -> bool {
        self.result.converged
    }
}

/// One round of the search.
struct Round {
    states: Vec<SpinState>,
    options: ScfOptions,
    /// Whether the states in this round can be compared by energy. They can
    /// whenever they hold the same number of electrons, which is every round but
    /// the charged one.
    comparable: bool,
}

/// Runs the search and leaves `system.molecule` carrying the state it chose.
///
/// `keep_going` is asked before each attempt after the first; returning false
/// stops the search where it is, which is how a caller imposes a wall-clock
/// budget without `dft-core` having to know what a clock is (there is no
/// `std::time` on `wasm32-unknown-unknown`). The first attempt always runs, so
/// there is always a result.
///
/// The precomputed integrals and grid in `system` depend only on the geometry,
/// never on the charge or the multiplicity, so every attempt reuses them: the
/// expensive half of a single-point calculation is paid once however many states
/// are tried.
pub fn solve(
    system: &mut System,
    options: &DriverOptions,
    keep_going: &mut dyn FnMut() -> bool,
) -> Outcome {
    let mut attempts = Vec::new();
    // The first state tried, kept as the answer if nothing ever converges.
    let mut fallback: Option<(SpinState, ScfResult)> = None;

    for round in rounds(&system.molecule, options) {
        let mut best: Option<(SpinState, ScfResult)> = None;

        for state in round.states {
            if fallback.is_some() && !keep_going() {
                break;
            }
            let Some(result) = attempt(system, state, &round.options) else {
                continue;
            };
            attempts.push(Attempt {
                state,
                converged: result.converged,
                energy: result.energy,
                iterations: result.iterations,
            });
            if fallback.is_none() {
                fallback = Some((state, result.clone()));
            }
            if !result.converged {
                continue;
            }
            let better = match &best {
                None => true,
                // Same electron count, so the lower energy is the better
                // answer; different electron counts are not comparable at all,
                // and there the order the states are tried in decides.
                Some((_, previous)) => round.comparable && result.energy < previous.energy,
            };
            if better {
                best = Some((state, result));
            }
        }

        if let Some((state, result)) = best {
            set_state(&mut system.molecule, state);
            return Outcome { result, state, attempts };
        }
    }

    let (state, result) = fallback.expect("at least one state is always possible");
    set_state(&mut system.molecule, state);
    Outcome { result, state, attempts }
}

/// Solves one state, or `None` when that state is impossible for this molecule.
fn attempt(system: &mut System, state: SpinState, options: &ScfOptions) -> Option<ScfResult> {
    if !is_possible(&system.molecule, state, system.n_functions()) {
        return None;
    }
    set_state(&mut system.molecule, state);
    Some(if state.is_restricted() {
        scf::run_restricted(system, options)
    } else {
        scf::run_unrestricted(system, options)
    })
}

fn set_state(molecule: &mut Molecule, state: SpinState) {
    molecule.charge = state.charge;
    molecule.multiplicity = state.multiplicity;
}

/// Whether a state can be occupied at all: the electron count has to have the
/// right parity for the multiplicity, and there have to be enough orbitals to
/// put the electrons in. A helium atom has one basis function in STO-3G, so its
/// triplet - which would need two spin-up electrons in two different orbitals -
/// does not exist and is skipped rather than silently solved with an electron
/// missing.
fn is_possible(molecule: &Molecule, state: SpinState, n_orbitals: usize) -> bool {
    let mut candidate = molecule.clone();
    set_state(&mut candidate, state);
    if candidate.validate().is_err() {
        return false;
    }
    match candidate.spin_occupation() {
        Some((alpha, _)) => alpha <= n_orbitals,
        None => false,
    }
}

/// The rounds, in the order they are tried.
fn rounds(molecule: &Molecule, options: &DriverOptions) -> Vec<Round> {
    let neutral = Molecule { charge: 0, ..molecule.clone() };
    let base = neutral.default_multiplicity();

    // An even electron count gets both the closed shell and the triplet, which
    // is the pair O2 has to choose between. An odd one has a single sensible
    // answer, one unpaired electron, and there is nothing to compare it with.
    let ground_states: Vec<SpinState> = if base == 1 {
        vec![
            SpinState { charge: 0, multiplicity: 1 },
            SpinState { charge: 0, multiplicity: 3 },
        ]
    } else {
        vec![SpinState { charge: 0, multiplicity: 2 }]
    };

    let mut rounds = vec![
        Round { states: ground_states.clone(), options: options.scf.clone(), comparable: true },
        // The same states again, with the SCF slowed down. A density that
        // oscillates under ordinary damping often settles under heavy damping,
        // and that is a cheaper thing to try than a different spin state.
        Round {
            states: ground_states,
            options: options.persistent_scf.clone(),
            comparable: true,
        },
    ];

    // Higher multiplicities. These are a fallback, not a search for the ground
    // state: a quartet nitrogen atom is genuinely below the doublet this driver
    // picks, but solving every multiplicity of every molecule to find that out
    // would cost more than the answer is worth in an application about watching
    // a molecule relax.
    let higher: Vec<SpinState> = (1..=options.extra_multiplicities)
        .map(|step| SpinState { charge: 0, multiplicity: base + 2 * step as u32 })
        .collect();
    if !higher.is_empty() {
        rounds.push(Round {
            states: higher,
            options: options.persistent_scf.clone(),
            comparable: true,
        });
    }

    // Last resort: an electron more or less. The two are not comparable by
    // energy - a cation is always above its neutral molecule - so whichever
    // converges first is taken, cation before anion because losing an electron
    // is the likelier fix for a structure that cannot hold them all.
    if options.try_charges {
        let charged = [1, -1]
            .into_iter()
            .map(|charge| {
                let shifted = Molecule { charge, ..molecule.clone() };
                SpinState { charge, multiplicity: shifted.default_multiplicity() }
            })
            .collect();
        rounds.push(Round {
            states: charged,
            options: options.persistent_scf.clone(),
            comparable: false,
        });
    }

    rounds
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::GridQuality;
    use crate::molecule::Atom;

    fn always() -> impl FnMut() -> bool {
        || true
    }

    fn oxygen_molecule() -> Molecule {
        Molecule::from_angstrom(&[(8, [0.0, 0.0, 0.0]), (8, [0.0, 0.0, 1.208])]).unwrap()
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
    fn the_first_round_offers_a_triplet_only_to_an_even_electron_count() {
        let options = DriverOptions::default();
        let even = rounds(&oxygen_molecule(), &options);
        assert_eq!(
            even[0].states,
            vec![
                SpinState { charge: 0, multiplicity: 1 },
                SpinState { charge: 0, multiplicity: 3 }
            ]
        );

        // A methyl radical has nine electrons: one unpaired, and no choice.
        let odd = Molecule::from_angstrom(&[
            (6, [0.0; 3]),
            (1, [1.079, 0.0, 0.0]),
            (1, [-0.5395, 0.9344, 0.0]),
            (1, [-0.5395, -0.9344, 0.0]),
        ])
        .unwrap();
        assert_eq!(
            rounds(&odd, &options)[0].states,
            vec![SpinState { charge: 0, multiplicity: 2 }]
        );
    }

    #[test]
    fn impossible_states_are_recognised() {
        // Helium: two electrons, and STO-3G gives it one orbital. A triplet
        // would need two of them.
        let helium = Molecule::new(vec![Atom { z: 2, pos: [0.0; 3] }]).unwrap();
        let singlet = SpinState { charge: 0, multiplicity: 1 };
        let triplet = SpinState { charge: 0, multiplicity: 3 };
        assert!(is_possible(&helium, singlet, 1));
        assert!(!is_possible(&helium, triplet, 1), "no room for two aligned electrons");
        // With more orbitals it becomes possible again, which is what shows the
        // check is about the basis and not about the element.
        assert!(is_possible(&helium, triplet, 2));

        // Parity: three electrons cannot be a singlet.
        let lithium = Molecule::new(vec![Atom { z: 3, pos: [0.0; 3] }]).unwrap();
        assert!(!is_possible(&lithium, singlet, 5));
        assert!(is_possible(&lithium, SpinState { charge: 0, multiplicity: 2 }, 5));

        // And a hydrogen atom has no electron left to take away.
        let hydrogen = Molecule::new(vec![Atom { z: 1, pos: [0.0; 3] }]).unwrap();
        assert!(!is_possible(&hydrogen, SpinState { charge: 1, multiplicity: 1 }, 1));
    }

    #[test]
    fn oxygen_is_found_to_be_a_triplet() {
        let mut system = System::build(oxygen_molecule(), GridQuality::Medium).unwrap();
        let outcome = solve(&mut system, &DriverOptions::default(), &mut always());
        assert!(outcome.converged());
        assert_eq!(outcome.state, SpinState { charge: 0, multiplicity: 3 });
        // Both states of the first round were tried, and the triplet won on
        // energy rather than by being tried first.
        assert_eq!(outcome.attempts.len(), 2);
        let singlet = outcome.attempts.iter().find(|a| a.state.multiplicity == 1).unwrap();
        assert!(singlet.converged, "the singlet has to converge for the comparison to mean anything");
        assert!(
            outcome.result.energy < singlet.energy,
            "chose {} Ha over the singlet's {} Ha",
            outcome.result.energy,
            singlet.energy
        );
        // And the molecule carries the state that was chosen, so a caller that
        // holds the system afterwards sees the same thing the result describes.
        assert_eq!(system.molecule.multiplicity, 3);
        assert!(outcome.result.is_unrestricted());
    }

    #[test]
    fn a_closed_shell_molecule_stays_a_singlet() {
        let mut system = System::build(water(), GridQuality::Medium).unwrap();
        let outcome = solve(&mut system, &DriverOptions::default(), &mut always());
        assert!(outcome.converged());
        assert_eq!(outcome.state, SpinState { charge: 0, multiplicity: 1 });
        assert!(!outcome.result.is_unrestricted(), "a singlet is solved restricted");
        let triplet = outcome.attempts.iter().find(|a| a.state.multiplicity == 3).unwrap();
        assert!(
            triplet.energy > outcome.result.energy,
            "water's triplet came out below its singlet"
        );
    }

    #[test]
    fn an_odd_electron_count_is_solved_unrestricted_without_a_search() {
        let mut system =
            System::build(Molecule::new(vec![Atom { z: 1, pos: [0.0; 3] }]).unwrap(), GridQuality::Medium)
                .unwrap();
        let outcome = solve(&mut system, &DriverOptions::default(), &mut always());
        assert!(outcome.converged());
        assert_eq!(outcome.state, SpinState { charge: 0, multiplicity: 2 });
        assert_eq!(outcome.attempts.len(), 1, "nothing to compare a doublet with");
        assert!(outcome.result.is_unrestricted());
    }

    /// A single atom from the periodic table picker is the simplest thing a user
    /// can do, and silicon is the one that made this round exist: its 3s and 3p
    /// levels are close enough that the first pass fails at both multiplicities.
    /// Before the level shift it fell all the way through to a quintet, 0.19
    /// Hartree above the answer; aluminium fell further still and came back as a
    /// cation. The energy is checked against PySCF in
    /// `tests/reference_open_shell.rs`; what matters here is that the search
    /// arrives at the neutral ground state rather than at something exotic.
    #[test]
    fn a_stubborn_atom_is_rescued_by_the_later_rounds() {
        let silicon = Molecule::new(vec![Atom { z: 14, pos: [0.0; 3] }]).unwrap();
        let mut system = System::build(silicon, GridQuality::Medium).unwrap();
        let outcome = solve(&mut system, &DriverOptions::default(), &mut always());
        assert!(outcome.converged());
        assert_eq!(outcome.state, SpinState { charge: 0, multiplicity: 3 });
        // It really did need the second round: the ordinary pass failed at both.
        let first_pass = &outcome.attempts[..2];
        assert!(
            first_pass.iter().all(|a| !a.converged),
            "the first round converged, so this no longer tests the escalation"
        );
    }

    #[test]
    fn a_budget_that_runs_out_still_returns_the_first_state() {
        // A clock that stops the search immediately: the first attempt runs
        // anyway, because a caller always needs something to show.
        let mut out_of_time = || false;
        let mut system = System::build(oxygen_molecule(), GridQuality::Coarse).unwrap();
        let outcome = solve(&mut system, &DriverOptions::default(), &mut out_of_time);
        assert_eq!(outcome.attempts.len(), 1);
        assert_eq!(outcome.state, SpinState { charge: 0, multiplicity: 1 });
        assert_eq!(system.molecule.multiplicity, 1);
    }

    #[test]
    fn a_hopeless_scf_falls_through_every_round_and_still_returns_a_density() {
        // One iteration is never enough to converge anything, so every state in
        // every round fails. The outcome must still carry the first state's
        // result: requirement F5 turns this into an animation, which needs a
        // molecule and a density rather than an error.
        let hopeless = ScfOptions { max_iterations: 1, ..ScfOptions::default() };
        let options = DriverOptions {
            scf: hopeless.clone(),
            persistent_scf: hopeless,
            extra_multiplicities: 1,
            try_charges: true,
        };
        let mut system = System::build(water(), GridQuality::Coarse).unwrap();
        let outcome = solve(&mut system, &options, &mut always());
        assert!(!outcome.converged());
        assert_eq!(outcome.state, SpinState { charge: 0, multiplicity: 1 });
        assert!(outcome.attempts.len() > 2, "every round should have been tried");
        assert!(outcome.attempts.iter().all(|a| !a.converged));
        // The charged states are the last thing tried, and they were reached.
        assert!(outcome.attempts.iter().any(|a| a.state.charge != 0));
        assert_eq!(outcome.result.density.nrows(), system.n_functions());
    }
}
