//! Two-electron repulsion integrals `(mu nu | lambda sigma)`.
//!
//! At STO-3G size every integral fits in memory (benzene needs 222 111 values,
//! 1.7 MB), so they are computed once and reused by every SCF iteration and,
//! later, by every geometry step that keeps the same structure.
//!
//! Four things keep the cost down:
//!
//! * the eight-fold permutation symmetry, which means only `pair(pair+1)/2`
//!   values are stored and computed;
//! * Schwarz screening, which skips a quartet when
//!   `sqrt((ab|ab)) * sqrt((cd|cd))` is already below the threshold;
//! * shell groups ([`BasisSet::groups`]): STO-3G's 2s and 2p share their
//!   exponents, so every Gaussian product - and every R table, the expensive
//!   part of a primitive quartet - is the same for both, and the quartet loop
//!   runs over groups. Carbon's valence quartet is one R table where it was
//!   sixteen;
//! * primitive pairs whose Gaussian-product factor underflows (two tight
//!   primitives on different atoms) are left out of their pair.

use nalgebra::DMatrix;

use super::md::{hermite_count, hermite_indices, HermiteE, HermiteR};
use super::onee::product_centre;
use crate::basis::{BasisSet, ShellGroup};

/// Quartets whose Schwarz bound falls below this are skipped. Well under the
/// SCF convergence threshold, so it cannot shift a converged energy.
pub const DEFAULT_SCREENING: f64 = 1e-12;

/// A primitive pair whose Gaussian-product factor, times its contraction
/// coefficients and a polynomial allowance, is below this is left out of its
/// shell pair. What it could still contribute to any integral is under `1e-14`
/// even against the largest prefactor and R table this basis produces.
const NEGLIGIBLE_PRIMITIVE_PAIR: f64 = 1e-22;

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

/// Hermite data for one pair of shell groups, built once and reused by every
/// quartet the pair appears in.
///
/// Components run over every function of the first group times every function
/// of the second. When both groups are the same this lists `(mu, nu)` and
/// `(nu, mu)` separately, which costs a little duplicated work and keeps every
/// consumer free of a special case.
pub(crate) struct ShellPair {
    pub(crate) group_a: usize,
    pub(crate) group_b: usize,
    /// Atoms the two groups sit on.
    pub(crate) centers: [usize; 2],
    /// `l_a + l_b` (largest in each group), plus one when this pair carries a
    /// derivative: the highest Hermite degree.
    pub(crate) order: usize,
    /// [`hermite_count`]`(order)`: the length of one coefficient vector.
    pub(crate) n_hermite: usize,
    pub(crate) n_components: usize,
    /// Basis-function indices `(mu, nu)` of each component.
    pub(crate) functions: Vec<(usize, usize)>,
    pub(crate) primitives: Vec<PrimitivePair>,
    /// Hermite coefficients in [`hermite_indices`] order, indexed
    /// `[primitive][component][hermite]`, with the contraction coefficients and
    /// the per-component normalisation already folded in.
    pub(crate) hermite: Vec<f64>,
    /// The same, times `(-1)^(t+u+v)`: the form a pair takes as the ket, whose
    /// Hermite Gaussians are derivatives with respect to Q rather than P.
    pub(crate) signed: Vec<f64>,
    /// For each component, the Hermite entries that can be non-zero at all
    /// (`t <= l_x^a + l_x^b` and so on). An s-s component has one, a p-p
    /// component three or four, out of the pair's full set; the quartet loop
    /// visits only these.
    pub(crate) support: Vec<Vec<usize>>,
    /// `sqrt(max |(ab|ab)|)`, the Schwarz bound for this pair. Zero on a
    /// derivative pair, which is never the thing screening is applied to.
    pub(crate) schwarz: f64,
}

impl ShellPair {
    /// Coefficients of one component of one primitive.
    #[inline]
    pub(crate) fn coefficients(&self, primitive: usize, component: usize) -> &[f64] {
        let start = (primitive * self.n_components + component) * self.n_hermite;
        &self.hermite[start..start + self.n_hermite]
    }
}

pub(crate) fn build_shell_pair(
    basis: &BasisSet,
    groups: &[ShellGroup],
    ga: usize,
    gb: usize,
) -> ShellPair {
    build_pair(basis, groups, ga, gb, None)
}

/// The same pair with one of its two groups differentiated with respect to the
/// nucleus it sits on.
pub(crate) fn build_shell_pair_derivative(
    basis: &BasisSet,
    groups: &[ShellGroup],
    ga: usize,
    gb: usize,
    deriv: Derivative,
) -> ShellPair {
    build_pair(basis, groups, ga, gb, Some(deriv))
}

fn build_pair(
    basis: &BasisSet,
    groups: &[ShellGroup],
    ga: usize,
    gb: usize,
    deriv: Option<Derivative>,
) -> ShellPair {
    let group_a = &groups[ga];
    let group_b = &groups[gb];
    let first_a = &basis.shells[group_a.shells[0]];
    let first_b = &basis.shells[group_b.shells[0]];
    let (max_l_a, max_l_b) = (group_a.max_l as usize, group_b.max_l as usize);
    // One extra order in both indices covers whichever group is raised.
    let raise = usize::from(deriv.is_some());
    let order = max_l_a + max_l_b + raise;
    let n_hermite = hermite_count(order);

    // Where each (t, u, v) lands in the packed layout, and its parity.
    let indices = hermite_indices(order);
    let span = order + 1;
    let mut packed = vec![usize::MAX; span * span * span];
    for (k, &[t, u, v]) in indices.iter().enumerate() {
        packed[(t * span + u) * span + v] = k;
    }

    // The components: every function of A against every function of B.
    struct Component {
        powers_a: [u8; 3],
        powers_b: [u8; 3],
        shell_a: usize,
        shell_b: usize,
        scale: f64,
    }
    let mut components = Vec::new();
    let mut functions = Vec::new();
    for &sa in &group_a.shells {
        let a = &basis.shells[sa];
        for (ca, (&powers_a, &scale_a)) in a.powers.iter().zip(&a.scales).enumerate() {
            for &sb in &group_b.shells {
                let b = &basis.shells[sb];
                for (cb, (&powers_b, &scale_b)) in b.powers.iter().zip(&b.scales).enumerate() {
                    components.push(Component {
                        powers_a,
                        powers_b,
                        shell_a: sa,
                        shell_b: sb,
                        scale: scale_a * scale_b,
                    });
                    functions.push((basis.offset(sa) + ca, basis.offset(sb) + cb));
                }
            }
        }
    }
    let n_components = components.len();

    // Highest Hermite index along one axis: one more where the angular
    // momentum was raised.
    let extent = |c: &Component, axis: usize| -> usize {
        (c.powers_a[axis] + c.powers_b[axis]) as usize
            + usize::from(matches!(deriv, Some(d) if d.axis == axis))
    };
    let support: Vec<Vec<usize>> = components
        .iter()
        .map(|c| {
            let mut reach = Vec::new();
            for t in 0..=extent(c, 0) {
                for u in 0..=extent(c, 1) {
                    for v in 0..=extent(c, 2) {
                        reach.push(packed[(t * span + u) * span + v]);
                    }
                }
            }
            reach.sort_unstable();
            reach
        })
        .collect();

    let n_primitives = first_a.n_primitives() * first_b.n_primitives();
    let mut primitives = Vec::with_capacity(n_primitives);
    let mut hermite = vec![0.0; n_primitives * n_components * n_hermite];

    // Largest |coefficient * scale| of each primitive over a group's members,
    // for the cut below.
    let reach = |group: &ShellGroup, k: usize| -> f64 {
        group
            .shells
            .iter()
            .map(|&s| {
                let shell = &basis.shells[s];
                let scale = shell.scales.iter().fold(0.0f64, |m, v| m.max(v.abs()));
                shell.coefficients[k].abs() * scale
            })
            .fold(0.0, f64::max)
    };
    let separation2: f64 =
        (0..3).map(|axis| (first_a.origin[axis] - first_b.origin[axis]).powi(2)).sum();
    // The same allowance with or without a derivative, so that a pair and its
    // derivatives keep exactly the same primitives.
    let polynomial = separation2.sqrt().max(1.0).powi((max_l_a + max_l_b + 1) as i32);

    for (ia, &alpha) in first_a.exponents.iter().enumerate() {
        for (ib, &beta) in first_b.exponents.iter().enumerate() {
            // Every Hermite coefficient of a primitive pair carries the
            // Gaussian-product factor exp(-mu R_AB^2); for two tight primitives
            // on different atoms (carbon 1s against carbon 1s is e^-240) the
            // whole pair is zero in double precision, and every quartet it
            // enters would multiply that zero through a full R table. The
            // decision depends only on exponents and geometry, so a pair and
            // its derivatives keep the same primitives in the same order.
            let mu = alpha * beta / (alpha + beta);
            let size = (-mu * separation2).exp() * reach(group_a, ia) * reach(group_b, ib);
            if size * polynomial < NEGLIGIBLE_PRIMITIVE_PAIR {
                continue;
            }
            let index = primitives.len();
            primitives.push(PrimitivePair {
                exponent: alpha + beta,
                centre: product_centre(alpha, first_a.origin, beta, first_b.origin),
            });
            let e: Vec<HermiteE> = (0..3)
                .map(|axis| {
                    HermiteE::new(
                        max_l_a + raise,
                        max_l_b + raise,
                        alpha,
                        beta,
                        first_a.origin[axis],
                        first_b.origin[axis],
                    )
                })
                .collect();
            for (component, c) in components.iter().enumerate() {
                let weight = basis.shells[c.shell_a].coefficients[ia]
                    * basis.shells[c.shell_b].coefficients[ib]
                    * c.scale;
                let base = (index * n_components + component) * n_hermite;
                // Expansion coefficient along one axis, carrying the
                // derivative when this is the axis being differentiated.
                let coefficient = |axis: usize, t: usize| -> f64 {
                    let i = c.powers_a[axis] as usize;
                    let j = c.powers_b[axis] as usize;
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
                for t in 0..=extent(c, 0) {
                    let ex = weight * coefficient(0, t);
                    for u in 0..=extent(c, 1) {
                        let ey = coefficient(1, u);
                        for v in 0..=extent(c, 2) {
                            let ez = coefficient(2, v);
                            hermite[base + packed[(t * span + u) * span + v]] = ex * ey * ez;
                        }
                    }
                }
            }
        }
    }

    hermite.truncate(primitives.len() * n_components * n_hermite);

    let parity: Vec<f64> = indices
        .iter()
        .map(|&[t, u, v]| if (t + u + v) % 2 == 0 { 1.0 } else { -1.0 })
        .collect();
    let signed = hermite
        .iter()
        .enumerate()
        .map(|(k, &value)| value * parity[k % n_hermite])
        .collect();

    ShellPair {
        group_a: ga,
        group_b: gb,
        centers: [group_a.center, group_b.center],
        order,
        n_hermite,
        n_components,
        functions,
        primitives,
        hermite,
        signed,
        support,
        schwarz: 0.0,
    }
}

/// Every unique pair of shell groups (`a >= b`), each carrying its Schwarz
/// bound.
pub(crate) fn shell_pairs(basis: &BasisSet, groups: &[ShellGroup]) -> Vec<ShellPair> {
    let mut pairs = Vec::with_capacity(groups.len() * (groups.len() + 1) / 2);
    for ga in 0..groups.len() {
        for gb in 0..=ga {
            pairs.push(build_shell_pair(basis, groups, ga, gb));
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

/// `2 pi^(5/2) / (p q sqrt(p + q))`, the factor every primitive quartet carries
/// in front of its Hermite sum.
#[inline]
pub(crate) fn quartet_prefactor(p: f64, q: f64) -> f64 {
    2.0 * std::f64::consts::PI.powf(2.5) / (p * q * (p + q).sqrt())
}

/// Contracts one quartet of shell pairs into `out`, indexed
/// `[bra component][ket component]`.
pub(crate) fn quartet(
    bra: &ShellPair,
    ket: &ShellPair,
    r: &mut HermiteR,
    g: &mut Vec<f64>,
    out: &mut Vec<f64>,
) {
    let order = bra.order + ket.order;
    let nb = bra.n_hermite;
    let nk = ket.n_hermite;

    out.clear();
    out.resize(bra.n_components * ket.n_components, 0.0);
    g.clear();
    g.resize(ket.n_components * nb, 0.0);

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
            let r0 = r.r0();
            let offsets = r.offsets();
            let prefactor = quartet_prefactor(p.exponent, q.exponent);

            // Contract the ket's Hermite coefficients against R first. That
            // turns a six-fold sum per integral into two three-fold sums.
            for kc in 0..ket.n_components {
                let coefficients = &ket.signed[(qi * ket.n_components + kc) * nk..][..nk];
                let support = &ket.support[kc];
                let row = &mut g[kc * nb..(kc + 1) * nb];
                for (a, slot) in row.iter_mut().enumerate() {
                    let base = offsets[a];
                    let mut sum = 0.0;
                    for &b in support {
                        sum += coefficients[b] * r0[base + offsets[b]];
                    }
                    *slot = sum;
                }
            }

            for bc in 0..bra.n_components {
                let coefficients = bra.coefficients(pi, bc);
                let support = &bra.support[bc];
                let target = &mut out[bc * ket.n_components..(bc + 1) * ket.n_components];
                for (kc, value) in target.iter_mut().enumerate() {
                    let row = &g[kc * nb..(kc + 1) * nb];
                    let mut sum = 0.0;
                    for &a in support {
                        sum += coefficients[a] * row[a];
                    }
                    *value += prefactor * sum;
                }
            }
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

    // Pairs of shell groups, each already carrying its Schwarz bound.
    let groups = basis.groups();
    let pairs = shell_pairs(basis, &groups);

    for (i, bra) in pairs.iter().enumerate() {
        for ket in pairs.iter().take(i + 1) {
            if bra.schwarz * ket.schwarz < threshold {
                tensor.skipped += 1;
                continue;
            }
            quartet(bra, ket, &mut r, &mut g, &mut block);
            for (bc, &(mu, nu)) in bra.functions.iter().enumerate() {
                let row = &block[bc * ket.n_components..(bc + 1) * ket.n_components];
                for (&value, &(lambda, sigma)) in row.iter().zip(&ket.functions) {
                    tensor.values[EriTensor::index(mu, nu, lambda, sigma)] = value;
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
