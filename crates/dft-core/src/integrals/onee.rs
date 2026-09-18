//! One-electron integrals: overlap, kinetic energy and nuclear attraction.

use nalgebra::DMatrix;

use super::md::{HermiteE, HermiteR};
use crate::basis::{cartesian_powers, BasisSet, Shell};
use crate::molecule::Molecule;

/// Overlap and kinetic-energy matrices.
///
/// They are built together because they share the Hermite coefficients; the
/// kinetic energy only needs two extra orders in the second index.
pub fn overlap_and_kinetic(basis: &BasisSet) -> (DMatrix<f64>, DMatrix<f64>) {
    let n = basis.n_functions();
    let mut s = DMatrix::zeros(n, n);
    let mut t = DMatrix::zeros(n, n);

    let powers: Vec<Vec<[u8; 3]>> = (0..=basis.max_angular_momentum())
        .map(cartesian_powers)
        .collect();

    for (sa, shell_a) in basis.shells.iter().enumerate() {
        for (sb, shell_b) in basis.shells.iter().enumerate().take(sa + 1) {
            let pa = &powers[shell_a.l as usize];
            let pb = &powers[shell_b.l as usize];
            let mut block_s = vec![0.0; pa.len() * pb.len()];
            let mut block_t = vec![0.0; pa.len() * pb.len()];

            for (ia, &a) in shell_a.exponents.iter().enumerate() {
                for (ib, &b) in shell_b.exponents.iter().enumerate() {
                    let coefficient = shell_a.coefficients[ia] * shell_b.coefficients[ib];
                    let p = a + b;
                    let root = (std::f64::consts::PI / p).sqrt();
                    // Two extra orders in j so the second derivative of the
                    // right-hand Gaussian stays inside the table.
                    let e: Vec<HermiteE> = (0..3)
                        .map(|axis| {
                            HermiteE::new(
                                shell_a.l as usize,
                                shell_b.l as usize + 2,
                                a,
                                b,
                                shell_a.origin[axis],
                                shell_b.origin[axis],
                            )
                        })
                        .collect();
                    // One-dimensional overlap; only the t = 0 Hermite term
                    // survives integration.
                    let s1 = |axis: usize, i: u8, j: i32| -> f64 {
                        if j < 0 {
                            return 0.0;
                        }
                        e[axis].get(i as usize, j as usize, 0) * root
                    };
                    // -1/2 d^2/dx^2 acting on the right-hand Gaussian, written
                    // through overlaps of shifted angular momentum.
                    let d2 = |axis: usize, i: u8, j: u8| -> f64 {
                        let j = j as i32;
                        4.0 * b * b * s1(axis, i, j + 2)
                            - 2.0 * b * (2.0 * j as f64 + 1.0) * s1(axis, i, j)
                            + (j * (j - 1)) as f64 * s1(axis, i, j - 2)
                    };

                    for (ca, powers_a) in pa.iter().enumerate() {
                        for (cb, powers_b) in pb.iter().enumerate() {
                            let sx = s1(0, powers_a[0], powers_b[0] as i32);
                            let sy = s1(1, powers_a[1], powers_b[1] as i32);
                            let sz = s1(2, powers_a[2], powers_b[2] as i32);
                            let slot = ca * pb.len() + cb;
                            block_s[slot] += coefficient * sx * sy * sz;
                            block_t[slot] += coefficient
                                * -0.5
                                * (d2(0, powers_a[0], powers_b[0]) * sy * sz
                                    + sx * d2(1, powers_a[1], powers_b[1]) * sz
                                    + sx * sy * d2(2, powers_a[2], powers_b[2]));
                        }
                    }
                }
            }

            scatter(&mut s, basis, sa, sb, shell_a, shell_b, &block_s);
            scatter(&mut t, basis, sa, sb, shell_a, shell_b, &block_t);
        }
    }
    (s, t)
}

/// Overlap matrix.
pub fn overlap(basis: &BasisSet) -> DMatrix<f64> {
    overlap_and_kinetic(basis).0
}

/// Kinetic-energy matrix.
pub fn kinetic(basis: &BasisSet) -> DMatrix<f64> {
    overlap_and_kinetic(basis).1
}

/// Electron-nucleus attraction matrix, summed over all nuclei.
pub fn nuclear_attraction(basis: &BasisSet, molecule: &Molecule) -> DMatrix<f64> {
    let n = basis.n_functions();
    let mut v = DMatrix::zeros(n, n);
    let max_order = 2 * basis.max_angular_momentum() as usize;
    let mut r = HermiteR::new(max_order);

    let powers: Vec<Vec<[u8; 3]>> = (0..=basis.max_angular_momentum())
        .map(cartesian_powers)
        .collect();

    for (sa, shell_a) in basis.shells.iter().enumerate() {
        for (sb, shell_b) in basis.shells.iter().enumerate().take(sa + 1) {
            let pa = &powers[shell_a.l as usize];
            let pb = &powers[shell_b.l as usize];
            let order = (shell_a.l + shell_b.l) as usize;
            let mut block = vec![0.0; pa.len() * pb.len()];

            for (ia, &a) in shell_a.exponents.iter().enumerate() {
                for (ib, &b) in shell_b.exponents.iter().enumerate() {
                    let coefficient = shell_a.coefficients[ia] * shell_b.coefficients[ib];
                    let p = a + b;
                    let centre = product_centre(a, shell_a.origin, b, shell_b.origin);
                    let e: Vec<HermiteE> = (0..3)
                        .map(|axis| {
                            HermiteE::new(
                                shell_a.l as usize,
                                shell_b.l as usize,
                                a,
                                b,
                                shell_a.origin[axis],
                                shell_b.origin[axis],
                            )
                        })
                        .collect();
                    let scale = 2.0 * std::f64::consts::PI / p * coefficient;

                    for atom in &molecule.atoms {
                        r.compute(
                            order,
                            p,
                            [
                                centre[0] - atom.pos[0],
                                centre[1] - atom.pos[1],
                                centre[2] - atom.pos[2],
                            ],
                        );
                        let charge = atom.z as f64;
                        for (ca, powers_a) in pa.iter().enumerate() {
                            for (cb, powers_b) in pb.iter().enumerate() {
                                let mut sum = 0.0;
                                for t in 0..=(powers_a[0] + powers_b[0]) as usize {
                                    let ex = e[0].get(
                                        powers_a[0] as usize,
                                        powers_b[0] as usize,
                                        t,
                                    );
                                    if ex == 0.0 {
                                        continue;
                                    }
                                    for u in 0..=(powers_a[1] + powers_b[1]) as usize {
                                        let ey = e[1].get(
                                            powers_a[1] as usize,
                                            powers_b[1] as usize,
                                            u,
                                        );
                                        if ey == 0.0 {
                                            continue;
                                        }
                                        for w in 0..=(powers_a[2] + powers_b[2]) as usize {
                                            sum += ex
                                                * ey
                                                * e[2].get(
                                                    powers_a[2] as usize,
                                                    powers_b[2] as usize,
                                                    w,
                                                )
                                                * r.get(t, u, w);
                                        }
                                    }
                                }
                                // Attraction, hence the minus sign.
                                block[ca * pb.len() + cb] -= charge * scale * sum;
                            }
                        }
                    }
                }
            }
            scatter(&mut v, basis, sa, sb, shell_a, shell_b, &block);
        }
    }
    v
}

/// Core Hamiltonian `T + V`.
pub fn core_hamiltonian(basis: &BasisSet, molecule: &Molecule) -> DMatrix<f64> {
    let (_, t) = overlap_and_kinetic(basis);
    t + nuclear_attraction(basis, molecule)
}

pub(crate) fn product_centre(a: f64, ra: [f64; 3], b: f64, rb: [f64; 3]) -> [f64; 3] {
    let p = a + b;
    [
        (a * ra[0] + b * rb[0]) / p,
        (a * ra[1] + b * rb[1]) / p,
        (a * ra[2] + b * rb[2]) / p,
    ]
}

/// Writes a shell block into both triangles of a symmetric matrix, applying the
/// per-component normalisation factors.
fn scatter(
    matrix: &mut DMatrix<f64>,
    basis: &BasisSet,
    sa: usize,
    sb: usize,
    shell_a: &Shell,
    shell_b: &Shell,
    block: &[f64],
) {
    let offset_a = basis.offset(sa);
    let offset_b = basis.offset(sb);
    let nb = shell_b.n_components();
    for (ca, &scale_a) in shell_a.scales.iter().enumerate() {
        for (cb, &scale_b) in shell_b.scales.iter().enumerate() {
            let value = block[ca * nb + cb] * scale_a * scale_b;
            matrix[(offset_a + ca, offset_b + cb)] = value;
            matrix[(offset_b + cb, offset_a + ca)] = value;
        }
    }
}
