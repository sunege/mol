//! The display path end to end: a converged density, sampled on the isosurface
//! lattice and cut at a level.
//!
//! Nothing here is a transcribed reference value. The electron count comes from
//! the molecule, the volumes are compared against each other rather than against
//! a number, and the surface is checked for the properties a surface must have.

use dft_core::basis::BasisKind;
use dft_core::density::{self, GridSpec};
use dft_core::grid::GridQuality;
use dft_core::marching::{self, Mesh};
use dft_core::molecule::Molecule;
use dft_core::scf::{self, ScfOptions, System};
use std::collections::HashMap;

fn water() -> Molecule {
    Molecule::from_angstrom(&[
        (8, [0.0, 0.0, 0.117_300]),
        (1, [0.0, 0.757_200, -0.469_300]),
        (1, [0.0, -0.757_200, -0.469_300]),
    ])
    .unwrap()
}

fn converged_density(molecule: Molecule) -> (System, nalgebra::DMatrix<f64>) {
    let system = System::build(molecule, BasisKind::Sto3g, GridQuality::Medium)
        .expect("basis covers the molecule");
    let result = scf::run_restricted(&system, &ScfOptions::default());
    assert!(result.converged, "the reference geometry has to converge");
    (system, result.density)
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Volume the mesh encloses, by the divergence theorem.
fn enclosed_volume(mesh: &Mesh) -> f64 {
    (0..mesh.n_triangles())
        .map(|t| {
            let p = [
                mesh.vertex(mesh.indices[3 * t] as usize),
                mesh.vertex(mesh.indices[3 * t + 1] as usize),
                mesh.vertex(mesh.indices[3 * t + 2] as usize),
            ];
            dot(p[0], cross(p[1], p[2])) / 6.0
        })
        .sum()
}

fn assert_closed(mesh: &Mesh, what: &str) {
    let mut balance: HashMap<(u32, u32), i32> = HashMap::new();
    for t in 0..mesh.n_triangles() {
        let v = [mesh.indices[3 * t], mesh.indices[3 * t + 1], mesh.indices[3 * t + 2]];
        for k in 0..3 {
            let (a, b) = (v[k], v[(k + 1) % 3]);
            *balance.entry((a.min(b), a.max(b))).or_insert(0) += if a < b { 1 } else { -1 };
        }
    }
    assert!(balance.values().all(|&n| n == 0), "{what}: the surface is not closed");
}

#[test]
fn the_display_lattice_accounts_for_the_electrons() {
    // The lattice is uniform, so it under-resolves the cusp at each nucleus and
    // cannot match the Becke grid the SCF uses. It still has to find nearly all
    // the electrons, or the isosurface is being drawn from the wrong density.
    for molecule in [water(), Molecule::from_angstrom(&[(6, [0.0; 3]), (8, [0.0, 0.0, 1.128])]).unwrap()]
    {
        let expected = molecule.n_electrons() as f64;
        let (system, density) = converged_density(molecule);
        let spec = GridSpec::for_molecule(&system.molecule);
        let grid = density::evaluate(&system.basis, &density, &spec);
        let found = grid.integrate();
        assert!(
            (found - expected).abs() < 0.05 * expected,
            "lattice found {found} of {expected} electrons"
        );
    }
}

#[test]
fn the_density_peaks_on_the_heaviest_nucleus() {
    let (system, density) = converged_density(water());
    let spec = GridSpec::for_molecule(&system.molecule);
    let grid = density::evaluate(&system.basis, &density, &spec);

    let peak = (0..spec.n_points())
        .max_by(|&a, &b| grid.values[a].partial_cmp(&grid.values[b]).unwrap())
        .unwrap();
    let oxygen = system.molecule.atoms[0].pos;
    let offset = subtract(spec.point_at(peak), oxygen);
    // Within one lattice cell of the nucleus.
    assert!(dot(offset, offset).sqrt() < spec.spacing * 1.74, "peak at {offset:?} from O");
}

#[test]
fn raising_the_level_shrinks_a_closed_surface_towards_the_nuclei() {
    let (system, density) = converged_density(water());
    let spec = GridSpec::for_molecule(&system.molecule);
    let grid = density::evaluate(&system.basis, &density, &spec);

    let mut previous = f64::INFINITY;
    for level in [0.002, 0.01, 0.05, 0.2] {
        let mesh = marching::extract(&grid, level);
        assert!(!mesh.is_empty(), "level {level} produced no surface");
        assert_closed(&mesh, &format!("water at {level}"));
        let volume = enclosed_volume(&mesh);
        assert!(volume > 0.0, "level {level} encloses {volume}, so it is inside out");
        assert!(volume < previous, "level {level} encloses {volume}, more than {previous}");
        previous = volume;
    }

    // Far above the peak there is nothing left to draw, and that is a normal
    // answer rather than a failure.
    assert!(marching::extract(&grid, grid.max() * 1.01).is_empty());
}

#[test]
fn the_low_level_surface_wraps_every_nucleus() {
    // The 0.002 contour is the usual stand-in for a molecule's size, so every
    // nucleus has to be inside it. Counting crossings of a ray from the nucleus
    // says whether it is, and needs nothing but the mesh.
    let (system, density) = converged_density(water());
    let spec = GridSpec::for_molecule(&system.molecule);
    let grid = density::evaluate(&system.basis, &density, &spec);
    let mesh = marching::extract(&grid, 0.002);

    for (i, atom) in system.molecule.atoms.iter().enumerate() {
        // An oblique direction, so the ray misses vertices and edges.
        let direction = [0.317_2, 0.585_1, 0.746_3];
        let crossings = (0..mesh.n_triangles())
            .filter(|&t| {
                let p = [
                    mesh.vertex(mesh.indices[3 * t] as usize),
                    mesh.vertex(mesh.indices[3 * t + 1] as usize),
                    mesh.vertex(mesh.indices[3 * t + 2] as usize),
                ];
                ray_hits_triangle(atom.pos, direction, p)
            })
            .count();
        assert_eq!(crossings % 2, 1, "atom {i} is outside the 0.002 contour");
    }
}

/// Moller-Trumbore, for the crossing count above.
fn ray_hits_triangle(origin: [f64; 3], direction: [f64; 3], p: [[f64; 3]; 3]) -> bool {
    let e1 = subtract(p[1], p[0]);
    let e2 = subtract(p[2], p[0]);
    let h = cross(direction, e2);
    let a = dot(e1, h);
    if a.abs() < 1e-12 {
        return false;
    }
    let f = 1.0 / a;
    let s = subtract(origin, p[0]);
    let u = f * dot(s, h);
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = cross(s, e1);
    let v = f * dot(direction, q);
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    f * dot(e2, q) > 1e-12
}
