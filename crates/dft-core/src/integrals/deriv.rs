//! Derivatives of the Gaussian integrals with respect to nuclear positions.
//!
//! Everything here rests on one identity. A basis function sits on a nucleus, so
//! moving the nucleus changes the function, and the change is again a pair of
//! Gaussians on the same centre:
//!
//! ```text
//! d/dA_x  x_A^i y_A^j z_A^k exp(-a r_A^2)  =  2a * (i+1 in x)  -  i * (i-1 in x)
//! ```
//!
//! That is the whole of the Pulay problem. Because the derivative is a sum of
//! ordinary Gaussians, every derivative integral is an ordinary integral with
//! shifted angular momentum, and the existing McMurchie-Davidson code computes
//! it with no new kernel - only a different set of expansion coefficients.
//!
//! Three kinds of derivative appear, and confusing them is the classic way to
//! get a force that looks plausible and is wrong:
//!
//! * The **bra and ket derivatives** above, which exist for every integral
//!   because the basis follows the nuclei. These are the Pulay terms.
//! * The **operator derivative** of the nuclear attraction, which is what the
//!   Hellmann-Feynman theorem alone would give: the `-Z_C/|r - C|` in the
//!   Hamiltonian moves with nucleus C.
//! * No derivative at all for the kinetic operator, which does not know where
//!   the nuclei are.
//!
//! The integrals themselves are checked against finite differences of the
//! matrices they differentiate, one matrix at a time, so a wrong term is
//! localised rather than merely detected.

use nalgebra::DMatrix;

use super::eri::{self, build_shell_pair_derivative, quartet, Derivative, ShellPair};
use super::md::{HermiteE, HermiteR};
use super::onee::product_centre;
use crate::basis::BasisSet;
use crate::molecule::Molecule;

/// Schwarz threshold for the two-electron derivatives.
///
/// Tighter than the one the energy uses, because the bound is computed from the
/// undifferentiated integrals while the quantity actually being skipped is
/// larger by roughly twice the largest exponent. Even for a core s function of
/// argon that leaves several orders of magnitude between what is dropped and the
/// `4.5e-4` Hartree/Bohr at which a force is called converged.
pub const GRADIENT_SCREENING: f64 = 1e-14;

/// Derivatives of the one-electron matrices with respect to one nuclear
/// coordinate.
#[derive(Debug, Clone)]
pub struct OneElectronDerivative {
    /// `dS/dR`. Pure Pulay: the overlap operator is the identity.
    pub overlap: DMatrix<f64>,
    /// `dT/dR`. Also pure Pulay: the kinetic operator does not know where the
    /// nuclei are.
    pub kinetic: DMatrix<f64>,
    /// `dV_ne/dR`: the basis-following terms and the Hellmann-Feynman term of
    /// the moving nucleus together.
    pub nuclear: DMatrix<f64>,
}

impl OneElectronDerivative {
    /// `d(T + V_ne)/dR`, which is what the energy expression uses. They are kept
    /// apart above so a finite-difference test can fail on one of them.
    pub fn core(&self) -> DMatrix<f64> {
        &self.kinetic + &self.nuclear
    }
}

/// `d/dA` applied to the bra: `2a f(i+1, j) - i f(i-1, j)`.
///
/// `f` must return zero for a negative index, which is how the `i = 0` case
/// takes care of itself.
fn raise_bra(alpha: f64, i: i32, j: i32, f: impl Fn(i32, i32) -> f64) -> f64 {
    2.0 * alpha * f(i + 1, j) - i as f64 * f(i - 1, j)
}

/// `d/dB` applied to the ket.
fn raise_ket(beta: f64, i: i32, j: i32, f: impl Fn(i32, i32) -> f64) -> f64 {
    2.0 * beta * f(i, j + 1) - j as f64 * f(i, j - 1)
}

/// `sum_tuv c_x[t] c_y[u] c_z[v] R^0_(t+s0, u+s1, v+s2)`.
fn hermite_sum(r: &HermiteR, cx: &[f64], cy: &[f64], cz: &[f64], shift: [usize; 3]) -> f64 {
    let mut total = 0.0;
    for (t, &x) in cx.iter().enumerate() {
        if x == 0.0 {
            continue;
        }
        for (u, &y) in cy.iter().enumerate() {
            if y == 0.0 {
                continue;
            }
            for (v, &z) in cz.iter().enumerate() {
                if z == 0.0 {
                    continue;
                }
                total += x * y * z * r.get(t + shift[0], u + shift[1], v + shift[2]);
            }
        }
    }
    total
}

/// Derivatives of `S` and `T + V_ne` with respect to every nuclear coordinate,
/// indexed `[atom][axis]`.
///
/// Returning matrices rather than a contracted gradient costs `6 N` of them -
/// under a megabyte at benzene's size - and buys the thing that matters: a test
/// can difference the overlap matrix alone and see which term is wrong.
pub fn one_electron_derivatives(
    basis: &BasisSet,
    molecule: &Molecule,
) -> Vec<[OneElectronDerivative; 3]> {
    let n = basis.n_functions();
    let n_atoms = molecule.n_atoms();
    let mut out: Vec<[OneElectronDerivative; 3]> = (0..n_atoms)
        .map(|_| {
            std::array::from_fn(|_| OneElectronDerivative {
                overlap: DMatrix::zeros(n, n),
                kinetic: DMatrix::zeros(n, n),
                nuclear: DMatrix::zeros(n, n),
            })
        })
        .collect();

    let max_l = basis.max_angular_momentum() as usize;
    // One order above what the energy needs, plus a slot for the shift the
    // operator derivative applies to R.
    let mut r = HermiteR::new(2 * max_l + 2);

    for sa in 0..basis.n_shells() {
        for sb in 0..=sa {
            let a = &basis.shells[sa];
            let b = &basis.shells[sb];
            let na = a.n_components();
            let nb = b.n_components();
            let slots = na * nb;
            // Highest Hermite index once one shell has been raised.
            let order = (a.l + b.l) as usize + 1;
            let tspan = order + 1;

            let mut ds_bra: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; slots]);
            let mut ds_ket: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; slots]);
            let mut dt_bra: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; slots]);
            let mut dt_ket: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; slots]);
            let mut dv_bra: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; slots]);
            let mut dv_ket: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; slots]);
            // The Hellmann-Feynman term, one block per nucleus.
            let mut dv_nucleus: Vec<[Vec<f64>; 3]> = (0..n_atoms)
                .map(|_| std::array::from_fn(|_| vec![0.0; slots]))
                .collect();

            // Hermite coefficients of this primitive pair, and the two raised
            // combinations, indexed [component][axis][t].
            let mut plain = vec![0.0; slots * 3 * tspan];
            let mut raised_bra = vec![0.0; slots * 3 * tspan];
            let mut raised_ket = vec![0.0; slots * 3 * tspan];

            for (ia, &alpha) in a.exponents.iter().enumerate() {
                for (ib, &beta) in b.exponents.iter().enumerate() {
                    let coefficient = a.coefficients[ia] * b.coefficients[ib];
                    let p = alpha + beta;
                    let root = (std::f64::consts::PI / p).sqrt();
                    // Room for one raised bra index and three raised ket ones:
                    // the kinetic operator already needs `j + 2`, and its ket
                    // derivative needs one more.
                    let e: Vec<HermiteE> = (0..3)
                        .map(|axis| {
                            HermiteE::new(
                                a.l as usize + 1,
                                b.l as usize + 3,
                                alpha,
                                beta,
                                a.origin[axis],
                                b.origin[axis],
                            )
                        })
                        .collect();

                    // One-dimensional overlap, zero outside the valid indices.
                    let s1 = |axis: usize, i: i32, j: i32| -> f64 {
                        if i < 0 || j < 0 {
                            return 0.0;
                        }
                        e[axis].get(i as usize, j as usize, 0) * root
                    };
                    // The one-dimensional piece of the kinetic energy,
                    // `<i| -1/2 d^2/dx^2 |j>`, written through overlaps of
                    // shifted angular momentum.
                    let t1 = |axis: usize, i: i32, j: i32| -> f64 {
                        if i < 0 || j < 0 {
                            return 0.0;
                        }
                        -0.5 * (4.0 * beta * beta * s1(axis, i, j + 2)
                            - 2.0 * beta * (2.0 * j as f64 + 1.0) * s1(axis, i, j)
                            + (j * (j - 1)) as f64 * s1(axis, i, j - 2))
                    };

                    for (ca, pa) in a.powers.iter().enumerate() {
                        for (cb, pb) in b.powers.iter().enumerate() {
                            let slot = ca * nb + cb;
                            let s: [f64; 3] =
                                std::array::from_fn(|k| s1(k, pa[k] as i32, pb[k] as i32));
                            let t: [f64; 3] =
                                std::array::from_fn(|k| t1(k, pa[k] as i32, pb[k] as i32));

                            for k in 0..3 {
                                let (m, q) = ((k + 1) % 3, (k + 2) % 3);
                                // The other two directions, with and without the
                                // kinetic factor on one of them.
                                let others_overlap = s[m] * s[q];
                                let others_kinetic = t[m] * s[q] + s[m] * t[q];

                                let i = pa[k] as i32;
                                let j = pb[k] as i32;
                                let ds_a = raise_bra(alpha, i, j, |i, j| s1(k, i, j));
                                let dt_a = raise_bra(alpha, i, j, |i, j| t1(k, i, j));
                                let ds_b = raise_ket(beta, i, j, |i, j| s1(k, i, j));
                                let dt_b = raise_ket(beta, i, j, |i, j| t1(k, i, j));

                                ds_bra[k][slot] += coefficient * ds_a * others_overlap;
                                ds_ket[k][slot] += coefficient * ds_b * others_overlap;
                                dt_bra[k][slot] += coefficient
                                    * (dt_a * others_overlap + ds_a * others_kinetic);
                                dt_ket[k][slot] += coefficient
                                    * (dt_b * others_overlap + ds_b * others_kinetic);
                            }
                        }
                    }

                    // --- nuclear attraction -------------------------------
                    let centre = product_centre(alpha, a.origin, beta, b.origin);
                    let coefficient_at = |axis: usize, i: i32, j: i32, t: usize| -> f64 {
                        if i < 0 || j < 0 {
                            return 0.0;
                        }
                        e[axis].at(i as usize, j as usize, t as isize)
                    };
                    for (ca, pa) in a.powers.iter().enumerate() {
                        for (cb, pb) in b.powers.iter().enumerate() {
                            let slot = ca * nb + cb;
                            for axis in 0..3 {
                                let i = pa[axis] as i32;
                                let j = pb[axis] as i32;
                                let base = (slot * 3 + axis) * tspan;
                                for t in 0..tspan {
                                    plain[base + t] = coefficient_at(axis, i, j, t);
                                    raised_bra[base + t] =
                                        raise_bra(alpha, i, j, |i, j| {
                                            coefficient_at(axis, i, j, t)
                                        });
                                    raised_ket[base + t] =
                                        raise_ket(beta, i, j, |i, j| {
                                            coefficient_at(axis, i, j, t)
                                        });
                                }
                            }
                        }
                    }

                    let prefactor = 2.0 * std::f64::consts::PI / p * coefficient;
                    for (c, nucleus) in molecule.atoms.iter().enumerate() {
                        r.compute(
                            order,
                            p,
                            [
                                centre[0] - nucleus.pos[0],
                                centre[1] - nucleus.pos[1],
                                centre[2] - nucleus.pos[2],
                            ],
                        );
                        let charge = nucleus.z as f64;
                        for slot in 0..slots {
                            let band = |axis: usize| {
                                let base = (slot * 3 + axis) * tspan;
                                base..base + tspan
                            };
                            let values: [&[f64]; 3] =
                                std::array::from_fn(|axis| &plain[band(axis)]);
                            for k in 0..3 {
                                // A derivative raises the coefficients along its
                                // own direction and leaves the other two alone.
                                let bra: [&[f64]; 3] = std::array::from_fn(|axis| {
                                    if axis == k {
                                        &raised_bra[band(axis)]
                                    } else {
                                        values[axis]
                                    }
                                });
                                let ket: [&[f64]; 3] = std::array::from_fn(|axis| {
                                    if axis == k {
                                        &raised_ket[band(axis)]
                                    } else {
                                        values[axis]
                                    }
                                });
                                dv_bra[k][slot] += -charge
                                    * prefactor
                                    * hermite_sum(&r, bra[0], bra[1], bra[2], [0, 0, 0]);
                                dv_ket[k][slot] += -charge
                                    * prefactor
                                    * hermite_sum(&r, ket[0], ket[1], ket[2], [0, 0, 0]);

                                // The operator derivative. R is a function of
                                // P - C, so differentiating with respect to C
                                // flips a sign and raises one Hermite index; the
                                // flip cancels the minus of the attraction.
                                let mut shift = [0usize; 3];
                                shift[k] = 1;
                                dv_nucleus[c][k][slot] += charge
                                    * prefactor
                                    * hermite_sum(&r, values[0], values[1], values[2], shift);
                            }
                        }
                    }
                }
            }

            // --- write the blocks into the matrices ----------------------
            let offset_a = basis.offset(sa);
            let offset_b = basis.offset(sb);
            for ca in 0..na {
                for cb in 0..nb {
                    let slot = ca * nb + cb;
                    let scale = a.scales[ca] * b.scales[cb];
                    let mu = offset_a + ca;
                    let nu = offset_b + cb;
                    for k in 0..3 {
                        let mut add = |atom: usize, overlap: f64, kinetic: f64, nuclear: f64| {
                            let target = &mut out[atom][k];
                            target.overlap[(mu, nu)] += overlap * scale;
                            target.kinetic[(mu, nu)] += kinetic * scale;
                            target.nuclear[(mu, nu)] += nuclear * scale;
                            if sa != sb {
                                target.overlap[(nu, mu)] += overlap * scale;
                                target.kinetic[(nu, mu)] += kinetic * scale;
                                target.nuclear[(nu, mu)] += nuclear * scale;
                            }
                        };
                        add(a.center, ds_bra[k][slot], dt_bra[k][slot], dv_bra[k][slot]);
                        add(b.center, ds_ket[k][slot], dt_ket[k][slot], dv_ket[k][slot]);
                        for c in 0..n_atoms {
                            add(c, 0.0, 0.0, dv_nucleus[c][k][slot]);
                        }
                    }
                }
            }
        }
    }
    out
}

/// `sum_mu_nu D_mu_nu d(T + V)_mu_nu/dR  -  sum_mu_nu W_mu_nu dS_mu_nu/dR`.
///
/// `weighted` is the energy-weighted density matrix. The second term is the
/// Pulay correction: the orbitals are expanded in functions that move with the
/// nuclei, so keeping them orthonormal costs energy, and leaving this term out
/// makes the force wrong by tens of percent - in the wrong direction for a
/// stretched bond.
pub fn one_electron_gradient(
    basis: &BasisSet,
    molecule: &Molecule,
    density: &DMatrix<f64>,
    weighted: &DMatrix<f64>,
) -> Vec<[f64; 3]> {
    let derivatives = one_electron_derivatives(basis, molecule);
    derivatives
        .iter()
        .map(|per_axis| {
            std::array::from_fn(|k| {
                dot(density, &per_axis[k].kinetic) + dot(density, &per_axis[k].nuclear)
                    - dot(weighted, &per_axis[k].overlap)
            })
        })
        .collect()
}

/// `1/2 sum_mu_nu_lambda_sigma D_mu_nu D_lambda_sigma d(mu nu|lambda sigma)/dR`,
/// the derivative of the classical electron-electron repulsion at a fixed
/// density matrix.
///
/// LDA has no exact exchange, so this is the whole two-electron gradient.
pub fn two_electron_gradient(
    basis: &BasisSet,
    molecule: &Molecule,
    density: &DMatrix<f64>,
    threshold: f64,
) -> Vec<[f64; 3]> {
    let mut gradient = vec![[0.0; 3]; molecule.n_atoms()];

    let pairs = eri::shell_pairs(basis);
    // Six derivative pairs each: two shells, three directions. Building them
    // once is what keeps the quartet loop from rebuilding the ket's coefficients
    // for every bra it meets.
    let derivatives: Vec<Vec<ShellPair>> = pairs
        .iter()
        .map(|pair| {
            let mut built = Vec::with_capacity(6);
            for shell in 0..2 {
                for axis in 0..3 {
                    built.push(build_shell_pair_derivative(
                        basis,
                        pair.shell_a,
                        pair.shell_b,
                        Derivative { shell, axis },
                    ));
                }
            }
            built
        })
        .collect();

    let mut r = HermiteR::new(4 * basis.max_angular_momentum() as usize + 1);
    let mut scratch = Vec::new();
    let mut block = Vec::new();

    // The density of each pair's block, flattened the way `quartet` lays its
    // output out, so the contraction below is a plain double loop.
    let densities: Vec<Vec<f64>> = pairs
        .iter()
        .map(|pair| pair_density(basis, pair, density))
        .collect();

    for (i, bra) in pairs.iter().enumerate() {
        for (j, ket) in pairs.iter().enumerate().take(i + 1) {
            if bra.schwarz * ket.schwarz < threshold {
                continue;
            }
            // How many terms of the unrestricted sum this quartet stands for
            // under the eight-fold permutation symmetry. The derivative shares
            // that symmetry: permuting the indices does not move a nucleus.
            let mut degeneracy = 1.0;
            if bra.shell_a != bra.shell_b {
                degeneracy *= 2.0;
            }
            if ket.shell_a != ket.shell_b {
                degeneracy *= 2.0;
            }
            if i != j {
                degeneracy *= 2.0;
            }
            let weight = 0.5 * degeneracy;

            let centres = [
                basis.shells[bra.shell_a].center,
                basis.shells[bra.shell_b].center,
                basis.shells[ket.shell_a].center,
                basis.shells[ket.shell_b].center,
            ];
            for axis in 0..3 {
                for shell in 0..2 {
                    // Differentiate the bra pair, then the ket pair. All four
                    // centres are computed rather than one of them inferred from
                    // translational invariance, which leaves that identity free
                    // to be a test.
                    quartet(
                        &derivatives[i][shell * 3 + axis],
                        ket,
                        &mut r,
                        &mut scratch,
                        &mut block,
                    );
                    gradient[centres[shell]][axis] +=
                        weight * contract(&block, &densities[i], &densities[j]);

                    quartet(
                        bra,
                        &derivatives[j][shell * 3 + axis],
                        &mut r,
                        &mut scratch,
                        &mut block,
                    );
                    gradient[centres[2 + shell]][axis] +=
                        weight * contract(&block, &densities[i], &densities[j]);
                }
            }
        }
    }
    gradient
}

/// Density-matrix entries of one shell pair, in the component order
/// [`quartet`] writes.
fn pair_density(basis: &BasisSet, pair: &ShellPair, density: &DMatrix<f64>) -> Vec<f64> {
    let offset_a = basis.offset(pair.shell_a);
    let offset_b = basis.offset(pair.shell_b);
    let nb = basis.shells[pair.shell_b].n_components();
    (0..pair.n_components)
        .map(|component| density[(offset_a + component / nb, offset_b + component % nb)])
        .collect()
}

/// `sum_bra sum_ket D_bra D_ket block`.
fn contract(block: &[f64], bra: &[f64], ket: &[f64]) -> f64 {
    let mut total = 0.0;
    for (bc, &d_bra) in bra.iter().enumerate() {
        if d_bra == 0.0 {
            continue;
        }
        let row = &block[bc * ket.len()..(bc + 1) * ket.len()];
        let mut inner = 0.0;
        for (value, &d_ket) in row.iter().zip(ket) {
            inner += value * d_ket;
        }
        total += d_bra * inner;
    }
    total
}

/// `sum_ij A_ij B_ij`.
fn dot(a: &DMatrix<f64>, b: &DMatrix<f64>) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis::Shell;
    use crate::gradient::finite_difference::{self, max_deviation, DEFAULT_STEP};
    use crate::integrals::{compute_eri, kinetic, nuclear_attraction, overlap};
    use crate::molecule::Atom;

    /// Deliberately lopsided, and with a third-row atom so the 3s/3p shells and
    /// a large core exponent are both in play. Nothing here is symmetric, so an
    /// index or sign mix-up cannot cancel itself.
    fn awkward() -> Molecule {
        Molecule::new(vec![
            Atom { z: 16, pos: [0.13, -0.21, 0.07] },
            Atom { z: 1, pos: [1.71, 1.02, -0.33] },
            Atom { z: 8, pos: [-0.44, -1.93, 1.11] },
        ])
        .unwrap()
    }

    /// A basis with an l = 2 shell, which STO-3G never produces. The derivative
    /// code is written for arbitrary angular momentum and this is what says so:
    /// if a future switch to 6-31G* breaks it, it breaks here first.
    fn with_d_functions(molecule: &Molecule) -> BasisSet {
        BasisSet::from_shells(vec![
            Shell::new(0, molecule.atoms[0].pos, 0, &[3.1, 0.7], &[0.4, 0.8]),
            Shell::new(0, molecule.atoms[0].pos, 2, &[1.3, 0.35], &[0.5, 0.6]),
            Shell::new(1, molecule.atoms[1].pos, 1, &[0.9, 0.24], &[0.55, 0.7]),
            Shell::new(2, molecule.atoms[2].pos, 2, &[1.1, 0.4], &[0.45, 0.65]),
        ])
    }

    /// Checks every one-electron derivative matrix against a central difference
    /// of the matrix it differentiates, for whatever basis the caller builds.
    fn check_one_electron(molecule: &Molecule, build: impl Fn(&Molecule) -> BasisSet) {
        let basis = build(molecule);
        let analytic = one_electron_derivatives(&basis, molecule);
        let numeric_overlap =
            finite_difference::matrix(molecule, DEFAULT_STEP, |m| overlap(&build(m)));
        let numeric_kinetic =
            finite_difference::matrix(molecule, DEFAULT_STEP, |m| kinetic(&build(m)));
        let numeric_nuclear = finite_difference::matrix(molecule, DEFAULT_STEP, |m| {
            nuclear_attraction(&build(m), m)
        });

        for atom in 0..molecule.n_atoms() {
            for axis in 0..3 {
                for (name, got, want) in [
                    ("dS/dR", &analytic[atom][axis].overlap, &numeric_overlap[atom][axis]),
                    ("dT/dR", &analytic[atom][axis].kinetic, &numeric_kinetic[atom][axis]),
                    ("dV/dR", &analytic[atom][axis].nuclear, &numeric_nuclear[atom][axis]),
                ] {
                    let worst = (got - want).amax();
                    assert!(
                        worst < 1e-6,
                        "{name} for atom {atom} axis {axis} differs by {worst:.3e}"
                    );
                    // And it is not trivially zero, which would make the
                    // comparison above meaningless.
                    assert!(want.amax() > 1e-6, "{name} for atom {atom} axis {axis} is empty");
                }
            }
        }
    }

    #[test]
    fn one_electron_derivatives_match_finite_differences() {
        let molecule = awkward();
        check_one_electron(&molecule, |m| BasisSet::sto3g(m).unwrap());
    }

    #[test]
    fn one_electron_derivatives_work_for_d_shells() {
        let molecule = awkward();
        check_one_electron(&molecule, with_d_functions);
    }

    /// Moving every nucleus together cannot change an integral, so every
    /// derivative matrix has to sum to zero over the atoms. This catches a
    /// missing Hellmann-Feynman term on its own: without it the nuclear
    /// attraction derivatives would not balance.
    #[test]
    fn one_electron_derivatives_are_translationally_invariant() {
        let molecule = awkward();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let derivatives = one_electron_derivatives(&basis, &molecule);
        for axis in 0..3 {
            let mut overlap_sum = DMatrix::zeros(basis.n_functions(), basis.n_functions());
            let mut core_sum = overlap_sum.clone();
            for atom in 0..molecule.n_atoms() {
                overlap_sum += &derivatives[atom][axis].overlap;
                core_sum += derivatives[atom][axis].core();
            }
            assert!(overlap_sum.amax() < 1e-12, "dS/dR did not sum to zero");
            assert!(core_sum.amax() < 1e-11, "d(T+V)/dR did not sum to zero");
        }
    }

    /// A symmetric, non-degenerate density matrix to contract derivative
    /// integrals against. Not a physical density - it only has to have no
    /// special structure that could hide an error.
    fn probe_density(n: usize) -> DMatrix<f64> {
        let raw = DMatrix::from_fn(n, n, |i, j| {
            0.3 * ((i * 7 + j * 3 + 1) as f64).sin() + 0.1 * (i as f64 - j as f64).cos()
        });
        (&raw + raw.transpose()) * 0.5
    }

    fn two_electron_energy(basis: &BasisSet, density: &DMatrix<f64>) -> f64 {
        0.5 * dot(density, &compute_eri(basis).coulomb(density))
    }

    #[test]
    fn two_electron_gradient_matches_finite_difference() {
        let molecule = awkward();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let density = probe_density(basis.n_functions());
        let analytic = two_electron_gradient(&basis, &molecule, &density, 0.0);
        let numeric = finite_difference::scalar(&molecule, DEFAULT_STEP, |m| {
            two_electron_energy(&BasisSet::sto3g(m).unwrap(), &density)
        });
        let worst = max_deviation(&analytic, &numeric);
        assert!(worst < 1e-6, "two-electron gradient differs by {worst:.3e}");
        assert!(
            finite_difference::max_component(&numeric) > 0.1,
            "nothing to compare against"
        );
    }

    #[test]
    fn two_electron_gradient_works_for_d_shells() {
        let molecule = awkward();
        let basis = with_d_functions(&molecule);
        let density = probe_density(basis.n_functions());
        let analytic = two_electron_gradient(&basis, &molecule, &density, 0.0);
        let numeric = finite_difference::scalar(&molecule, DEFAULT_STEP, |m| {
            two_electron_energy(&with_d_functions(m), &density)
        });
        let worst = max_deviation(&analytic, &numeric);
        assert!(worst < 1e-6, "two-electron gradient differs by {worst:.3e}");
    }

    /// The same statement as for the one-electron matrices, and here it is a
    /// genuine check rather than a tautology: all four centres of every quartet
    /// are differentiated explicitly instead of one being inferred from this.
    #[test]
    fn two_electron_gradient_is_translationally_invariant() {
        let molecule = awkward();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let density = probe_density(basis.n_functions());
        let gradient = two_electron_gradient(&basis, &molecule, &density, 0.0);
        for axis in 0..3 {
            let sum: f64 = gradient.iter().map(|g| g[axis]).sum();
            assert!(sum.abs() < 1e-10, "axis {axis} summed to {sum:.3e}");
        }
    }

    #[test]
    fn screening_does_not_move_the_two_electron_gradient() {
        // Two atoms far apart: screening has to fire and has to change nothing
        // that a force of 4.5e-4 Hartree/Bohr would notice.
        let molecule = Molecule::new(vec![
            Atom { z: 8, pos: [0.0, 0.0, 0.0] },
            Atom { z: 1, pos: [0.0, 0.0, 1.8] },
            Atom { z: 1, pos: [0.0, 0.0, 60.0] },
        ])
        .unwrap();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let density = probe_density(basis.n_functions());
        let screened = two_electron_gradient(&basis, &molecule, &density, GRADIENT_SCREENING);
        let exact = two_electron_gradient(&basis, &molecule, &density, 0.0);
        assert!(max_deviation(&screened, &exact) < 1e-10);
    }
}
