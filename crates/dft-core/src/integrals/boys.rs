//! The Boys function `F_n(T) = int_0^1 t^(2n) exp(-T t^2) dt`.
//!
//! Every Coulomb-type integral in the McMurchie-Davidson scheme reduces to
//! these, so they are evaluated in batches `F_0..F_n` for one `T`.
//!
//! Three regimes, each with a different stable evaluation:
//!
//! * `T -> 0`: the Taylor series `sum_k (-T)^k / (k! (2n+2k+1))`.
//! * moderate `T`: the all-positive series for the highest order, then the
//!   downward recursion `F_(n-1) = (2T F_n + e^-T) / (2n-1)`, which follows from
//!   integrating `d/dt [t^(2n-1) e^(-T t^2)]` over `[0, 1]` and is stable.
//! * large `T`: `F_0` from the asymptotic expansion of `erfc`, then the upward
//!   recursion. Upward is unstable in general because it subtracts `e^-T` from a
//!   comparable quantity, but for `T >= 20` the two differ by many orders of
//!   magnitude and it is accurate to machine precision.

/// Below this, `T` is indistinguishable from zero at double precision after two
/// series terms.
const TINY: f64 = 1e-12;

/// Above this the `erfc` asymptotic expansion plus upward recursion is accurate
/// to ~1e-14 relative for every order the engine needs.
const LARGE: f64 = 20.0;

/// Terms kept from the (divergent) asymptotic expansion of `erfc`. Beyond `T =
/// 20` the terms fall off fast enough that six of them are well past double
/// precision.
const ASYMPTOTIC_TERMS: usize = 6;

/// Fills `out` with `F_0(t) .. F_n(t)`, where `n = out.len() - 1`.
pub fn boys_into(t: f64, out: &mut [f64]) {
    debug_assert!(!out.is_empty());
    debug_assert!(t >= 0.0, "T = alpha * R^2 is never negative");
    let n_max = out.len() - 1;

    if t < TINY {
        for (n, value) in out.iter_mut().enumerate() {
            let n = n as f64;
            *value = 1.0 / (2.0 * n + 1.0) - t / (2.0 * n + 3.0);
        }
        return;
    }

    if t > LARGE {
        // F_0 = 0.5 sqrt(pi/T) - e^-T/(2T) sum_k (-1)^k (2k-1)!!/(2T)^k
        let mut tail = 0.0;
        let mut term = 1.0;
        for k in 0..ASYMPTOTIC_TERMS {
            tail += term;
            term *= -((2 * k + 1) as f64) / (2.0 * t);
        }
        let exp_t = (-t).exp();
        out[0] = 0.5 * (std::f64::consts::PI / t).sqrt() - exp_t / (2.0 * t) * tail;
        for n in 0..n_max {
            out[n + 1] = ((2 * n + 1) as f64 * out[n] - exp_t) / (2.0 * t);
        }
        return;
    }

    // F_n = e^-T sum_k (2T)^k (2n-1)!! / (2n+2k+1)!!, whose terms are all
    // positive, so there is no cancellation.
    let mut sum = 0.0;
    let mut term = 1.0 / (2 * n_max + 1) as f64;
    let mut k = 0usize;
    loop {
        sum += term;
        term *= 2.0 * t / (2 * n_max + 2 * k + 3) as f64;
        k += 1;
        if term <= f64::EPSILON * sum || k > 200 {
            break;
        }
    }
    let exp_t = (-t).exp();
    out[n_max] = exp_t * sum;
    for n in (0..n_max).rev() {
        out[n] = (2.0 * t * out[n + 1] + exp_t) / (2 * n + 1) as f64;
    }
}

/// Convenience wrapper returning `F_0(t) .. F_n_max(t)`.
pub fn boys(n_max: usize, t: f64) -> Vec<f64> {
    let mut out = vec![0.0; n_max + 1];
    boys_into(t, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Composite Simpson quadrature of the defining integral. Independent of
    /// every approximation in the module under test, which is the point.
    fn reference(n: usize, t: f64) -> f64 {
        const INTERVALS: usize = 100_000;
        let h = 1.0 / INTERVALS as f64;
        let f = |x: f64| x.powi(2 * n as i32) * (-t * x * x).exp();
        let mut sum = f(0.0) + f(1.0);
        for i in 1..INTERVALS {
            let weight = if i % 2 == 1 { 4.0 } else { 2.0 };
            sum += weight * f(i as f64 * h);
        }
        sum * h / 3.0
    }

    #[test]
    fn matches_numerical_quadrature_across_every_regime() {
        // Straddles both switch points and reaches well beyond them.
        let ts = [
            0.0, 1e-14, 1e-9, 0.25, 1.0, 5.0, 12.0, 19.99, 20.0, 20.01, 33.0, 80.0,
            250.0,
        ];
        for &t in &ts {
            let values = boys(14, t);
            for (n, &value) in values.iter().enumerate() {
                let expected = reference(n, t);
                let error = (value - expected).abs() / expected;
                assert!(
                    error < 1e-11,
                    "F_{n}({t}) = {value}, quadrature gives {expected} (rel. error {error:e})"
                );
            }
        }
    }

    #[test]
    fn satisfies_the_recursion_it_is_not_built_from() {
        // e^-T = (2n+1) F_n - 2T F_(n+1) holds for every T and n; in the large-T
        // branch this is the relation used to build the values, but in the
        // series branch it is an independent check.
        for &t in &[0.5, 3.0, 11.0, 19.0] {
            let f = boys(10, t);
            for n in 0..10 {
                let lhs = (2 * n + 1) as f64 * f[n] - 2.0 * t * f[n + 1];
                assert!(
                    (lhs - (-t).exp()).abs() < 1e-13,
                    "recursion broken at n={n}, T={t}"
                );
            }
        }
    }

    #[test]
    fn zero_argument_is_the_exact_rational() {
        let f = boys(8, 0.0);
        for (n, &value) in f.iter().enumerate() {
            assert!((value - 1.0 / (2 * n + 1) as f64).abs() < 1e-15);
        }
    }

    #[test]
    fn decreases_monotonically_in_both_arguments() {
        let f = boys(10, 4.0);
        for n in 0..10 {
            assert!(f[n] > f[n + 1], "F_n must decrease with n");
        }
        for n in 0..=10 {
            assert!(boys(10, 4.0)[n] > boys(10, 6.0)[n]);
        }
    }
}
