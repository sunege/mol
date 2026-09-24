//! What there is to say about a single molecular orbital.
//!
//! [`crate::bonding`] answers "which electrons is this surface drawn from" and
//! answers it with a density matrix, which is the right shape for a picture of a
//! density but the wrong one for a picture of an orbital: squaring the
//! coefficients throws the sign away, and the sign is what makes an orbital
//! drawing say anything about bonding. So orbitals travel by a separate road,
//! made of the columns of `C` themselves:
//!
//! * the list of them, with the energy and the occupation each one carries, and
//!   its parity about the molecular plane when there is one;
//! * a fixed convention for the overall sign, because the eigenvectors come out
//!   of the diagonalisation with an arbitrary one and the colours of a drawing
//!   must not flip from one calculation to the next;
//! * which orbitals belong to the same degenerate level, which have to be shown
//!   and thought of as a set: what the diagonalisation returns inside a
//!   degenerate subspace is an arbitrary rotation of it, so a single member of
//!   the set is not a thing the molecule has;
//! * whether an orbital piles electrons up between two nuclei or pushes them
//!   apart, as a number (the Mulliken overlap population);
//! * the amplitude just off the plane at each nucleus, which is what turns a pi
//!   system's nodes into something countable.
//!
//! Open-shell results keep their two spin channels apart throughout. Alpha and
//! beta are genuinely different orbitals - in O2 the exchange splitting between
//! the same pi* orbital in the two channels is larger than several gaps between
//! neighbouring levels - and they are not even in the same order, so anything
//! that matches them up does it by overlap and not by index
//! ([`spin_pairing`]).

use std::ops::Range;

use nalgebra::DVector;

use crate::bonding::{self, OrbitalRef};
use crate::scf::{ScfResult, System, OCCUPIED_THRESHOLD};

/// Orbital energies within this of each other belong to one degenerate level,
/// in Hartree.
///
/// Measured on benzene in STO-3G (dev-notes, "v4-0 の実測"): the levels that
/// really are degenerate differ by 1e-5 Ha or less, while the closest pair of
/// genuinely different levels is 0.026 Ha apart. This sits an order of
/// magnitude above the one and two orders below the other, so nothing rests on
/// the exact figure.
///
/// A diatomic stretched far past its bond breaks this from both sides at once
/// (dev-notes, "V4-9 の実測"), and moving the figure mends neither. O2 beyond
/// 2.37 Angstrom converges to a solution whose pi pairs are split by up to
/// 8e-3 Ha, which no tolerance can join without also joining O2's two 1s
/// orbitals (2.4e-3 Ha apart at the bond length); and past 2.65 Angstrom those
/// two 1s orbitals come within 1e-4 of each other and are counted as a pair. A
/// third-row atom's two 1s orbitals sit near 1e-4 at every separation (Cl2's
/// are 1.0e-4 apart at one distance and closer at the next). What keeps the
/// distance scan out of this is the range it is asked for, not this number.
pub const DEGENERACY_TOLERANCE: f64 = 1e-4;

/// How far off the molecular plane [`probe_amplitudes`] samples, in Bohr.
///
/// The plane itself is a node of every pi orbital, so a probe standing on it
/// would read zero for all of them; it has to stand off it far enough to be out
/// of the noise and near enough to stay inside the valence region, and one Bohr
/// is comfortably inside a second-row 2p lobe. Nothing downstream reads the
/// magnitude - only which sign each nucleus carries - so the figure is a
/// vantage point rather than a measurement.
const PROBE_HEIGHT: f64 = 1.0;

/// One orbital, as much as can be said about it without evaluating it anywhere.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrbitalInfo {
    /// Index within its spin channel, counting from the lowest energy.
    pub index: usize,
    /// Orbital energy in Hartree. Only differences mean anything: LDA puts the
    /// absolute values out by a factor of several, which is why no number from
    /// here reaches the screen.
    pub energy: f64,
    /// Electrons in it: up to two when the channel stands for both spins, up to
    /// one when it is a single spin channel.
    pub occupation: f64,
    /// `<psi|sigma psi>` about the molecular plane, near +1 for an orbital
    /// symmetric about it and near -1 for a pi orbital. `None` when the
    /// molecule has no plane to reflect in.
    pub parity: Option<f64>,
    /// `<psi|i psi>` for inversion through the midpoint of a homonuclear
    /// diatomic: near +1 for a gerade orbital, near -1 for an ungerade one.
    /// `None` for every other molecule ([`bonding::inversion_matrix`]).
    pub inversion: Option<f64>,
}

impl OrbitalInfo {
    /// Whether any electron is in it, on the SCF's own threshold.
    pub fn is_occupied(&self) -> bool {
        self.occupation > OCCUPIED_THRESHOLD
    }
}

/// Every orbital of every spin channel, in the order the channels come in:
/// one list from a restricted calculation, alpha then beta from an unrestricted
/// one.
///
/// The parities are filled in only for a planar molecule, and they are computed
/// for the empty orbitals as well as the occupied ones - the reflection commutes
/// with the Kohn-Sham operator whether or not an electron is in the orbital, so
/// a pi* orbital is as cleanly labelled as a pi one. The inversion parities, by
/// the same argument, only for a homonuclear diatomic.
pub fn list(system: &System, result: &ScfResult) -> Vec<Vec<OrbitalInfo>> {
    let plane = bonding::molecular_plane(&system.molecule);
    let inversion = bonding::inversion_matrix(&system.basis, &system.molecule);
    result
        .channels
        .iter()
        .map(|set| {
            let parities = plane.map(|plane| {
                bonding::mirror_parities(&system.basis, &system.overlap, &set.coefficients, &plane)
            });
            let inversions = inversion
                .as_ref()
                .map(|u| bonding::parities_under(&system.overlap, u, &set.coefficients));
            (0..set.energies.len())
                .map(|index| OrbitalInfo {
                    index,
                    energy: set.energies[index],
                    occupation: set.occupations[index],
                    parity: parities.as_ref().map(|p| p[index]),
                    inversion: inversions.as_ref().map(|p| p[index]),
                })
                .collect()
        })
        .collect()
}

/// Which beta orbital is the same orbital as each alpha one, or `None` when the
/// two spins were not solved separately.
///
/// The two channels come from the same geometry and the same basis, so the
/// question is answered by one matrix product: `<alpha_i|S|beta_j>` is the
/// overlap of the two orbitals, and the largest entry of a row says which beta
/// orbital the alpha one is. Indices do not answer it - in O2 the alpha
/// orbitals 4, 5 and 6 are the beta orbitals 5, 6 and 4 - and neither does
/// energy, which is exactly what the pairing is wanted for: the two channels of
/// one orbital sit at visibly different heights.
///
/// A true correspondence is a permutation. Two alpha orbitals claiming the same
/// beta one means the rotation inside some degenerate subspace has made the
/// question meaningless there, and those rows come back `None` rather than with
/// a guess.
pub fn spin_pairing(system: &System, result: &ScfResult) -> Option<Vec<Option<usize>>> {
    let [alpha, beta] = result.channels.as_slice() else {
        return None;
    };
    let overlaps = alpha.coefficients.transpose() * &system.overlap * &beta.coefficients;

    let mut partner: Vec<Option<usize>> = (0..overlaps.nrows())
        .map(|i| {
            let mut best = 0;
            for j in 1..overlaps.ncols() {
                if overlaps[(i, j)].abs() > overlaps[(i, best)].abs() {
                    best = j;
                }
            }
            (overlaps.ncols() > 0).then_some(best)
        })
        .collect();

    let mut claims = vec![0usize; overlaps.ncols()];
    for &j in partner.iter().flatten() {
        claims[j] += 1;
    }
    for slot in partner.iter_mut() {
        if slot.is_some_and(|j| claims[j] > 1) {
            *slot = None;
        }
    }
    Some(partner)
}

/// The orbitals grouped into degenerate levels, as ranges of the list given.
///
/// Every orbital is in exactly one group, so a level nothing shares is a range
/// of length one. Membership is decided against the first orbital of the group
/// rather than the previous one, so a long ladder of closely spaced levels
/// cannot chain itself into a single group.
pub fn degenerate_groups(orbitals: &[OrbitalInfo]) -> Vec<Range<usize>> {
    let mut groups = Vec::new();
    let mut start = 0;
    while start < orbitals.len() {
        let mut end = start + 1;
        while end < orbitals.len()
            && (orbitals[end].energy - orbitals[start].energy).abs() <= DEGENERACY_TOLERANCE
        {
            end += 1;
        }
        groups.push(start..end);
        start = end;
    }
    groups
}

/// The coefficients of one orbital, with the overall sign fixed by convention:
/// the coefficient largest in magnitude is made positive.
///
/// An eigenvector is only defined up to its sign, and the diagonalisation picks
/// one for its own reasons, so the same molecule solved twice can come back with
/// the lobes of an orbital swapped between the two colours. This is the only
/// place that decides; ties go to the lower index, and [`ScfResult`] itself is
/// left exactly as the SCF wrote it.
pub fn signed_column(result: &ScfResult, orbital: OrbitalRef) -> DVector<f64> {
    let column = result.channels[orbital.channel].coefficients.column(orbital.index);
    let mut leader = 0;
    for mu in 1..column.len() {
        if column[mu].abs() > column[leader].abs() {
            leader = mu;
        }
    }
    let sign = if column[leader] < 0.0 { -1.0 } else { 1.0 };
    column * sign
}

/// Mulliken overlap population of one orbital between the nuclei `a` and `b`:
///
/// ```text
/// 2 n sum_{mu in A, nu in B} C_mu_i C_nu_i S_mu_nu
/// ```
///
/// Positive means the orbital piles electrons up between the two nuclei
/// (bonding), negative means it pulls them out from between them
/// (antibonding), and around zero means the orbital has nothing to do with that
/// bond - a lone pair, or a pair of atoms that are not neighbours. The factor of
/// two counts the A-B and B-A halves of the sum.
///
/// `occupation` is passed in rather than read from the result so that an empty
/// orbital can be compared with an occupied one: an orbital holding no electrons
/// has no population at all, and what is wanted of it is the population it would
/// have, so callers pass `1.0`.
pub fn overlap_population(
    system: &System,
    result: &ScfResult,
    orbital: OrbitalRef,
    occupation: f64,
    a: usize,
    b: usize,
) -> f64 {
    let column = result.channels[orbital.channel].coefficients.column(orbital.index);
    let mut sum = 0.0;
    for mu in system.basis.atom_range(a) {
        for nu in system.basis.atom_range(b) {
            sum += column[mu] * column[nu] * system.overlap[(mu, nu)];
        }
    }
    2.0 * occupation * sum
}

/// The orbital's amplitude one Bohr above each nucleus, or `None` for a molecule
/// with no plane to be above.
///
/// A pi system is a row of lobes alternating - or not - from one nucleus to the
/// next, and this is that row of signs: sampling on the plane itself would read
/// zero everywhere, since the plane is a node of every pi orbital. The signs are
/// those of [`signed_column`], so they agree with whatever a drawing of the same
/// orbital is coloured by.
pub fn probe_amplitudes(
    system: &System,
    result: &ScfResult,
    orbital: OrbitalRef,
) -> Option<Vec<f64>> {
    let plane = bonding::molecular_plane(&system.molecule)?;
    let column = signed_column(result, orbital);
    Some(
        system
            .molecule
            .atoms
            .iter()
            .map(|atom| {
                let point = [
                    atom.pos[0] + PROBE_HEIGHT * plane.normal[0],
                    atom.pos[1] + PROBE_HEIGHT * plane.normal[1],
                    atom.pos[2] + PROBE_HEIGHT * plane.normal[2],
                ];
                let phi = system.basis.evaluate(point);
                (0..phi.len()).map(|mu| column[mu] * phi[mu]).sum()
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis::BasisKind;
    use crate::density::{self, GridSpec};
    use crate::grid::GridQuality;
    use crate::molecule::Molecule;
    use crate::scf::{self, ScfOptions};
    use approx::assert_relative_eq;

    fn water() -> Molecule {
        Molecule::from_angstrom(&[
            (8, [0.0, 0.0, 0.1173]),
            (1, [0.0, 0.7572, -0.4693]),
            (1, [0.0, -0.7572, -0.4693]),
        ])
        .unwrap()
    }

    /// Planar, with the double bond along x. The lengths and the angle are
    /// roughly ethylene's; nothing here needs the geometry to be the converged
    /// one, only to be flat and to have the two carbons next to each other.
    fn ethylene() -> Molecule {
        let (cc, ch) = (1.33_f64, 1.08_f64);
        let outward = std::f64::consts::PI - 121.5_f64.to_radians();
        let (dx, dy) = (ch * outward.cos(), ch * outward.sin());
        Molecule::from_angstrom(&[
            (6, [-0.5 * cc, 0.0, 0.0]),
            (6, [0.5 * cc, 0.0, 0.0]),
            (1, [-0.5 * cc - dx, dy, 0.0]),
            (1, [-0.5 * cc - dx, -dy, 0.0]),
            (1, [0.5 * cc + dx, dy, 0.0]),
            (1, [0.5 * cc + dx, -dy, 0.0]),
        ])
        .unwrap()
    }

    fn benzene() -> Molecule {
        let mut atoms = Vec::new();
        let (rc, rh) = (1.39, 1.39 + 1.09);
        for i in 0..6 {
            let a = (i as f64) * std::f64::consts::PI / 3.0;
            atoms.push((6u8, [rc * a.cos(), rc * a.sin(), 0.0]));
        }
        for i in 0..6 {
            let a = (i as f64) * std::f64::consts::PI / 3.0;
            atoms.push((1u8, [rh * a.cos(), rh * a.sin(), 0.0]));
        }
        Molecule::from_angstrom(&atoms).unwrap()
    }

    /// Oxygen in its triplet, which is the state the driver picks for it; the
    /// multiplicity is set here rather than searched for so the test says what
    /// it is looking at.
    fn oxygen() -> Molecule {
        let mut molecule =
            Molecule::from_angstrom(&[(8, [0.0, 0.0, 0.0]), (8, [0.0, 0.0, 1.208])]).unwrap();
        molecule.multiplicity = 3;
        molecule
    }

    fn solve(molecule: Molecule) -> (System, ScfResult) {
        let system = System::build(molecule, BasisKind::Sto3g, GridQuality::Medium)
            .expect("STO-3G covers these elements");
        let unrestricted = system.molecule.multiplicity > 1;
        let result = if unrestricted {
            scf::run_unrestricted(&system, &ScfOptions::default())
        } else {
            scf::run_restricted(&system, &ScfOptions::default())
        };
        assert!(result.converged, "the SCF has to converge for any of this to mean anything");
        (system, result)
    }

    /// Deliberately coarse. The identity being checked holds at every point on
    /// its own, so a tenth of the points test exactly the same algebra.
    fn coarse_spec(system: &System) -> GridSpec {
        GridSpec::enclosing(&system.molecule, 3.0, 0.5, density::DEFAULT_MAX_POINTS)
    }

    /// The occupied orbitals of every channel, each squared and weighted by its
    /// occupation, against the total density the same lattice gets from the
    /// density matrix. Two independent routes: one goes through the columns of
    /// `C` one at a time, the other through `D` as a quadratic form.
    fn orbital_squares_match_the_density(system: &System, result: &ScfResult) {
        let spec = coarse_spec(system);
        let total = density::evaluate(&system.basis, &result.density, &spec);

        let mut summed = vec![0.0; total.values.len()];
        for (channel, set) in result.channels.iter().enumerate() {
            for index in 0..set.occupations.len() {
                if set.occupations[index] <= OCCUPIED_THRESHOLD {
                    continue;
                }
                let column = signed_column(result, OrbitalRef { channel, index });
                let psi = density::evaluate_orbital(&system.basis, column.as_slice(), &spec);
                for (k, value) in psi.values.iter().enumerate() {
                    summed[k] += set.occupations[index] * value * value;
                }
            }
        }

        let worst = summed
            .iter()
            .zip(&total.values)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        // The two routes differ by however far the last iteration's density is
        // from the one its own orbitals build, which convergence bounds; it is
        // not rounding, so the tolerance is loose in absolute terms and still
        // two orders of magnitude tighter than any real mistake.
        assert!(worst <= 1e-6 * total.max(), "worst sample differs by {worst}");
    }

    #[test]
    fn every_occupied_orbital_squared_adds_up_to_the_electron_density() {
        let (system, result) = solve(water());
        orbital_squares_match_the_density(&system, &result);
    }

    #[test]
    fn the_two_spin_channels_together_add_up_to_the_electron_density() {
        let (system, result) = solve(oxygen());
        assert!(result.is_unrestricted());
        orbital_squares_match_the_density(&system, &result);
    }

    /// What stops the colours of a drawing from swapping between one
    /// calculation of the same molecule and the next.
    #[test]
    fn the_overall_sign_of_an_orbital_is_fixed_by_convention() {
        let (_, result) = solve(water());

        for index in 0..result.channels[0].energies.len() {
            let orbital = OrbitalRef { channel: 0, index };
            let fixed = signed_column(&result, orbital);

            let leader = (0..fixed.len())
                .max_by(|&a, &b| fixed[a].abs().total_cmp(&fixed[b].abs()))
                .unwrap();
            assert!(fixed[leader] > 0.0, "orbital {index} kept a negative leading coefficient");

            // Flipping the eigenvector, which the diagonalisation is free to do,
            // has to come back to the same column.
            let mut flipped = result.clone();
            flipped.channels[0].coefficients.set_column(
                index,
                &(-result.channels[0].coefficients.column(index)),
            );
            assert_eq!(signed_column(&flipped, orbital), fixed, "orbital {index}");
        }
    }

    /// Water's highest occupied orbital is the oxygen lone pair - it has
    /// nothing to do with either bond - and the lowest empty one takes
    /// electrons out from between the nuclei.
    #[test]
    fn water_has_a_nonbonding_homo_and_an_antibonding_lumo() {
        let (system, result) = solve(water());
        let orbitals = &list(&system, &result)[0];
        // Three atoms lie in a plane whatever they do, so there is no mirror to
        // sort them by and no pi system to claim.
        assert!(orbitals.iter().all(|o| o.parity.is_none()));

        let population = |info: &OrbitalInfo| {
            let occupation = if info.is_occupied() { info.occupation } else { 1.0 };
            let orbital = OrbitalRef { channel: 0, index: info.index };
            let left = overlap_population(&system, &result, orbital, occupation, 0, 1);
            let right = overlap_population(&system, &result, orbital, occupation, 0, 2);
            // The two bonds are equivalent by symmetry, which is a check on the
            // atom ranges as much as on the population.
            assert_relative_eq!(left, right, epsilon = 1e-9);
            left
        };

        let occupied: Vec<&OrbitalInfo> = orbitals.iter().filter(|o| o.is_occupied()).collect();
        let homo = occupied.last().unwrap();
        let lumo = orbitals.iter().find(|o| !o.is_occupied()).unwrap();

        assert!(population(&orbitals[1]) > 0.1, "the O-H bonding orbitals hold the bonds together");
        assert!(population(&orbitals[2]) > 0.1);
        assert!(population(homo).abs() < 0.01, "a lone pair: {}", population(homo));
        assert!(
            (-1.1..-0.7).contains(&population(lumo)),
            "the empty orbital should be strongly antibonding, not {}",
            population(lumo)
        );
    }

    /// The textbook pair: a pi orbital holding the second bond, and the pi*
    /// above it that would break it.
    #[test]
    fn ethylene_has_a_pi_homo_and_a_pi_star_lumo() {
        let (system, result) = solve(ethylene());
        let orbitals = &list(&system, &result)[0];
        let homo = *orbitals.iter().rfind(|o| o.is_occupied()).unwrap();
        let lumo = *orbitals.iter().find(|o| !o.is_occupied()).unwrap();

        assert_relative_eq!(homo.parity.unwrap(), -1.0, epsilon = 1e-3);
        assert_relative_eq!(lumo.parity.unwrap(), -1.0, epsilon = 1e-3);

        let refs = [
            OrbitalRef { channel: 0, index: homo.index },
            OrbitalRef { channel: 0, index: lumo.index },
        ];
        let bonding = overlap_population(&system, &result, refs[0], homo.occupation, 0, 1);
        let antibonding = overlap_population(&system, &result, refs[1], 1.0, 0, 1);
        assert!(bonding > 0.1, "the pi orbital binds the two carbons: {bonding}");
        assert!(antibonding < -0.1, "the pi* orbital pulls them apart: {antibonding}");

        // Above the plane the pi orbital has one sign across both carbons and
        // the pi* changes sign between them: the node that makes it pi*.
        let pi = probe_amplitudes(&system, &result, refs[0]).unwrap();
        let pi_star = probe_amplitudes(&system, &result, refs[1]).unwrap();
        assert!(pi[0] * pi[1] > 0.01, "pi probes {pi:?}");
        assert!(pi_star[0] * pi_star[1] < -0.01, "pi* probes {pi_star:?}");
    }

    /// One pi orbital is a lobe above the plane and a lobe below it; pi* has the
    /// same again on each side of its node.
    #[test]
    fn a_pi_orbital_has_two_lobes_and_a_pi_star_four() {
        let (system, result) = solve(ethylene());
        let orbitals = &list(&system, &result)[0];
        let homo = orbitals.iter().rfind(|o| o.is_occupied()).unwrap().index;
        let lumo = orbitals.iter().find(|o| !o.is_occupied()).unwrap().index;

        // The lattice the application draws on, and a level well inside the
        // peak amplitude of about 0.3 so the lobes are neither cut in two nor
        // run together.
        let spec = GridSpec::for_molecule(&system.molecule);
        let level = 0.05;
        let lobes = |index: usize| {
            let column = signed_column(&result, OrbitalRef { channel: 0, index });
            let psi = density::evaluate_orbital(&system.basis, column.as_slice(), &spec);
            density::count_lobes(&psi, level)
        };

        assert_eq!(lobes(homo), (1, 1));
        assert_eq!(lobes(lumo), (2, 2));
    }

    /// Benzene's pi system: three orbitals holding the six electrons and three
    /// empty ones above them, with the top pair of each degenerate.
    #[test]
    fn benzene_has_three_pi_orbitals_and_three_empty_ones_in_degenerate_pairs() {
        let (system, result) = solve(benzene());
        let orbitals = &list(&system, &result)[0];

        let pi: Vec<&OrbitalInfo> =
            orbitals.iter().filter(|o| o.parity.unwrap() < 0.0).collect();
        assert_eq!(pi.iter().filter(|o| o.is_occupied()).count(), 3);
        assert_eq!(pi.iter().filter(|o| !o.is_occupied()).count(), 3);
        for orbital in &pi {
            assert_relative_eq!(orbital.parity.unwrap(), -1.0, epsilon = 1e-3);
        }

        let groups = degenerate_groups(orbitals);
        assert_eq!(
            groups.iter().map(|g| g.len()).sum::<usize>(),
            orbitals.len(),
            "every orbital belongs to exactly one level"
        );

        // The highest occupied orbital shares its level with one other, and so
        // does the lowest empty one: neither is a thing the molecule has on its
        // own.
        let homo = orbitals.iter().rfind(|o| o.is_occupied()).unwrap().index;
        let lumo = orbitals.iter().find(|o| !o.is_occupied()).unwrap().index;
        for level in [homo, lumo] {
            let group = groups.iter().find(|g| g.contains(&level)).unwrap();
            assert_eq!(group.len(), 2, "level around orbital {level}: {group:?}");
            // And both members really are pi.
            assert!(group.clone().all(|i| orbitals[i].parity.unwrap() < -0.9));
        }
    }

    /// Oxygen is a triplet because its two highest electrons go into two
    /// different pi* orbitals with the same spin. Everything about that is
    /// visible here: alpha holds two more electrons than beta, the two it holds
    /// extra are a degenerate pair, and that pair is antibonding.
    #[test]
    fn oxygen_puts_one_electron_into_each_of_two_pi_star_orbitals() {
        let (system, result) = solve(oxygen());
        let channels = list(&system, &result);
        assert_eq!(channels.len(), 2, "alpha and beta stay apart");

        let occupied: Vec<usize> =
            channels.iter().map(|set| set.iter().filter(|o| o.is_occupied()).count()).collect();
        assert_eq!(occupied, vec![9, 7]);

        let (alpha, beta) = (&channels[0], &channels[1]);
        let top = degenerate_groups(alpha).into_iter().find(|g| g.end == occupied[0]).unwrap();
        assert_eq!(top.len(), 2, "the two unpaired electrons sit on one degenerate level");

        for index in top.clone() {
            let population = overlap_population(
                &system,
                &result,
                OrbitalRef { channel: 0, index },
                alpha[index].occupation,
                0,
                1,
            );
            assert!(population < 0.0, "alpha orbital {index} should be pi*: {population}");
            assert!(!beta[index].is_occupied(), "beta orbital {index} should be empty");
        }
    }

    /// Which beta orbital is which alpha one is a question about the orbitals,
    /// not about their numbering.
    #[test]
    fn alpha_and_beta_are_matched_by_overlap_rather_than_by_index() {
        let (system, result) = solve(oxygen());
        let pairing = spin_pairing(&system, &result).expect("two channels");
        assert_eq!(pairing.len(), result.channels[0].energies.len());

        let matched: Vec<usize> = pairing.iter().flatten().copied().collect();
        assert_eq!(matched.len(), pairing.len(), "every alpha orbital found a partner");
        let mut sorted = matched.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), matched.len(), "the correspondence is a permutation");

        assert_ne!(matched, (0..matched.len()).collect::<Vec<_>>(), "{matched:?}");
        // The orbitals that changed places are genuinely the same orbitals,
        // which is what makes the reordering a fact rather than noise.
        let overlaps = result.channels[0].coefficients.transpose()
            * &system.overlap
            * &result.channels[1].coefficients;
        for (i, &j) in matched.iter().enumerate() {
            let overlap = overlaps[(i, j)];
            assert!(overlap.abs() > 0.9, "alpha {i} against beta {j}: {overlap}");
        }

        // A restricted result has nothing to pair.
        let (system, result) = solve(water());
        assert_eq!(spin_pairing(&system, &result), None);
    }

    #[test]
    fn degenerate_levels_are_split_where_the_energies_really_separate() {
        let level = |energy: f64| OrbitalInfo {
            index: 0,
            energy,
            occupation: 0.0,
            parity: None,
            inversion: None,
        };
        // A pair well inside the tolerance, a single level, then a pair that is
        // outside it by a hair.
        let orbitals = [
            level(-1.0),
            level(-1.0 + 1e-6),
            level(-0.5),
            level(0.2),
            level(0.2 + 2e-4),
        ];
        assert_eq!(degenerate_groups(&orbitals), vec![0..2, 2..3, 3..4, 4..5]);

        // Steps under the tolerance must not chain a ladder into one level.
        let ladder: Vec<OrbitalInfo> =
            (0..6).map(|i| level(i as f64 * 0.8 * DEGENERACY_TOLERANCE)).collect();
        let groups = degenerate_groups(&ladder);
        assert!(groups.len() > 1, "a ladder chained itself into {groups:?}");
        assert_eq!(groups.iter().map(|g| g.len()).sum::<usize>(), ladder.len());

        assert!(degenerate_groups(&[]).is_empty());
    }
}
