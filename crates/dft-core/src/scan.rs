//! The same two atoms solved over and over at different separations.
//!
//! This is the one picture in the application that cannot be made out of a
//! calculation that has already been done. A density surface, an orbital, a
//! ladder of levels - all of those are ways of reading one converged result,
//! but "what happens to the levels as the atoms approach" is a different
//! result at every distance, so the only way to draw it is to solve them all.
//! It is affordable because a diatomic in a minimal basis is small: hydrogen
//! from 0.4 to 3.0 Angstrom in 27 points is under half a second, and the
//! textbook asymmetry - the antibonding level rising further than the bonding
//! one falls - is there in the numbers.
//!
//! Two things are decided here rather than left to the caller.
//!
//! * **The spin state is chosen once, at the shortest distance, and held.**
//!   Letting [`crate::driver`] choose at every point makes the curve jump:
//!   a stretched H2 is better described by a triplet than by the closed shell
//!   it dissociates from, so the two halves of one figure would be answers to
//!   two different questions. Short bonds have no such ambiguity, which is why
//!   the choice is made at the short end. This is the same treatment a geometry
//!   optimisation gives the state, and for the same reason: it is not what is
//!   being varied.
//! * **Each point is solved from its own atomic guess**, not from the density
//!   of the point before. A scan is a set of independent answers - moving along
//!   it in the other direction has to give the same curve - and starting each
//!   one afresh is what makes that true. At 27 points it costs nothing worth
//!   saving.
//!
//! What comes back per point is the total energy and the ladder of levels, with
//! the degenerate ones grouped ([`ScanLevel::count`]). The grouping is not
//! decoration: it is how a diatomic's sigma levels are told from its pi levels,
//! since pi is doubly degenerate and sigma is not, and there is no delta in a
//! minimal basis over H-Ar. The mirror parity that labels a planar molecule's
//! pi system cannot do it here - a diatomic lies in every plane through its
//! axis, and a parity measured against one of them splits a genuinely
//! degenerate pair into +1 and -1 (dev-notes, "v4-0 の実測").
//!
//! There is no clock: `on_point` returning false is how a caller stops a scan,
//! exactly as `on_step` stops a relaxation.

use crate::basis::BasisKind;
use crate::driver::{self, DriverOptions, SpinState};
use crate::grid::GridQuality;
use crate::molecule::{Atom, GeometryError, Molecule};
use crate::orbital;
use crate::scf::{self, ScfOptions, ScfResult, System};

/// The integration grid every point of a scan is solved on.
///
/// A single point's grid rather than the optimiser's finer one: nothing here
/// differentiates the energy, and what the figure shows is the shape of a curve
/// over an Angstrom of bond length, which is orders of magnitude above the
/// quadrature noise.
pub const SCAN_GRID: GridQuality = GridQuality::Medium;

/// One rung of one point's ladder.
///
/// The same shape as an [`crate::orbital::OrbitalInfo`] grouped into a
/// degenerate level, minus everything a curve does not need: no index, because
/// a line is drawn by following the n-th level of a symmetry species from point
/// to point rather than by name, and no parity, because for a diatomic there is
/// none to be had.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScanLevel {
    /// Orbital energy in Hartree, which is the height this rung is drawn at.
    pub energy: f64,
    /// Electrons in one of the orbitals on the rung - not in the rung: two or
    /// zero when the calculation holds both spins in one set of orbitals, one
    /// or zero when it is a single spin channel.
    pub occupation: f64,
    /// Orbitals on the rung, which for a diatomic is what says which symmetry
    /// species it is: two for pi, one for sigma.
    pub count: usize,
    /// Which set of orbitals it belongs to, as an index into
    /// [`ScfResult::channels`]: always zero for a closed shell, and zero then
    /// one - alpha then beta - for a molecule with unpaired electrons.
    pub spin: usize,
}

/// One separation, solved.
#[derive(Debug, Clone, PartialEq)]
pub struct ScanPoint {
    /// Distance between the two nuclei, in Bohr.
    pub distance: f64,
    /// Total energy in Hartree.
    pub energy: f64,
    /// Whether the SCF at this distance found a self-consistent density.
    /// A point that did not is still handed over, as everywhere else in this
    /// engine: it is a gap in a curve, not an error.
    pub converged: bool,
    /// The ladder, lowest first, and for an open-shell molecule all of one
    /// spin's rungs and then all of the other's.
    pub levels: Vec<ScanLevel>,
}

/// Solves `z` at `points` separations evenly spaced from `from` to `to`, both
/// in Bohr, calling `on_point` with each as it is produced.
///
/// `on_point` returning false stops the scan where it is; the points already
/// handed over stand. Nothing is returned, because everything a caller gets is
/// what it was given point by point - a scan that is stopped half way is a
/// shorter curve rather than a failure.
///
/// A distance too small to be a molecule at all - two nuclei on top of each
/// other - is skipped rather than solved, and so is every distance when the
/// elements are ones the basis does not cover. Both come back as a scan that
/// produced no points.
pub fn distance_scan(
    z: [u8; 2],
    from: f64,
    to: f64,
    points: usize,
    kind: BasisKind,
    on_point: &mut dyn FnMut(ScanPoint) -> bool,
) {
    let distances: Vec<f64> =
        spacing(from, to, points).into_iter().filter(|&r| diatomic(z, r).is_ok()).collect();
    // Where the state is decided: the short end, where a closed shell is
    // unambiguously the answer (see the module note).
    let Some(shortest) = (0..distances.len()).min_by(|&a, &b| distances[a].total_cmp(&distances[b]))
    else {
        return;
    };

    let Some(mut system) = diatomic(z, distances[shortest])
        .ok()
        .and_then(|molecule| System::build(molecule, kind, SCAN_GRID).ok())
    else {
        return;
    };
    // The search runs to the end: it is at most a couple of SCFs on the
    // smallest geometry of the scan, and stopping it early would leave the rest
    // of the curve solved in a state nothing chose.
    let outcome = driver::solve(&mut system, &DriverOptions::default(), &mut || true);
    let state = outcome.state;
    // Choosing the state meant solving this point, so it is already done.
    let mut chosen = Some((system, outcome.result));

    for (index, &distance) in distances.iter().enumerate() {
        let solved = if index == shortest {
            chosen.take()
        } else {
            solve_at(z, distance, state, kind)
        };
        let Some((system, result)) = solved else {
            continue;
        };
        if !on_point(describe(distance, &system, &result)) {
            return;
        }
    }
}

/// The separations, in the order they are solved and reported.
///
/// A single point is the `from` end rather than the middle or an error: asking
/// for one distance is asking for that distance.
fn spacing(from: f64, to: f64, points: usize) -> Vec<f64> {
    match points {
        0 => Vec::new(),
        1 => vec![from],
        _ => (0..points)
            .map(|i| from + (to - from) * i as f64 / (points - 1) as f64)
            .collect(),
    }
}

/// The two nuclei on the z axis, `distance` Bohr apart.
fn diatomic(z: [u8; 2], distance: f64) -> Result<Molecule, GeometryError> {
    Molecule::new(vec![
        Atom { z: z[0], pos: [0.0, 0.0, 0.0] },
        Atom { z: z[1], pos: [0.0, 0.0, distance] },
    ])
}

/// Builds and solves one separation in the state the scan settled on, or `None`
/// when there is no molecule there to solve.
fn solve_at(
    z: [u8; 2],
    distance: f64,
    state: SpinState,
    kind: BasisKind,
) -> Option<(System, ScfResult)> {
    let mut molecule = diatomic(z, distance).ok()?;
    molecule.charge = state.charge;
    molecule.multiplicity = state.multiplicity;
    molecule.validate().ok()?;
    let system = System::build(molecule, kind, SCAN_GRID).ok()?;
    let options = ScfOptions::default();
    let result = if state.is_restricted() {
        scf::run_restricted(&system, &options)
    } else {
        scf::run_unrestricted(&system, &options)
    };
    Some((system, result))
}

/// One solved separation as the curve wants it: the energy, and the levels with
/// the degenerate ones gathered up.
fn describe(distance: f64, system: &System, result: &ScfResult) -> ScanPoint {
    let mut levels = Vec::new();
    for (spin, set) in orbital::list(system, result).iter().enumerate() {
        for group in orbital::degenerate_groups(set) {
            let head = set[group.start];
            levels.push(ScanLevel {
                energy: head.energy,
                occupation: head.occupation,
                count: group.len(),
                spin,
            });
        }
    }
    ScanPoint { distance, energy: result.energy, converged: result.converged, levels }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::BOHR_PER_ANGSTROM;
    use crate::scf::OCCUPIED_THRESHOLD;

    /// Scans in the unit the figures are labelled in, which is also the unit the
    /// measured table in `docs/v4/V4-7.md` is written in.
    fn scan(z: [u8; 2], from: f64, to: f64, points: usize) -> Vec<ScanPoint> {
        let mut collected = Vec::new();
        distance_scan(
            z,
            from * BOHR_PER_ANGSTROM,
            to * BOHR_PER_ANGSTROM,
            points,
            BasisKind::Sto3g,
            &mut |point| {
                collected.push(point);
                true
            },
        );
        collected
    }

    fn occupied(level: &ScanLevel) -> bool {
        level.occupation > OCCUPIED_THRESHOLD
    }

    /// The point of the whole figure, and the one the measured table covers:
    /// two hydrogens far apart have two levels at the same height, and bringing
    /// them together splits those into a bonding and an antibonding one.
    #[test]
    fn hydrogen_splits_one_level_into_a_bonding_and_an_antibonding_one() {
        let points = scan([1, 1], 0.4, 3.0, 27);
        assert_eq!(points.len(), 27);
        assert!(points.iter().all(|point| point.converged), "every separation has to solve");

        // Two orbitals in a minimal basis, neither of them degenerate: sigma
        // and sigma*, and nothing here is a pi.
        for point in &points {
            assert_eq!(point.levels.len(), 2, "at {} Bohr", point.distance);
            assert!(point.levels.iter().all(|level| level.count == 1));
        }

        // The state did not change hands along the way. A triplet is solved
        // with the two spins in separate sets of orbitals, which would show up
        // as a second channel and as one electron per orbital instead of two;
        // the closed shell the scan started from has neither.
        assert!(points.iter().all(|point| point.levels.iter().all(|level| level.spin == 0)));
        assert!(points
            .iter()
            .all(|point| point.levels.iter().filter(|level| occupied(level)).count() == 1));
        assert!(points.iter().all(|point| point.levels[0].occupation == 2.0));

        let bonding: Vec<f64> = points.iter().map(|point| point.levels[0].energy).collect();
        let antibonding: Vec<f64> = points.iter().map(|point| point.levels[1].energy).collect();

        // Close in, a gap of well over a Hartree; far out, the two levels have
        // come back together. Both figures are from the table in the ticket,
        // loosely: the measured gaps are 1.34 and 0.019 Hartree.
        assert!(antibonding[0] - bonding[0] > 1.3, "at 0.4 A: {}", antibonding[0] - bonding[0]);
        let last = points.len() - 1;
        assert!(
            antibonding[last] - bonding[last] < 0.03,
            "at 3.0 A: {}",
            antibonding[last] - bonding[last]
        );

        // And they close monotonically: pulling the atoms apart raises the
        // bonding level and lowers the antibonding one at every step.
        for i in 1..points.len() {
            assert!(bonding[i] > bonding[i - 1], "bonding level fell at point {i}");
            assert!(antibonding[i] < antibonding[i - 1], "antibonding level rose at point {i}");
        }
    }

    /// A caller stops a scan by saying so, which is the only way it can be
    /// stopped: there is no clock in here.
    #[test]
    fn a_caller_that_has_seen_enough_stops_the_scan() {
        let mut collected = Vec::new();
        distance_scan(
            [1, 1],
            0.6 * BOHR_PER_ANGSTROM,
            2.0 * BOHR_PER_ANGSTROM,
            20,
            BasisKind::Sto3g,
            &mut |point| {
                collected.push(point);
                collected.len() < 3
            },
        );
        assert_eq!(collected.len(), 3);
        // The three that did arrive are ordinary points, in order.
        assert!(collected.iter().all(|point| point.converged));
        assert!(collected[0].distance < collected[1].distance);
        assert!(collected[1].distance < collected[2].distance);
    }

    /// Nitrogen is the case that makes `count` a label rather than a number:
    /// its bonding pi pair and its empty pi* pair are degenerate, and its sigma
    /// levels are not.
    #[test]
    fn nitrogen_has_a_degenerate_level_full_and_another_empty() {
        let points = scan([7, 7], 1.0, 1.2, 3);
        let bottom = points
            .iter()
            .min_by(|a, b| a.energy.total_cmp(&b.energy))
            .expect("three points were asked for");
        assert!(bottom.converged);

        let degenerate = |full: bool| {
            bottom.levels.iter().filter(|level| level.count == 2 && occupied(level) == full).count()
        };
        assert_eq!(degenerate(true), 1, "the pi pair holding the second and third bonds");
        assert_eq!(degenerate(false), 1, "the pi* pair above it");
        // Every other level is a sigma, which is not degenerate with anything.
        assert!(bottom.levels.iter().all(|level| level.count <= 2));
        // Fourteen electrons, all in one set of orbitals.
        assert!(bottom.levels.iter().all(|level| level.spin == 0));
        let electrons: f64 =
            bottom.levels.iter().map(|level| level.count as f64 * level.occupation).sum();
        assert_eq!(electrons, 14.0);
    }

    /// Oxygen, which is why a scan has to be able to carry two spins at once:
    /// its two highest electrons sit one in each of a degenerate pair of pi*
    /// orbitals, with the same spin, and the matching rung of the other spin is
    /// empty.
    #[test]
    fn oxygen_keeps_its_two_spins_apart_with_one_pi_star_rung_half_filled() {
        let points = scan([8, 8], 1.1, 1.3, 3);
        let bottom = points
            .iter()
            .min_by(|a, b| a.energy.total_cmp(&b.energy))
            .expect("three points were asked for");
        assert!(bottom.converged);

        let ladder = |spin: usize| -> Vec<ScanLevel> {
            bottom.levels.iter().copied().filter(|level| level.spin == spin).collect()
        };
        let (up, down) = (ladder(0), ladder(1));
        assert!(!down.is_empty(), "the two spins have to be solved separately");
        assert!(bottom.levels.iter().all(|level| level.spin < 2));

        let electrons = |rungs: &[ScanLevel]| -> f64 {
            rungs.iter().map(|level| level.count as f64 * level.occupation).sum()
        };
        assert_eq!(electrons(&up), 9.0);
        assert_eq!(electrons(&down), 7.0);

        // The highest rung holding electrons in the fuller spin is the pi*
        // pair. It is not the top of that ladder - the empty sigma* is above it
        // (dev-notes, "V4-3 の実装メモ") - so it is found by looking for the
        // last occupied rung rather than by counting down from the end.
        let highest = up.iter().rposition(occupied).expect("nine electrons are in something");
        assert_eq!(up[highest].count, 2, "the two unpaired electrons share one rung");
        assert_eq!(up[highest].occupation, 1.0, "one electron each, not a pair");

        // And the same rung of the other spin is empty, which is the whole of
        // what makes oxygen a triplet. The two ladders have the same rungs in
        // the same places here, so the rung at the same position is the same
        // orbitals; `partner` on the static ladder says so too, pairing the two
        // (dev-notes, "V4-3 の実装メモ").
        assert_eq!(down.len(), up.len());
        assert_eq!(down[highest].count, 2);
        assert!(!occupied(&down[highest]), "the down pi* has to be empty");
        // Nothing below it in that ladder is empty: it is the lowest empty rung
        // of the spin that has fewer electrons.
        assert_eq!(down.iter().position(|level| !occupied(level)), Some(highest));
    }

    /// The degenerate cases of the spacing, which no figure asks for but a
    /// caller can.
    #[test]
    fn asking_for_one_distance_or_none_is_answered_literally() {
        let one = scan([1, 1], 0.74, 3.0, 1);
        assert_eq!(one.len(), 1);
        assert!((one[0].distance - 0.74 * BOHR_PER_ANGSTROM).abs() < 1e-12);

        assert!(scan([1, 1], 0.4, 3.0, 0).is_empty());
        // Two nuclei on top of each other are not a molecule, so there is
        // nothing to solve and nothing comes back.
        assert!(scan([1, 1], 0.0, 0.0, 1).is_empty());
        // Nor is an element the tables do not cover.
        assert!(scan([1, 30], 0.4, 3.0, 5).is_empty());
    }
}
