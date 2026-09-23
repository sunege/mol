//! Which electrons a density surface is drawn from.
//!
//! The total density is dominated by the core: on any level that shows the
//! valence region, the picture is a blob with the nuclei buried in it, and
//! nothing in it says where the bonds are. Two ways out, both drawn with the
//! same machinery as the total density because both are just another density
//! matrix fed to [`crate::density::evaluate`]:
//!
//! * **Pi.** A planar molecule's orbitals split cleanly into those symmetric
//!   about the molecular plane and those antisymmetric about it, and the
//!   antisymmetric ones are the pi system. Selecting them is exact symmetry, not
//!   a heuristic: the reflection commutes with the Kohn-Sham operator, so each
//!   orbital really is an eigenfunction of it.
//! * **Deformation.** The molecular density minus the superposition of free
//!   atoms placed at the same positions. What is left is precisely what forming
//!   the molecule did to the electrons: a build-up between bonded nuclei and in
//!   the lone pairs, a depletion elsewhere. It is signed, and it works for any
//!   molecule. The subtrahend is the SAD guess the SCF already starts from.
//!
//! Pi is the sharper picture but only exists for a planar molecule, so
//! [`bonding_channel`] picks it when it applies and falls back to the
//! deformation density otherwise.

use nalgebra::{DMatrix, DVector};

use crate::basis::BasisSet;
use crate::molecule::Molecule;
use crate::scf::linalg::symmetric_eigen_sorted;
use crate::scf::{guess, ScfResult, System};

/// A nucleus further than this from the best-fit plane, in Bohr, makes the
/// molecule non-planar. Roughly 0.03 Angstrom: tight enough to rule out a
/// pyramidal ammonia, loose enough for a ring the user placed by hand.
const PLANARITY_TOLERANCE: f64 = 0.06;

/// Three atoms lie in a plane whatever their positions, so planarity only says
/// something about a molecule once there are four.
const MIN_ATOMS_FOR_A_PLANE: usize = 4;

/// An orbital counts as symmetric or antisymmetric only if its parity is at
/// least this close to +1 or -1. Anything in between means the reflection is not
/// really a symmetry of this geometry, and no pi system is claimed.
const PARITY_THRESHOLD: f64 = 0.8;

/// The plane of a planar molecule, which is also a mirror symmetry of it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MirrorPlane {
    /// A point on the plane, in Bohr: the centroid of the nuclei.
    pub origin: [f64; 3],
    /// Unit normal.
    pub normal: [f64; 3],
}

impl MirrorPlane {
    /// Reflects a point through the plane.
    pub fn reflect(&self, point: [f64; 3]) -> [f64; 3] {
        let d: f64 = (0..3).map(|k| (point[k] - self.origin[k]) * self.normal[k]).sum();
        [
            point[0] - 2.0 * d * self.normal[0],
            point[1] - 2.0 * d * self.normal[1],
            point[2] - 2.0 * d * self.normal[2],
        ]
    }

    /// Signed distance of a point from the plane, in Bohr.
    pub fn distance(&self, point: [f64; 3]) -> f64 {
        (0..3).map(|k| (point[k] - self.origin[k]) * self.normal[k]).sum()
    }
}

/// The plane every nucleus lies in, when the molecule has one.
///
/// `None` for anything under [`MIN_ATOMS_FOR_A_PLANE`] atoms, for a molecule
/// whose atoms are collinear (where the plane would not be unique), and for one
/// that simply is not flat.
pub fn molecular_plane(molecule: &Molecule) -> Option<MirrorPlane> {
    if molecule.n_atoms() < MIN_ATOMS_FOR_A_PLANE {
        return None;
    }
    let n = molecule.n_atoms() as f64;
    let mut origin = [0.0; 3];
    for atom in &molecule.atoms {
        for k in 0..3 {
            origin[k] += atom.pos[k] / n;
        }
    }

    // Eigenvectors of the spread of the nuclei about their centroid. The
    // smallest eigenvalue is the sum of squared distances from the best-fit
    // plane, and its eigenvector is that plane's normal.
    let mut spread = DMatrix::zeros(3, 3);
    for atom in &molecule.atoms {
        let d = [atom.pos[0] - origin[0], atom.pos[1] - origin[1], atom.pos[2] - origin[2]];
        for i in 0..3 {
            for j in 0..3 {
                spread[(i, j)] += d[i] * d[j];
            }
        }
    }
    let (values, vectors) = symmetric_eigen_sorted(spread);

    // Collinear atoms leave two directions with no spread, and then which of
    // them is "the normal" is arbitrary.
    if (values[1] / n).sqrt() <= PLANARITY_TOLERANCE {
        return None;
    }

    let normal = [vectors[(0, 0)], vectors[(1, 0)], vectors[(2, 0)]];
    let plane = MirrorPlane { origin, normal };
    let worst = molecule
        .atoms
        .iter()
        .map(|a| plane.distance(a.pos).abs())
        .fold(0.0, f64::max);
    (worst <= PLANARITY_TOLERANCE).then_some(plane)
}

/// The reflection written in the basis: `sigma phi_nu = sum_mu U[mu, nu] phi_mu`.
///
/// Every nucleus lies in the plane, so each shell reflects onto itself and the
/// radial factor is untouched; only the Cartesian monomial changes, and it
/// expands into monomials of the same degree. That expansion is done here rather
/// than tabulated, so it holds for any angular momentum a future basis brings.
pub fn reflection_matrix(basis: &BasisSet, plane: &MirrorPlane) -> DMatrix<f64> {
    let n = basis.n_functions();
    // Householder: the reflection as it acts on a displacement from the plane.
    let mut m = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            m[i][j] = if i == j { 1.0 } else { 0.0 } - 2.0 * plane.normal[i] * plane.normal[j];
        }
    }

    let mut u = DMatrix::zeros(n, n);
    for (s, shell) in basis.shells.iter().enumerate() {
        let offset = basis.offset(s);
        let index_of: std::collections::HashMap<[u8; 3], usize> =
            shell.powers.iter().enumerate().map(|(i, &p)| (p, i)).collect();

        for (column, powers) in shell.powers.iter().enumerate() {
            // Expand the product over axes of (sum_j m[k][j] u_j)^powers[k].
            let mut polynomial: std::collections::HashMap<[u8; 3], f64> =
                std::collections::HashMap::from([([0, 0, 0], 1.0)]);
            for (k, &power) in powers.iter().enumerate() {
                for _ in 0..power {
                    let mut next = std::collections::HashMap::new();
                    for (&monomial, &coefficient) in &polynomial {
                        for j in 0..3 {
                            if m[k][j] == 0.0 {
                                continue;
                            }
                            let mut raised = monomial;
                            raised[j] += 1;
                            *next.entry(raised).or_insert(0.0) += coefficient * m[k][j];
                        }
                    }
                    polynomial = next;
                }
            }

            // The per-component normalisation sits outside the monomial, so it
            // has to be divided out of the target and multiplied into the source.
            for (monomial, coefficient) in polynomial {
                let row = index_of[&monomial];
                u[(offset + row, offset + column)] +=
                    coefficient * shell.scales[column] / shell.scales[row];
            }
        }
    }
    u
}

/// `<psi_i | sigma psi_i>` for every orbital: +1 when it is symmetric about the
/// plane, -1 when it is antisymmetric.
pub fn mirror_parities(
    basis: &BasisSet,
    overlap: &DMatrix<f64>,
    orbitals: &DMatrix<f64>,
    plane: &MirrorPlane,
) -> DVector<f64> {
    let transformed = overlap * reflection_matrix(basis, plane) * orbitals;
    DVector::from_iterator(
        orbitals.ncols(),
        (0..orbitals.ncols()).map(|i| orbitals.column(i).dot(&transformed.column(i))),
    )
}

/// One orbital of an [`ScfResult`], named by the spin channel it belongs to.
///
/// A restricted result has a single channel holding both spins; an unrestricted
/// one has alpha and beta, whose pi orbitals need not even be the same in
/// number - in O2 two of them are occupied in alpha and empty in beta, which is
/// exactly what makes it a triplet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrbitalRef {
    /// Index into [`ScfResult::channels`].
    pub channel: usize,
    /// Index of the orbital within that channel.
    pub index: usize,
}

/// Which electrons a surface is drawn from.
#[derive(Debug, Clone, PartialEq)]
pub enum DensityChannel {
    /// Every electron. Always non-negative.
    Total,
    /// The occupied orbitals antisymmetric about a planar molecule's plane. Also
    /// non-negative: it is a density, not an orbital.
    Pi(Vec<OrbitalRef>),
    /// Molecular density minus superposed free atoms. Signed, and the only
    /// channel that is.
    Deformation,
}

impl DensityChannel {
    /// Whether the channel can go negative, which decides whether one surface is
    /// drawn or two.
    pub fn is_signed(&self) -> bool {
        matches!(self, DensityChannel::Deformation)
    }
}

/// The occupied orbitals antisymmetric about the molecular plane, or `None`
/// when this molecule has no pi system worth drawing.
///
/// Only parities: nothing here samples a density, so asking merely whether the
/// molecule has a pi system costs a pair of matrix products and no grid.
fn pi_orbitals(system: &System, result: &ScfResult) -> Option<Vec<OrbitalRef>> {
    let plane = molecular_plane(&system.molecule)?;

    let mut pi = Vec::new();
    for (channel, set) in result.channels.iter().enumerate() {
        // Each spin channel has its own orbitals, so each needs its own
        // parities; the reflection matrix behind them depends only on the basis
        // and is rebuilt per channel rather than cached, which costs nothing
        // beside the density sampling that follows.
        let parities =
            mirror_parities(&system.basis, &system.overlap, &set.coefficients, &plane);
        for index in 0..set.occupations.len() {
            if set.occupations[index] <= 1e-8 {
                continue;
            }
            let parity = parities[index];
            if parity <= -PARITY_THRESHOLD {
                pi.push(OrbitalRef { channel, index });
            } else if parity < PARITY_THRESHOLD {
                // The reflection is not a symmetry of this geometry after all,
                // so the split would be meaningless. Better to show something
                // true.
                return None;
            }
        }
    }

    (!pi.is_empty()).then_some(pi)
}

/// The channel that shows where the bonding is for this particular molecule.
///
/// Pi when the molecule is planar and its orbitals split cleanly by the
/// reflection, the deformation density otherwise. Nothing about the choice is
/// exposed to the user, who only asks to see the bonding electrons.
pub fn bonding_channel(system: &System, result: &ScfResult) -> DensityChannel {
    match pi_orbitals(system, result) {
        Some(orbitals) => DensityChannel::Pi(orbitals),
        None => DensityChannel::Deformation,
    }
}

/// Whether this molecule has electrons standing above and below a plane.
///
/// The same question [`bonding_channel`] answers, without the density that
/// follows from it: it is what lets the interface offer the pi picture only
/// where there is one to show, and fall back to the deformation density - which
/// any molecule has - everywhere else. Being planar is geometry the user can
/// see on screen, so saying it reveals nothing about the method
/// (requirement F4).
pub fn has_pi_system(system: &System, result: &ScfResult) -> bool {
    pi_orbitals(system, result).is_some()
}

/// The density matrix a channel is drawn from.
pub fn channel_density(
    system: &System,
    result: &ScfResult,
    channel: &DensityChannel,
) -> DMatrix<f64> {
    match channel {
        DensityChannel::Total => result.density.clone(),
        DensityChannel::Pi(orbitals) => {
            let n = system.n_functions();
            let mut density = DMatrix::zeros(n, n);
            for orbital in orbitals {
                let set = &result.channels[orbital.channel];
                let column = set.coefficients.column(orbital.index);
                density += (column * column.transpose()) * set.occupations[orbital.index];
            }
            density
        }
        DensityChannel::Deformation => {
            &result.density
                - guess::superposition_of_atomic_densities(system)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis::BasisKind;
    use crate::density::{self, GridSpec};
    use crate::grid::GridQuality;
    use crate::molecule::Atom;
    use crate::scf::{self, ScfOptions};
    use approx::assert_relative_eq;

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

    /// Turns a molecule so the test cannot pass by accident on a plane that
    /// happens to be a coordinate plane.
    fn rotated(molecule: &Molecule, angle: f64) -> Molecule {
        let (c, s) = (angle.cos(), angle.sin());
        let atoms = molecule
            .atoms
            .iter()
            .map(|a| Atom {
                z: a.z,
                // About x, then about z, so no axis is left alone.
                pos: {
                    let (y, z) = (c * a.pos[1] - s * a.pos[2], s * a.pos[1] + c * a.pos[2]);
                    let (x, y) = (c * a.pos[0] - s * y, s * a.pos[0] + c * y);
                    [x, y, z]
                },
            })
            .collect();
        Molecule::new(atoms).unwrap()
    }

    fn methane() -> Molecule {
        Molecule::from_angstrom(&[
            (6, [0.0; 3]),
            (1, [0.6276, 0.6276, 0.6276]),
            (1, [-0.6276, -0.6276, 0.6276]),
            (1, [-0.6276, 0.6276, -0.6276]),
            (1, [0.6276, -0.6276, -0.6276]),
        ])
        .unwrap()
    }

    #[test]
    fn a_flat_ring_has_a_plane_and_a_tetrahedron_does_not() {
        let plane = molecular_plane(&benzene()).expect("benzene is planar");
        for atom in &benzene().atoms {
            assert!(plane.distance(atom.pos).abs() < 1e-9);
        }
        // The normal is perpendicular to the ring, whichever way round it points.
        assert_relative_eq!(plane.normal[2].abs(), 1.0, epsilon = 1e-9);

        assert_eq!(molecular_plane(&methane()), None, "methane is not planar");
    }

    #[test]
    fn the_plane_is_found_whatever_the_orientation() {
        let turned = rotated(&benzene(), 0.7);
        let plane = molecular_plane(&turned).expect("a turned ring is still planar");
        for atom in &turned.atoms {
            assert!(plane.distance(atom.pos).abs() < 1e-9, "atom off the plane");
        }
        // And reflecting maps the molecule onto itself.
        for atom in &turned.atoms {
            let image = plane.reflect(atom.pos);
            for k in 0..3 {
                assert_relative_eq!(image[k], atom.pos[k], epsilon = 1e-9);
            }
        }
    }

    #[test]
    fn too_few_atoms_or_collinear_ones_have_no_usable_plane() {
        // Three atoms are planar whatever they do, so the fact says nothing.
        let water = Molecule::from_angstrom(&[
            (8, [0.0, 0.0, 0.1173]),
            (1, [0.0, 0.7572, -0.4693]),
            (1, [0.0, -0.7572, -0.4693]),
        ])
        .unwrap();
        assert_eq!(molecular_plane(&water), None);

        // Four atoms in a line lie in infinitely many planes.
        let chain: Vec<Atom> =
            (0..4).map(|i| Atom { z: 1, pos: [0.0, 0.0, i as f64 * 1.4] }).collect();
        assert_eq!(molecular_plane(&Molecule::new(chain).unwrap()), None);
    }

    #[test]
    fn reflecting_twice_is_the_identity() {
        let molecule = rotated(&benzene(), 0.4);
        let plane = molecular_plane(&molecule).unwrap();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let u = reflection_matrix(&basis, &plane);
        let identity = DMatrix::identity(basis.n_functions(), basis.n_functions());
        assert_relative_eq!(&u * &u, identity, epsilon = 1e-10);
    }

    /// The matrix route against a direct numerical integration on the SCF's own
    /// grid - two independent paths to the same number.
    #[test]
    fn the_reflection_matrix_agrees_with_integrating_over_the_grid() {
        let molecule = rotated(&benzene(), 0.4);
        let system = System::build(molecule, BasisKind::Sto3g, GridQuality::Coarse).unwrap();
        let plane = molecular_plane(&system.molecule).unwrap();
        let result = scf::run_restricted(&system, &ScfOptions::default());
        let orbitals = &result.channels[0].coefficients;
        let parities = mirror_parities(&system.basis, &system.overlap, orbitals, &plane);

        for i in [0usize, 16, 20, 25] {
            let numerical = system.grid.integrate(|p| {
                let here = system.basis.evaluate(p);
                let there = system.basis.evaluate(plane.reflect(p));
                let psi: f64 = (0..here.len()).map(|m| orbitals[(m, i)] * here[m]).sum();
                let psi_mirror: f64 =
                    (0..there.len()).map(|m| orbitals[(m, i)] * there[m]).sum();
                psi * psi_mirror
            });
            assert_relative_eq!(parities[i], numerical, epsilon = 2e-4);
        }
    }

    #[test]
    fn benzene_has_three_pi_orbitals_holding_six_electrons() {
        let molecule = rotated(&benzene(), 0.4);
        let system = System::build(molecule, BasisKind::Sto3g, GridQuality::Medium).unwrap();
        let result = scf::run_restricted(&system, &ScfOptions::default());
        assert!(result.converged);

        let channel = bonding_channel(&system, &result);
        let DensityChannel::Pi(orbitals) = &channel else {
            panic!("benzene should give a pi channel, got {channel:?}");
        };
        // Six carbons contributing one p orbital each, half of them filled.
        assert_eq!(orbitals.len(), 3, "pi orbitals: {orbitals:?}");
        assert!(!channel.is_signed());

        // The highest occupied orbital is one of them: benzene's HOMO is pi.
        let set = &result.channels[0];
        let homo = (0..set.occupations.len())
            .filter(|&i| set.occupations[i] > 1e-8)
            .next_back()
            .unwrap();
        assert!(
            orbitals.contains(&OrbitalRef { channel: 0, index: homo }),
            "the HOMO should be pi"
        );

        let density = channel_density(&system, &result, &channel);
        let spec = GridSpec::for_molecule(&system.molecule);
        let grid = density::evaluate(&system.basis, &density, &spec);
        assert_relative_eq!(grid.integrate(), 6.0, max_relative = 0.02);
        assert!(grid.values.iter().all(|&v| v > -1e-10), "a density cannot be negative");
    }

    /// What the interface asks before it offers the pi picture at all.
    #[test]
    fn benzene_has_a_pi_system_and_methane_has_none() {
        // Coarse: the question is which orbitals the reflection is a symmetry
        // of, and no grid is sampled to answer it.
        let ring =
            System::build(rotated(&benzene(), 0.4), BasisKind::Sto3g, GridQuality::Coarse)
                .unwrap();
        let ring_result = scf::run_restricted(&ring, &ScfOptions::default());
        assert!(has_pi_system(&ring, &ring_result));

        let tetrahedron =
            System::build(methane(), BasisKind::Sto3g, GridQuality::Coarse).unwrap();
        let tetrahedron_result = scf::run_restricted(&tetrahedron, &ScfOptions::default());
        assert!(!has_pi_system(&tetrahedron, &tetrahedron_result));

        // The same decision the channel is chosen by, which is the point of
        // asking it separately: the button and the surface behind it cannot
        // disagree.
        for (system, result) in [(&ring, &ring_result), (&tetrahedron, &tetrahedron_result)] {
            let is_pi = matches!(bonding_channel(system, result), DensityChannel::Pi(_));
            assert_eq!(is_pi, has_pi_system(system, result));
        }
    }

    #[test]
    fn a_non_planar_molecule_falls_back_to_the_deformation_density() {
        let system = System::build(methane(), BasisKind::Sto3g, GridQuality::Medium).unwrap();
        let result = scf::run_restricted(&system, &ScfOptions::default());
        let channel = bonding_channel(&system, &result);
        assert_eq!(channel, DensityChannel::Deformation);
        assert!(channel.is_signed());

        // Free atoms hold the same electrons as the molecule, so what is left
        // after subtracting them carries no charge at all: the deformation
        // density moves electrons about rather than creating them. Checked as
        // `tr(D S)`, which is exact; summing over the display lattice would
        // instead measure how badly a uniform lattice resolves the cusp at each
        // nucleus, since both densities have one and neither is resolved.
        let density = channel_density(&system, &result, &channel);
        let electrons: f64 = density.component_mul(&system.overlap).sum();
        assert!(electrons.abs() < 1e-8, "deformation density carries {electrons} electrons");

        // And it really does have both signs, which is the whole point of it.
        let spec = GridSpec::for_molecule(&system.molecule);
        let grid = density::evaluate(&system.basis, &density, &spec);
        let low = grid.values.iter().copied().fold(f64::INFINITY, f64::min);
        let high = grid.values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        assert!(low < -0.005, "no depletion anywhere: {low}");
        assert!(high > 0.005, "no build-up anywhere: {high}");
    }

    #[test]
    fn the_total_channel_is_the_density_the_scf_converged_on() {
        let system = System::build(methane(), BasisKind::Sto3g, GridQuality::Coarse).unwrap();
        let result = scf::run_restricted(&system, &ScfOptions::default());
        let density = channel_density(&system, &result, &DensityChannel::Total);
        assert_eq!(density, result.density);
        assert!(!DensityChannel::Total.is_signed());
    }
}
