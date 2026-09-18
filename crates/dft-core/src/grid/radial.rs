//! Radial quadrature for atom-centred integration.
//!
//! `int_0^inf f(r) r^2 dr` is mapped onto `[-1, 1]` with Becke's transformation
//! `r = R (1 + x) / (1 - x)` and integrated with Gauss-Chebyshev quadrature of
//! the second kind, whose nodes and weights are closed-form:
//!
//! ```text
//! int_-1^1 g(x) sqrt(1 - x^2) dx ~= sum_i pi/(n+1) sin^2(theta_i) g(cos theta_i),
//! theta_i = i pi / (n + 1)
//! ```
//!
//! Choosing this over a tabulated scheme (Treutler-Ahlrichs, say) keeps the
//! grid free of per-element fitted parameters: the only element-dependent input
//! is the radius `R` that puts half the points inside the valence region.

/// Radii in Bohr with the matching quadrature weights, which already include the
/// `r^2` volume element.
#[derive(Debug, Clone, PartialEq)]
pub struct RadialGrid {
    pub radii: Vec<f64>,
    pub weights: Vec<f64>,
}

impl RadialGrid {
    pub fn len(&self) -> usize {
        self.radii.len()
    }

    pub fn is_empty(&self) -> bool {
        self.radii.is_empty()
    }
}

/// Builds an `n`-point radial grid whose midpoint sits at `r_mid` Bohr.
pub fn becke_chebyshev(n: usize, r_mid: f64) -> RadialGrid {
    assert!(n > 0, "a radial grid needs at least one point");
    assert!(r_mid > 0.0, "the midpoint radius must be positive");
    let mut radii = Vec::with_capacity(n);
    let mut weights = Vec::with_capacity(n);
    let step = std::f64::consts::PI / (n + 1) as f64;
    for i in 1..=n {
        let theta = i as f64 * step;
        let x = theta.cos();
        let sin = theta.sin();
        let r = r_mid * (1.0 + x) / (1.0 - x);
        // dr/dx = 2 R / (1 - x)^2, and dividing the Chebyshev weight by
        // sqrt(1 - x^2) = sin(theta) removes the built-in weight function.
        let jacobian = 2.0 * r_mid / ((1.0 - x) * (1.0 - x));
        radii.push(r);
        weights.push(step * sin * jacobian * r * r);
    }
    RadialGrid { radii, weights }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    fn integrate(grid: &RadialGrid, f: impl Fn(f64) -> f64) -> f64 {
        grid.radii.iter().zip(&grid.weights).map(|(&r, &w)| w * f(r)).sum()
    }

    #[test]
    fn integrates_exponentials_and_gaussians() {
        let grid = becke_chebyshev(80, 1.0);
        // int_0^inf r^2 e^(-2r) dr = 2!/2^3
        assert_relative_eq!(integrate(&grid, |r| (-2.0 * r).exp()), 0.25, max_relative = 1e-9);
        // int_0^inf r^2 e^(-r^2) dr = sqrt(pi)/4
        assert_relative_eq!(
            integrate(&grid, |r| (-r * r).exp()),
            std::f64::consts::PI.sqrt() / 4.0,
            max_relative = 1e-9
        );
        // int_0^inf r^4 e^(-r) dr = 4!
        assert_relative_eq!(integrate(&grid, |r| r * r * (-r).exp()), 24.0, max_relative = 1e-8);
    }

    #[test]
    fn normalises_a_hydrogenic_density() {
        // A 1s density integrates to one electron for any nuclear charge, which
        // also checks that the midpoint radius only affects convergence.
        for z in [1.0, 6.0, 18.0] {
            let grid = becke_chebyshev(90, 1.0 / z);
            let density = |r: f64| z * z * z / std::f64::consts::PI * (-2.0 * z * r).exp();
            let integral = 4.0 * std::f64::consts::PI * integrate(&grid, density);
            assert_relative_eq!(integral, 1.0, max_relative = 1e-8);
        }
    }

    #[test]
    fn converges_as_points_are_added() {
        let exact = 0.25;
        let mut previous = f64::INFINITY;
        for n in [10, 20, 40, 80] {
            let error = (integrate(&becke_chebyshev(n, 1.0), |r| (-2.0 * r).exp()) - exact).abs();
            assert!(error < previous, "error grew at n = {n}");
            previous = error;
        }
    }

    #[test]
    fn weights_are_positive_and_radii_increase_inward_to_outward() {
        let grid = becke_chebyshev(30, 0.8);
        assert!(grid.weights.iter().all(|&w| w > 0.0));
        // Nodes come out in descending radius; the order is irrelevant to the
        // sum but this pins the layout the grid assembly relies on.
        assert!(grid.radii[0] > grid.radii[grid.len() - 1]);
        assert!(grid.radii[grid.len() - 1] > 0.0);
    }
}
