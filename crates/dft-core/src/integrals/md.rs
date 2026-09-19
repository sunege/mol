//! The McMurchie-Davidson machinery shared by every Gaussian integral.
//!
//! Two pieces:
//!
//! * [`HermiteE`] expands a product of two Cartesian Gaussians in Hermite
//!   Gaussians centred on the product centre, one Cartesian direction at a time.
//! * [`HermiteR`] holds the auxiliary Coulomb integrals `R^0_tuv`, built from
//!   the Boys function by a recursion in `t`, `u` and `v`.
//!
//! Both are written for arbitrary angular momentum, so switching the basis to
//! one with d or f functions needs no new integral code.

use super::boys::boys_into;

/// Hermite expansion coefficients `E_t^ij` for one Cartesian direction.
///
/// `x_A^i x_B^j exp(-a x_A^2) exp(-b x_B^2) = sum_t E_t^ij * Lambda_t(x_P)`
/// where `Lambda_t` is the `t`-th Hermite Gaussian about the product centre.
pub struct HermiteE {
    j_stride: usize,
    t_stride: usize,
    t_max: usize,
    values: Vec<f64>,
}

impl HermiteE {
    /// Builds all coefficients up to `i_max`, `j_max` for primitives with
    /// exponents `a`, `b` centred at `ax`, `bx`.
    pub fn new(i_max: usize, j_max: usize, a: f64, b: f64, ax: f64, bx: f64) -> Self {
        let p = a + b;
        let mu = a * b / p;
        let xp = (a * ax + b * bx) / p;
        let xpa = xp - ax;
        let xpb = xp - bx;
        let xab = ax - bx;
        let half_inv_p = 0.5 / p;

        let t_max = i_max + j_max;
        let t_stride = t_max + 1;
        let j_stride = (j_max + 1) * t_stride;
        let mut e = HermiteE {
            j_stride,
            t_stride,
            t_max,
            values: vec![0.0; (i_max + 1) * j_stride],
        };
        e.values[0] = (-mu * xab * xab).exp();

        // Raise i with j = 0, then raise j for every i. Each step reads only
        // entries that are already filled.
        for i in 0..i_max {
            for t in 0..=(i + 1) {
                let value = half_inv_p * e.at(i, 0, t as isize - 1)
                    + xpa * e.at(i, 0, t as isize)
                    + (t + 1) as f64 * e.at(i, 0, t as isize + 1);
                e.set(i + 1, 0, t, value);
            }
        }
        for i in 0..=i_max {
            for j in 0..j_max {
                for t in 0..=(i + j + 1) {
                    let value = half_inv_p * e.at(i, j, t as isize - 1)
                        + xpb * e.at(i, j, t as isize)
                        + (t + 1) as f64 * e.at(i, j, t as isize + 1);
                    e.set(i, j + 1, t, value);
                }
            }
        }
        e
    }

    /// `E_t^ij`, or zero when `t` is outside the expansion.
    #[inline]
    pub fn at(&self, i: usize, j: usize, t: isize) -> f64 {
        if t < 0 || t as usize > self.t_max {
            return 0.0;
        }
        self.values[i * self.j_stride + j * self.t_stride + t as usize]
    }

    /// `E_t^ij` for `t` known to be in range.
    #[inline]
    pub fn get(&self, i: usize, j: usize, t: usize) -> f64 {
        debug_assert!(t <= self.t_max);
        self.values[i * self.j_stride + j * self.t_stride + t]
    }

    #[inline]
    fn set(&mut self, i: usize, j: usize, t: usize, value: f64) {
        self.values[i * self.j_stride + j * self.t_stride + t] = value;
    }
}

/// Number of Hermite indices `(t, u, v)` with `t + u + v <= order`.
pub const fn hermite_count(order: usize) -> usize {
    (order + 1) * (order + 2) * (order + 3) / 6
}

/// Hermite indices `(t, u, v)` with `t + u + v <= order`, listed by total
/// degree.
///
/// Ordering by degree makes the list for a lower order a prefix of the list for
/// a higher one. A shell pair's coefficients (order `L`) and those of its
/// derivative (order `L + 1`) therefore share one layout, and "every index up to
/// `L`" is simply the first [`hermite_count`]`(L)` entries.
pub fn hermite_indices(order: usize) -> Vec<[usize; 3]> {
    let mut indices = Vec::with_capacity(hermite_count(order));
    for degree in 0..=order {
        for t in (0..=degree).rev() {
            for u in (0..=(degree - t)).rev() {
                indices.push([t, u, degree - t - u]);
            }
        }
    }
    indices
}

/// Auxiliary Coulomb integrals `R^0_tuv(alpha, R)`, reusing one allocation
/// across the whole integral loop.
///
/// The recursion needs the higher-order family `R^n_tuv`, so the scratch buffer
/// is four-dimensional; only the `n = 0` slice is read afterwards.
pub struct HermiteR {
    stride: usize,
    buffer: Vec<f64>,
    boys: Vec<f64>,
    /// Position of each entry of [`hermite_indices`]`(max_order)` in the
    /// `n = 0` cube.
    offsets: Vec<usize>,
    /// The recursion for each total order, unrolled into steps (see
    /// [`RecursionStep`]).
    programs: Vec<Vec<RecursionStep>>,
}

/// One step of the recursion, `R^n_(..k..) = d_axis R^(n+1)_(..k-1..) + (k-1)
/// R^(n+1)_(..k-2..)`, with its buffer positions worked out in advance.
///
/// Which entries the recursion visits, and in what order, depends only on the
/// total order, never on the exponent or the geometry; the index arithmetic of
/// a four-dimensional table was most of what `compute` spent its time on.
#[derive(Debug, Clone, Copy)]
struct RecursionStep {
    target: u32,
    first: u32,
    second: u32,
    axis: u8,
    /// `k - 1`; zero when there is no second term.
    weight: f64,
}

impl HermiteR {
    /// Allocates for total Hermite order up to `max_order` (the sum of all
    /// angular momenta involved).
    pub fn new(max_order: usize) -> Self {
        let stride = max_order + 1;
        let offsets = hermite_indices(max_order)
            .into_iter()
            .map(|[t, u, v]| (t * stride + u) * stride + v)
            .collect();
        let index = |n: usize, t: usize, u: usize, v: usize| -> u32 {
            (((n * stride + t) * stride + u) * stride + v) as u32
        };
        let programs = (0..=max_order)
            .map(|order| {
                let mut steps = Vec::new();
                // One Cartesian direction at a time: v, then u, then t. Every
                // read is of an entry an earlier step wrote.
                let mut push = |target: u32, first: u32, second: u32, axis: u8, k: usize| {
                    steps.push(RecursionStep {
                        target,
                        first,
                        second,
                        axis,
                        weight: k.saturating_sub(1) as f64,
                    });
                };
                for v in 1..=order {
                    for n in 0..=(order - v) {
                        let second = if v >= 2 { index(n + 1, 0, 0, v - 2) } else { 0 };
                        push(index(n, 0, 0, v), index(n + 1, 0, 0, v - 1), second, 2, v);
                    }
                }
                for v in 0..=order {
                    for u in 1..=(order - v) {
                        for n in 0..=(order - u - v) {
                            let second = if u >= 2 { index(n + 1, 0, u - 2, v) } else { 0 };
                            push(index(n, 0, u, v), index(n + 1, 0, u - 1, v), second, 1, u);
                        }
                    }
                }
                for v in 0..=order {
                    for u in 0..=(order - v) {
                        for t in 1..=(order - u - v) {
                            for n in 0..=(order - t - u - v) {
                                let second = if t >= 2 { index(n + 1, t - 2, u, v) } else { 0 };
                                push(index(n, t, u, v), index(n + 1, t - 1, u, v), second, 0, t);
                            }
                        }
                    }
                }
                steps
            })
            .collect();
        HermiteR {
            stride,
            buffer: vec![0.0; stride * stride * stride * stride],
            boys: vec![0.0; stride],
            offsets,
            programs,
        }
    }

    /// Where `R^0` of each [`hermite_indices`] entry sits in [`r0`](Self::r0).
    ///
    /// The position of a sum of two indices is the sum of their positions, so
    /// `R^0_(t+tau, u+nu, v+phi)` is `r0()[offsets()[i] + offsets()[j]]`. That is
    /// what turns every contraction against R into a flat double loop.
    #[inline]
    pub fn offsets(&self) -> &[usize] {
        &self.offsets
    }

    /// The `n = 0` cube from the most recent [`compute`](Self::compute).
    #[inline]
    pub fn r0(&self) -> &[f64] {
        &self.buffer[..self.stride * self.stride * self.stride]
    }

    #[inline]
    fn index(&self, n: usize, t: usize, u: usize, v: usize) -> usize {
        ((n * self.stride + t) * self.stride + u) * self.stride + v
    }

    /// Recomputes the table for a Gaussian-product separation `d` and exponent
    /// `alpha`, up to total order `order` (which must not exceed `max_order`).
    pub fn compute(&mut self, order: usize, alpha: f64, d: [f64; 3]) {
        debug_assert!(order < self.stride);
        let r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        boys_into(alpha * r2, &mut self.boys[..=order]);

        let mut factor = 1.0;
        for n in 0..=order {
            let idx = self.index(n, 0, 0, 0);
            self.buffer[idx] = factor * self.boys[n];
            factor *= -2.0 * alpha;
        }

        for step in &self.programs[order] {
            let mut value = d[step.axis as usize] * self.buffer[step.first as usize];
            if step.weight != 0.0 {
                value += step.weight * self.buffer[step.second as usize];
            }
            self.buffer[step.target as usize] = value;
        }
    }

    /// The recursion written out loop by loop, as `compute` did before its
    /// steps were precomputed. Kept to hold the two together.
    #[cfg(test)]
    fn compute_directly(&mut self, order: usize, alpha: f64, d: [f64; 3]) {
        let r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        boys_into(alpha * r2, &mut self.boys[..=order]);
        let mut factor = 1.0;
        for n in 0..=order {
            let idx = self.index(n, 0, 0, 0);
            self.buffer[idx] = factor * self.boys[n];
            factor *= -2.0 * alpha;
        }
        for v in 1..=order {
            for n in 0..=(order - v) {
                let mut value = d[2] * self.buffer[self.index(n + 1, 0, 0, v - 1)];
                if v >= 2 {
                    value += (v - 1) as f64 * self.buffer[self.index(n + 1, 0, 0, v - 2)];
                }
                let idx = self.index(n, 0, 0, v);
                self.buffer[idx] = value;
            }
        }
        for v in 0..=order {
            for u in 1..=(order - v) {
                for n in 0..=(order - u - v) {
                    let mut value = d[1] * self.buffer[self.index(n + 1, 0, u - 1, v)];
                    if u >= 2 {
                        value += (u - 1) as f64 * self.buffer[self.index(n + 1, 0, u - 2, v)];
                    }
                    let idx = self.index(n, 0, u, v);
                    self.buffer[idx] = value;
                }
            }
        }
        for v in 0..=order {
            for u in 0..=(order - v) {
                for t in 1..=(order - u - v) {
                    for n in 0..=(order - t - u - v) {
                        let mut value = d[0] * self.buffer[self.index(n + 1, t - 1, u, v)];
                        if t >= 2 {
                            value +=
                                (t - 1) as f64 * self.buffer[self.index(n + 1, t - 2, u, v)];
                        }
                        let idx = self.index(n, t, u, v);
                        self.buffer[idx] = value;
                    }
                }
            }
        }
    }

    /// `R^0_tuv` from the most recent [`compute`](Self::compute).
    #[inline]
    pub fn get(&self, t: usize, u: usize, v: usize) -> f64 {
        self.buffer[self.index(0, t, u, v)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    /// Midpoint quadrature of the one-dimensional Gaussian product.
    fn product_moment(i: usize, j: usize, a: f64, b: f64, ax: f64, bx: f64) -> f64 {
        const N: usize = 400_000;
        let (lo, hi) = (-12.0, 12.0);
        let h = (hi - lo) / N as f64;
        let mut sum = 0.0;
        for k in 0..N {
            let x = lo + (k as f64 + 0.5) * h;
            sum += (x - ax).powi(i as i32)
                * (x - bx).powi(j as i32)
                * (-a * (x - ax).powi(2)).exp()
                * (-b * (x - bx).powi(2)).exp();
        }
        sum * h
    }

    #[test]
    fn zeroth_coefficient_reproduces_the_one_dimensional_overlap() {
        // Integrating the Hermite expansion term by term leaves only t = 0,
        // because every higher Hermite Gaussian is a derivative and integrates
        // to zero. So int (x-A)^i (x-B)^j G_a G_b dx = E_0^ij sqrt(pi/p).
        let (a, b, ax, bx) = (0.8, 1.7, -0.4, 0.9);
        let p = a + b;
        let e = HermiteE::new(3, 3, a, b, ax, bx);
        for i in 0..=3 {
            for j in 0..=3 {
                let expected = product_moment(i, j, a, b, ax, bx);
                let got = e.get(i, j, 0) * (std::f64::consts::PI / p).sqrt();
                assert_relative_eq!(got, expected, max_relative = 1e-6);
            }
        }
    }

    #[test]
    fn coincident_centres_collapse_to_a_single_term() {
        // With A = B and i = j = 0 the product is already a Hermite Gaussian.
        let e = HermiteE::new(0, 0, 1.0, 2.0, 0.5, 0.5);
        assert_relative_eq!(e.get(0, 0, 0), 1.0, epsilon = 1e-15);
    }

    #[test]
    fn r_matches_derivatives_of_the_coulomb_kernel() {
        // R^0_tuv is the t,u,v-th derivative of F_0(alpha R^2) with respect to
        // the components of R, so central differences of R^0_000 must reproduce
        // the low orders.
        let alpha = 0.7;
        let d = [0.37, -0.81, 1.23];
        let mut r = HermiteR::new(3);
        let f000 = |d: [f64; 3]| {
            let mut scratch = HermiteR::new(0);
            scratch.compute(0, alpha, d);
            scratch.get(0, 0, 0)
        };
        r.compute(3, alpha, d);
        let h = 1e-4;
        for axis in 0..3 {
            let mut plus = d;
            let mut minus = d;
            plus[axis] += h;
            minus[axis] -= h;
            let first = (f000(plus) - f000(minus)) / (2.0 * h);
            let second = (f000(plus) - 2.0 * f000(d) + f000(minus)) / (h * h);
            let mut t = [0, 0, 0];
            t[axis] = 1;
            assert_relative_eq!(r.get(t[0], t[1], t[2]), first, max_relative = 1e-6);
            t[axis] = 2;
            assert_relative_eq!(r.get(t[0], t[1], t[2]), second, max_relative = 1e-5);
        }
    }

    #[test]
    fn hermite_indices_are_complete_unique_and_nested() {
        for order in 0..=6 {
            let indices = hermite_indices(order);
            assert_eq!(indices.len(), hermite_count(order));
            let mut seen = std::collections::HashSet::new();
            for &[t, u, v] in &indices {
                assert!(t + u + v <= order);
                assert!(seen.insert((t, u, v)), "({t}, {u}, {v}) listed twice");
            }
            // The list for a lower order is a prefix of this one.
            if order > 0 {
                assert_eq!(indices[..hermite_count(order - 1)], hermite_indices(order - 1)[..]);
            }
        }
    }

    #[test]
    fn offsets_add_like_the_indices_they_stand_for() {
        let mut r = HermiteR::new(5);
        r.compute(5, 0.9, [0.3, -0.7, 1.1]);
        let indices = hermite_indices(5);
        for (i, &[t, u, v]) in indices.iter().enumerate().take(hermite_count(2)) {
            for (j, &[a, b, c]) in indices.iter().enumerate().take(hermite_count(3)) {
                let direct = r.get(t + a, u + b, v + c);
                let packed = r.r0()[r.offsets()[i] + r.offsets()[j]];
                assert_eq!(direct, packed);
            }
        }
    }

    /// The precomputed steps are the loops they replace: same entries, same
    /// arithmetic, same bits.
    #[test]
    fn the_unrolled_recursion_is_the_loop_it_replaces() {
        for order in 0..=9 {
            let mut unrolled = HermiteR::new(9);
            let mut direct = HermiteR::new(9);
            let cases = [
                (0.7, [0.37, -0.81, 1.23]),
                (13.0, [0.0, 0.2, -0.1]),
                (0.05, [4.0, 1.0, -3.0]),
            ];
            for (alpha, d) in cases {
                unrolled.compute(order, alpha, d);
                direct.compute_directly(order, alpha, d);
                for [t, u, v] in hermite_indices(order) {
                    assert_eq!(unrolled.get(t, u, v).to_bits(), direct.get(t, u, v).to_bits());
                }
            }
        }
    }

    #[test]
    fn r_is_symmetric_under_axis_exchange() {
        let alpha = 1.3;
        let mut xyz = HermiteR::new(4);
        let mut zyx = HermiteR::new(4);
        xyz.compute(4, alpha, [0.4, -0.9, 1.1]);
        zyx.compute(4, alpha, [1.1, -0.9, 0.4]);
        for t in 0..=2 {
            for v in 0..=2 {
                assert_relative_eq!(xyz.get(t, 1, v), zyx.get(v, 1, t), epsilon = 1e-14);
            }
        }
    }
}
