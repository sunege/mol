//! Two-electron repulsion integrals `(mu nu | lambda sigma)`.
//!
//! At STO-3G size every integral fits in memory (benzene needs 222 111 values,
//! 1.7 MB), so they are computed once and reused by every SCF iteration and,
//! later, by every geometry step that keeps the same structure.
//!
//! Two things keep the cost down: the eight-fold permutation symmetry, which
//! means only `pair(pair+1)/2` values are stored and computed, and Schwarz
//! screening, which skips a shell quartet when
//! `sqrt((ab|ab)) * sqrt((cd|cd))` is already below the threshold.

use nalgebra::DMatrix;

use super::md::{HermiteE, HermiteR};
use super::onee::product_centre;
use crate::basis::{cartesian_powers, BasisSet};

/// Quartets whose Schwarz bound falls below this are skipped. Well under the
/// SCF convergence threshold, so it cannot shift a converged energy.
pub const DEFAULT_SCREENING: f64 = 1e-12;

/// All unique two-electron integrals of a basis set.
#[derive(Debug, Clone)]
pub struct EriTensor {
    n: usize,
    values: Vec<f64>,
    /// Quartets skipped by screening, for diagnostics.
    pub skipped: usize,
}

/// Canonical index of an unordered pair.
#[inline]
fn pair_index(i: usize, j: usize) -> usize {
    if i >= j {
        i * (i + 1) / 2 + j
    } else {
        j * (j + 1) / 2 + i
    }
}

impl EriTensor {
    /// Flat index of `(ij|kl)` under the full eight-fold symmetry.
    #[inline]
    pub fn index(i: usize, j: usize, k: usize, l: usize) -> usize {
        let ij = pair_index(i, j);
        let kl = pair_index(k, l);
        if ij >= kl {
            ij * (ij + 1) / 2 + kl
        } else {
            kl * (kl + 1) / 2 + ij
        }
    }

    #[inline]
    pub fn get(&self, i: usize, j: usize, k: usize, l: usize) -> f64 {
        self.values[Self::index(i, j, k, l)]
    }

    pub fn n_functions(&self) -> usize {
        self.n
    }

    /// Number of stored values.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Coulomb matrix `J_mu_nu = sum_lambda_sigma D_lambda_sigma (mu nu|lambda sigma)`.
    ///
    /// LDA has no exact-exchange term, so this is the only two-electron matrix
    /// the SCF needs.
    pub fn coulomb(&self, density: &DMatrix<f64>) -> DMatrix<f64> {
        let n = self.n;
        debug_assert_eq!(density.nrows(), n);
        let mut j = DMatrix::zeros(n, n);
        for mu in 0..n {
            for nu in 0..=mu {
                let mut sum = 0.0;
                for lambda in 0..n {
                    for sigma in 0..n {
                        sum += density[(lambda, sigma)] * self.get(mu, nu, lambda, sigma);
                    }
                }
                j[(mu, nu)] = sum;
                j[(nu, mu)] = sum;
            }
        }
        j
    }
}

/// One primitive of a contracted shell pair.
pub(crate) struct PrimitivePair {
    /// Combined exponent `p = a + b`.
    pub(crate) exponent: f64,
    /// Gaussian product centre.
    pub(crate) centre: [f64; 3],
    /// Product of the two contraction coefficients.
    pub(crate) coefficient: f64,
}

/// Which shell of a pair is differentiated, and along which axis.
///
/// Differentiating a Gaussian with respect to the nucleus it sits on gives
/// another pair of Gaussians on the same nucleus:
///
/// ```text
/// d/dA_x phi(i, j, k) = 2a phi(i+1, j, k) - i phi(i-1, j, k)
/// ```
///
/// so the derivative of a shell pair is an ordinary shell pair with different
/// Hermite coefficients and one more order. Everything downstream - the quartet
/// contraction, the normalisation factors, the component layout - is unchanged,
/// which is why the gradient needs no second integral kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Derivative {
    /// 0 for the pair's first shell, 1 for its second.
    pub(crate) shell: usize,
    pub(crate) axis: usize,
}

/// Hermite data for one shell pair, built once and reused by every quartet the
/// pair appears in.
pub(crate) struct ShellPair {
    pub(crate) shell_a: usize,
    pub(crate) shell_b: usize,
    /// `l_a + l_b`, plus one when this pair carries a derivative: the highest
    /// Hermite index.
    pub(crate) order: usize,
    /// Stride of the Hermite cube, `order + 1`.
    pub(crate) span: usize,
    /// Components of A times components of B.
    pub(crate) n_components: usize,
    pub(crate) primitives: Vec<PrimitivePair>,
    /// Hermite coefficients, indexed `[primitive][component][t][u][v]`.
    pub(crate) hermite: Vec<f64>,
    /// Per-component normalisation products, indexed like the component axis.
    pub(crate) scales: Vec<f64>,
    /// `sqrt(max |(ab|ab)|)`, the Schwarz bound for this pair. Zero on a
    /// derivative pair, which is never the thing screening is applied to.
    pub(crate) schwarz: f64,
}

impl ShellPair {
    fn cube(&self) -> usize {
        self.span * self.span * self.span
    }

    #[inline]
    fn offset(&self, primitive: usize, component: usize) -> usize {
        (primitive * self.n_components + component) * self.cube()
    }
}

pub(crate) fn build_shell_pair(basis: &BasisSet, sa: usize, sb: usize) -> ShellPair {
    build_pair(basis, sa, sb, None)
}

/// The same pair with one of its two shells differentiated with respect to the
/// nucleus it sits on.
pub(crate) fn build_shell_pair_derivative(
    basis: &BasisSet,
    sa: usize,
    sb: usize,
    deriv: Derivative,
) -> ShellPair {
    build_pair(basis, sa, sb, Some(deriv))
}

fn build_pair(
    basis: &BasisSet,
    sa: usize,
    sb: usize,
    deriv: Option<Derivative>,
) -> ShellPair {
    let a = &basis.shells[sa];
    let b = &basis.shells[sb];
    let powers_a = cartesian_powers(a.l);
    let powers_b = cartesian_powers(b.l);
    let order = (a.l + b.l) as usize + usize::from(deriv.is_some());
    let span = order + 1;
    let cube = span * span * span;
    let n_components = powers_a.len() * powers_b.len();
    // One extra order in both indices covers whichever shell is raised; the
    // unused half costs a few coefficients and no branching in the hot loop.
    let raise = usize::from(deriv.is_some());

    let mut primitives = Vec::with_capacity(a.n_primitives() * b.n_primitives());
    let mut hermite = vec![0.0; a.n_primitives() * b.n_primitives() * n_components * cube];

    for (ia, &alpha) in a.exponents.iter().enumerate() {
        for (ib, &beta) in b.exponents.iter().enumerate() {
            let index = primitives.len();
            primitives.push(PrimitivePair {
                exponent: alpha + beta,
                centre: product_centre(alpha, a.origin, beta, b.origin),
                coefficient: a.coefficients[ia] * b.coefficients[ib],
            });
            let e: Vec<HermiteE> = (0..3)
                .map(|axis| {
                    HermiteE::new(
                        a.l as usize + raise,
                        b.l as usize + raise,
                        alpha,
                        beta,
                        a.origin[axis],
                        b.origin[axis],
                    )
                })
                .collect();
            for (ca, pa) in powers_a.iter().enumerate() {
                for (cb, pb) in powers_b.iter().enumerate() {
                    let component = ca * powers_b.len() + cb;
                    let base = (index * n_components + component) * cube;
                    // Expansion coefficient along one axis, carrying the
                    // derivative when this is the axis being differentiated.
                    let coefficient = |axis: usize, t: usize| -> f64 {
                        let i = pa[axis] as usize;
                        let j = pb[axis] as usize;
                        let t = t as isize;
                        match deriv {
                            Some(d) if d.axis == axis && d.shell == 0 => {
                                let up = 2.0 * alpha * e[axis].at(i + 1, j, t);
                                let down =
                                    if i == 0 { 0.0 } else { i as f64 * e[axis].at(i - 1, j, t) };
                                up - down
                            }
                            Some(d) if d.axis == axis => {
                                let up = 2.0 * beta * e[axis].at(i, j + 1, t);
                                let down =
                                    if j == 0 { 0.0 } else { j as f64 * e[axis].at(i, j - 1, t) };
                                up - down
                            }
                            _ => e[axis].at(i, j, t),
                        }
                    };
                    // Highest Hermite index along one axis: one more where the
                    // angular momentum was raised.
                    let extent = |axis: usize| -> usize {
                        (pa[axis] + pb[axis]) as usize
                            + usize::from(matches!(deriv, Some(d) if d.axis == axis))
                    };
                    for t in 0..=extent(0) {
                        let ex = coefficient(0, t);
                        for u in 0..=extent(1) {
                            let ey = coefficient(1, u);
                            for v in 0..=extent(2) {
                                let ez = coefficient(2, v);
                                hermite[base + (t * span + u) * span + v] = ex * ey * ez;
                            }
                        }
                    }
                }
            }
        }
    }

    let mut scales = Vec::with_capacity(n_components);
    for &scale_a in &a.scales {
        for &scale_b in &b.scales {
            scales.push(scale_a * scale_b);
        }
    }

    ShellPair {
        shell_a: sa,
        shell_b: sb,
        order,
        span,
        n_components,
        primitives,
        hermite,
        scales,
        schwarz: 0.0,
    }
}

/// Every unique shell pair of a basis, each carrying its Schwarz bound.
pub(crate) fn shell_pairs(basis: &BasisSet) -> Vec<ShellPair> {
    let mut pairs = Vec::with_capacity(basis.n_shells() * (basis.n_shells() + 1) / 2);
    for sa in 0..basis.n_shells() {
        for sb in 0..=sa {
            pairs.push(build_shell_pair(basis, sa, sb));
        }
    }

    let mut r = HermiteR::new(4 * basis.max_angular_momentum() as usize);
    let mut g = Vec::new();
    let mut block = Vec::new();
    for index in 0..pairs.len() {
        let pair = &pairs[index];
        quartet(pair, pair, &mut r, &mut g, &mut block);
        let mut max = 0.0f64;
        for component in 0..pair.n_components {
            max = max.max(block[component * pair.n_components + component].abs());
        }
        pairs[index].schwarz = max.sqrt();
    }
    pairs
}

/// Contracts one quartet of shell pairs into `out`, indexed
/// `[bra component][ket component]`, with the normalisation factors applied.
pub(crate) fn quartet(
    bra: &ShellPair,
    ket: &ShellPair,
    r: &mut HermiteR,
    g: &mut Vec<f64>,
    out: &mut Vec<f64>,
) {
    let prefactor_base = 2.0 * std::f64::consts::PI.powf(2.5);
    let order = bra.order + ket.order;
    let bra_cube = bra.cube();

    out.clear();
    out.resize(bra.n_components * ket.n_components, 0.0);
    g.clear();
    g.resize(ket.n_components * bra_cube, 0.0);

    for (pi, p) in bra.primitives.iter().enumerate() {
        for (qi, q) in ket.primitives.iter().enumerate() {
            let alpha = p.exponent * q.exponent / (p.exponent + q.exponent);
            r.compute(
                order,
                alpha,
                [
                    p.centre[0] - q.centre[0],
                    p.centre[1] - q.centre[1],
                    p.centre[2] - q.centre[2],
                ],
            );
            let prefactor = prefactor_base
                / (p.exponent * q.exponent * (p.exponent + q.exponent).sqrt())
                * p.coefficient
                * q.coefficient;

            // Contract the ket's Hermite coefficients against R first. That
            // turns a six-fold sum per integral into two three-fold sums.
            for kc in 0..ket.n_components {
                let ket_base = ket.offset(qi, kc);
                for t in 0..=bra.order {
                    for u in 0..=(bra.order - t) {
                        for v in 0..=(bra.order - t - u) {
                            let mut sum = 0.0;
                            for tau in 0..=ket.order {
                                for nu in 0..=(ket.order - tau) {
                                    for phi in 0..=(ket.order - tau - nu) {
                                        let c = ket.hermite
                                            [ket_base + (tau * ket.span + nu) * ket.span + phi];
                                        if c == 0.0 {
                                            continue;
                                        }
                                        // The ket's Hermite Gaussians are
                                        // derivatives with respect to Q rather
                                        // than P, hence the alternating sign.
                                        let sign =
                                            if (tau + nu + phi) % 2 == 0 { 1.0 } else { -1.0 };
                                        sum += sign * c * r.get(t + tau, u + nu, v + phi);
                                    }
                                }
                            }
                            g[kc * bra_cube + (t * bra.span + u) * bra.span + v] = sum;
                        }
                    }
                }
            }

            for bc in 0..bra.n_components {
                let bra_base = bra.offset(pi, bc);
                for kc in 0..ket.n_components {
                    let mut sum = 0.0;
                    for t in 0..=bra.order {
                        for u in 0..=(bra.order - t) {
                            for v in 0..=(bra.order - t - u) {
                                let idx = (t * bra.span + u) * bra.span + v;
                                sum += bra.hermite[bra_base + idx] * g[kc * bra_cube + idx];
                            }
                        }
                    }
                    out[bc * ket.n_components + kc] += prefactor * sum;
                }
            }
        }
    }

    for bc in 0..bra.n_components {
        for kc in 0..ket.n_components {
            out[bc * ket.n_components + kc] *= bra.scales[bc] * ket.scales[kc];
        }
    }
}

/// Computes every unique two-electron integral of `basis`.
pub fn compute(basis: &BasisSet) -> EriTensor {
    compute_with_screening(basis, DEFAULT_SCREENING)
}

/// As [`compute`], with an explicit Schwarz threshold (a test uses zero to check
/// that screening changes nothing that matters).
pub fn compute_with_screening(basis: &BasisSet, threshold: f64) -> EriTensor {
    let n = basis.n_functions();
    let n_pairs = n * (n + 1) / 2;
    let mut tensor = EriTensor {
        n,
        values: vec![0.0; n_pairs * (n_pairs + 1) / 2],
        skipped: 0,
    };

    let max_order = 4 * basis.max_angular_momentum() as usize;
    let mut r = HermiteR::new(max_order);
    let mut g = Vec::new();
    let mut block = Vec::new();

    // Shell pairs, each already carrying its Schwarz bound.
    let pairs = shell_pairs(basis);

    for (i, bra) in pairs.iter().enumerate() {
        for ket in pairs.iter().take(i + 1) {
            if bra.schwarz * ket.schwarz < threshold {
                tensor.skipped += 1;
                continue;
            }
            quartet(bra, ket, &mut r, &mut g, &mut block);

            let offset_a = basis.offset(bra.shell_a);
            let offset_b = basis.offset(bra.shell_b);
            let offset_c = basis.offset(ket.shell_a);
            let offset_d = basis.offset(ket.shell_b);
            let nb = basis.shells[bra.shell_b].n_components();
            let nd = basis.shells[ket.shell_b].n_components();

            for bc in 0..bra.n_components {
                let mu = offset_a + bc / nb;
                let nu = offset_b + bc % nb;
                for kc in 0..ket.n_components {
                    let lambda = offset_c + kc / nd;
                    let sigma = offset_d + kc % nd;
                    tensor.values[EriTensor::index(mu, nu, lambda, sigma)] =
                        block[bc * ket.n_components + kc];
                }
            }
        }
    }
    tensor
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis::Shell;
    use approx::assert_relative_eq;

    /// `(ss|ss)` for two normalised s primitives has a closed form; it is the
    /// only two-electron integral that does, which makes it the one independent
    /// check available without external reference data.
    #[test]
    fn ss_ss_matches_the_closed_form() {
        let (a, b, c, d) = (0.9, 1.4, 0.6, 2.1);
        let ra = [0.0, 0.0, 0.0];
        let rb = [0.3, -0.5, 0.8];
        let rc = [1.2, 0.4, -0.2];
        let rd = [-0.7, 0.9, 0.1];
        let basis = BasisSet::from_shells(vec![
            Shell::new(0, ra, 0, &[a], &[1.0]),
            Shell::new(1, rb, 0, &[b], &[1.0]),
            Shell::new(2, rc, 0, &[c], &[1.0]),
            Shell::new(3, rd, 0, &[d], &[1.0]),
        ]);
        let eri = compute(&basis);

        // Normalisation of a single s primitive.
        let norm = |e: f64| (2.0 * e / std::f64::consts::PI).powf(0.75);
        let dist2 = |x: [f64; 3], y: [f64; 3]| {
            (0..3).map(|k| (x[k] - y[k]).powi(2)).sum::<f64>()
        };
        let p = a + b;
        let q = c + d;
        let centre_p = [
            (a * ra[0] + b * rb[0]) / p,
            (a * ra[1] + b * rb[1]) / p,
            (a * ra[2] + b * rb[2]) / p,
        ];
        let centre_q = [
            (c * rc[0] + d * rd[0]) / q,
            (c * rc[1] + d * rd[1]) / q,
            (c * rc[2] + d * rd[2]) / q,
        ];
        let alpha = p * q / (p + q);
        let t = alpha * dist2(centre_p, centre_q);
        let expected = norm(a)
            * norm(b)
            * norm(c)
            * norm(d)
            * 2.0
            * std::f64::consts::PI.powf(2.5)
            / (p * q * (p + q).sqrt())
            * (-a * b / p * dist2(ra, rb)).exp()
            * (-c * d / q * dist2(rc, rd)).exp()
            * super::super::boys::boys(0, t)[0];

        assert_relative_eq!(eri.get(0, 1, 2, 3), expected, max_relative = 1e-13);
    }

    #[test]
    fn permutation_symmetry_holds() {
        let basis = BasisSet::from_shells(vec![
            Shell::new(0, [0.0, 0.0, 0.0], 0, &[1.3, 0.4], &[0.6, 0.5]),
            Shell::new(1, [0.9, 0.2, -0.4], 1, &[0.8, 0.25], &[0.4, 0.7]),
        ]);
        let eri = compute(&basis);
        let n = basis.n_functions();
        for i in 0..n {
            for j in 0..n {
                for k in 0..n {
                    for l in 0..n {
                        let value = eri.get(i, j, k, l);
                        for &(a, b, c, d) in &[
                            (j, i, k, l),
                            (i, j, l, k),
                            (j, i, l, k),
                            (k, l, i, j),
                            (l, k, i, j),
                            (k, l, j, i),
                            (l, k, j, i),
                        ] {
                            assert_relative_eq!(eri.get(a, b, c, d), value, epsilon = 1e-15);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn diagonal_integrals_are_positive() {
        // (mu mu|mu mu) is the self-repulsion of a charge distribution, so it
        // must be positive whatever the angular momentum.
        let basis = BasisSet::from_shells(vec![
            Shell::new(0, [0.0, 0.0, 0.0], 2, &[1.1, 0.3], &[0.5, 0.6]),
        ]);
        let eri = compute(&basis);
        for mu in 0..basis.n_functions() {
            assert!(eri.get(mu, mu, mu, mu) > 0.0);
        }
    }

    #[test]
    fn coulomb_matrix_agrees_with_an_explicit_sum() {
        let basis = BasisSet::from_shells(vec![
            Shell::new(0, [0.0, 0.0, 0.0], 0, &[1.3, 0.4], &[0.6, 0.5]),
            Shell::new(1, [0.9, 0.2, -0.4], 1, &[0.8, 0.25], &[0.4, 0.7]),
        ]);
        let eri = compute(&basis);
        let n = basis.n_functions();
        let mut density = DMatrix::zeros(n, n);
        for i in 0..n {
            for j in 0..n {
                density[(i, j)] = 0.1 * (i as f64 + 1.0) * (j as f64 + 2.0).sqrt();
            }
        }
        let density = (&density + &density.transpose()) * 0.5;
        let j = eri.coulomb(&density);
        for mu in 0..n {
            for nu in 0..n {
                let mut expected = 0.0;
                for lambda in 0..n {
                    for sigma in 0..n {
                        expected += density[(lambda, sigma)] * eri.get(mu, nu, lambda, sigma);
                    }
                }
                assert_relative_eq!(j[(mu, nu)], expected, epsilon = 1e-13);
            }
        }
    }

    #[test]
    fn screening_only_discards_negligible_quartets() {
        // Two atoms far apart: screening must fire, and the integrals it keeps
        // must be identical to the unscreened ones.
        let basis = BasisSet::from_shells(vec![
            Shell::new(0, [0.0, 0.0, 0.0], 0, &[1.3, 0.4], &[0.6, 0.5]),
            Shell::new(1, [0.0, 0.0, 40.0], 1, &[0.8, 0.25], &[0.4, 0.7]),
        ]);
        let screened = compute_with_screening(&basis, 1e-12);
        let exact = compute_with_screening(&basis, 0.0);
        assert!(screened.skipped > 0, "nothing was screened");
        let n = basis.n_functions();
        for i in 0..n {
            for j in 0..n {
                for k in 0..n {
                    for l in 0..n {
                        assert!(
                            (screened.get(i, j, k, l) - exact.get(i, j, k, l)).abs() < 1e-12
                        );
                    }
                }
            }
        }
    }
}
