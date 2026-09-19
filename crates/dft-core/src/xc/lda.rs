//! The local density approximation: Slater exchange plus VWN5 correlation.
//!
//! Both are written for a general spin polarisation; the spin-restricted SCF of
//! phase 2 only ever calls them with `rho_alpha == rho_beta`, and the unrestricted
//! code of phase 4 reuses them unchanged.
//!
//! The VWN fitting constants below are the only numbers in the crate that cannot
//! be derived from anything else - they *are* the definition of the functional
//! (S. H. Vosko, L. Wilk and M. Nusair, Can. J. Phys. 58, 1200 (1980), the fifth
//! parametrisation). `tests/reference_xc.rs` checks every one of them against
//! libxc's `LDA_C_VWN` point by point, so a mistyped digit fails loudly.

/// Below this total density everything is returned as zero: the energy
/// contribution goes as `rho^(4/3)` and is beyond double precision here.
const DENSITY_CUTOFF: f64 = 1e-30;

/// One VWN fit: `epsilon(x) = A [ ... ]` with `x = sqrt(r_s)`.
struct VwnFit {
    a: f64,
    b: f64,
    c: f64,
    x0: f64,
}

/// Paramagnetic limit, `zeta = 0`.
const PARAMAGNETIC: VwnFit =
    VwnFit { a: 0.0310907, b: 3.72744, c: 12.9352, x0: -0.10498 };

/// Ferromagnetic limit, `zeta = 1`.
const FERROMAGNETIC: VwnFit =
    VwnFit { a: 0.01554535, b: 7.06042, c: 18.0578, x0: -0.325 };

/// Spin stiffness, which interpolates between the two limits. Its amplitude is
/// the exact random-phase value `-1/(6 pi^2)`.
const SPIN_STIFFNESS: VwnFit = VwnFit {
    a: -1.0 / (6.0 * std::f64::consts::PI * std::f64::consts::PI),
    b: 1.13107,
    c: 13.0045,
    x0: -0.0047584,
};

impl VwnFit {
    /// The fit and its derivative with respect to `r_s`.
    fn eval(&self, rs: f64) -> (f64, f64) {
        let x = rs.sqrt();
        let q = (4.0 * self.c - self.b * self.b).sqrt();
        let big_x = x * x + self.b * x + self.c;
        let big_x0 = self.x0 * self.x0 + self.b * self.x0 + self.c;
        let atan = (q / (2.0 * x + self.b)).atan();
        let ratio = self.b * self.x0 / big_x0;

        let value = self.a
            * ((x * x / big_x).ln() + 2.0 * self.b / q * atan
                - ratio
                    * (((x - self.x0) * (x - self.x0) / big_x).ln()
                        + 2.0 * (self.b + 2.0 * self.x0) / q * atan));

        // d/dx, using d/dx atan(Q/(2x+b)) = -Q/(2X) and (2x+b)^2 + Q^2 = 4X.
        let dx_big = 2.0 * x + self.b;
        let d_value_dx = self.a
            * (2.0 / x - dx_big / big_x - self.b / big_x
                - ratio
                    * (2.0 / (x - self.x0)
                        - dx_big / big_x
                        - (self.b + 2.0 * self.x0) / big_x));
        // x = sqrt(rs), so d/drs = (d/dx) / (2x).
        (value, d_value_dx / (2.0 * x))
    }
}

/// Exchange-correlation energy per particle and the potential of each channel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct XcPoint {
    /// `epsilon_xc`, the energy *per electron*; the energy density is `rho * exc`.
    pub exc: f64,
    /// `d(rho * epsilon_xc) / d rho_alpha`.
    pub v_alpha: f64,
    /// `d(rho * epsilon_xc) / d rho_beta`.
    pub v_beta: f64,
}

/// The functional's derived constants, computed once.
///
/// They are cube roots of constants, and on `wasm32` a cube root is a library
/// routine that the compiler does not fold, so writing them inline cost a call
/// per grid point each.
struct Constants {
    /// `C_x` such that the exchange energy density is
    /// `-C_x (rho_a^(4/3) + rho_b^(4/3))`.
    exchange: f64,
    /// `(3 / 4 pi)^(1/3)`, so that `r_s` is this over `rho^(1/3)`.
    wigner_seitz: f64,
    /// `2^(4/3) - 2`, the normalisation of the spin interpolation.
    spin_denominator: f64,
    /// `2^(1/3)`: with both spins equal, `rho^(1/3) = 2^(1/3) rho_alpha^(1/3)`.
    cbrt_two: f64,
}

fn constants() -> &'static Constants {
    static CONSTANTS: std::sync::OnceLock<Constants> = std::sync::OnceLock::new();
    CONSTANTS.get_or_init(|| {
        let wigner_seitz = (3.0 / (4.0 * std::f64::consts::PI)).cbrt();
        Constants {
            exchange: 1.5 * wigner_seitz,
            wigner_seitz,
            spin_denominator: four_thirds(2.0) - 2.0,
            cbrt_two: 2.0f64.cbrt(),
        }
    })
}

/// `C_x` such that the exchange energy density is `-C_x (rho_a^(4/3) + rho_b^(4/3))`.
fn exchange_constant() -> f64 {
    constants().exchange
}

/// `x^(4/3)` as `x x^(1/3)`: one cube root rather than a general power, and a
/// little more accurate than `powf(x, 4.0 / 3.0)`, whose exponent is not quite
/// four thirds in binary.
fn four_thirds(x: f64) -> f64 {
    x * x.cbrt()
}

/// Spin interpolation function and its derivative.
fn spin_scaling(zeta: f64) -> (f64, f64) {
    let denominator = constants().spin_denominator;
    let plus = (1.0 + zeta).max(0.0);
    let minus = (1.0 - zeta).max(0.0);
    let (plus_cbrt, minus_cbrt) = (plus.cbrt(), minus.cbrt());
    let f = (plus * plus_cbrt + minus * minus_cbrt - 2.0) / denominator;
    let df = 4.0 / 3.0 * (plus_cbrt - minus_cbrt) / denominator;
    (f, df)
}

/// Slater exchange plus VWN5 correlation at one point.
pub fn lda(rho_alpha: f64, rho_beta: f64) -> XcPoint {
    let rho = rho_alpha + rho_beta;
    if rho < DENSITY_CUTOFF {
        return XcPoint { exc: 0.0, v_alpha: 0.0, v_beta: 0.0 };
    }
    let alpha = rho_alpha.max(0.0);
    let beta = rho_beta.max(0.0);

    // --- Slater exchange -------------------------------------------------
    // A restricted calculation always has alpha == beta, and then one cube
    // root serves both channels.
    let cx = exchange_constant();
    let alpha_cbrt = alpha.cbrt();
    let beta_cbrt = if beta == alpha { alpha_cbrt } else { beta.cbrt() };
    let energy_density_x = -cx * (alpha * alpha_cbrt + beta * beta_cbrt);
    let vx_alpha = -4.0 / 3.0 * cx * alpha_cbrt;
    let vx_beta = -4.0 / 3.0 * cx * beta_cbrt;

    // --- VWN5 correlation -------------------------------------------------
    let rho_cbrt = if beta == alpha { constants().cbrt_two * alpha_cbrt } else { rho.cbrt() };
    let rs = constants().wigner_seitz / rho_cbrt;
    let zeta = ((alpha - beta) / rho).clamp(-1.0, 1.0);

    let (eps_p, deps_p) = PARAMAGNETIC.eval(rs);

    // The unpolarised case is by far the most common, and there the spin
    // interpolation and its derivative are exactly zero, so neither it nor the
    // other two fits need evaluating.
    let (eps_c, deps_c_drs, deps_c_dzeta) = if zeta == 0.0 {
        (eps_p, deps_p, 0.0)
    } else {
        let (f, df) = spin_scaling(zeta);
        let (eps_f, deps_f) = FERROMAGNETIC.eval(rs);
        let (alpha_c, dalpha_c) = SPIN_STIFFNESS.eval(rs);
        // f''(0), the curvature that makes alpha_c the spin stiffness.
        let f2 = 4.0 / (9.0 * (2.0f64.cbrt() - 1.0));
        let z4 = zeta.powi(4);
        // The usual form is eps_p + alpha_c f/f''(0) (1 + beta zeta^4) with
        // beta = f''(0) (eps_f - eps_p)/alpha_c - 1; substituting beta removes
        // the division by alpha_c.
        let stiff = alpha_c / f2;
        let delta_eps = eps_f - eps_p;
        let bracket = stiff * (1.0 - z4) + delta_eps * z4;
        let eps_c = eps_p + f * bracket;

        let d_bracket_drs = dalpha_c / f2 * (1.0 - z4) + (deps_f - deps_p) * z4;
        let drs = deps_p + f * d_bracket_drs;
        let dzeta = df * bracket + f * 4.0 * zeta.powi(3) * (delta_eps - stiff);
        (eps_c, drs, dzeta)
    };

    // v_sigma = eps_c + rho d eps_c/d rho_sigma, with
    // d rs/d rho = -rs/(3 rho) and d zeta/d rho_alpha = (1 - zeta)/rho.
    let common = eps_c - rs / 3.0 * deps_c_drs;
    let vc_alpha = common + (1.0 - zeta) * deps_c_dzeta;
    let vc_beta = common - (1.0 + zeta) * deps_c_dzeta;

    XcPoint {
        exc: energy_density_x / rho + eps_c,
        v_alpha: vx_alpha + vc_alpha,
        v_beta: vx_beta + vc_beta,
    }
}

/// Spin-restricted shortcut: both channels hold half the density.
pub fn lda_restricted(rho: f64) -> (f64, f64) {
    let point = lda(0.5 * rho, 0.5 * rho);
    (point.exc, point.v_alpha)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn unpolarised_exchange_matches_the_closed_form() {
        // Correlation is what needs a fit; exchange is exact, so it can be
        // checked against -3/4 (3/pi)^(1/3) rho^(1/3) on its own by subtracting
        // the correlation the polarised expression shares with zeta = 0.
        for rho in [1e-4, 0.01, 0.5, 2.0, 50.0] {
            let total = lda_restricted(rho).0;
            // eps_c at zeta = 0 is the paramagnetic fit.
            let rs = (3.0 / (4.0 * std::f64::consts::PI * rho)).cbrt();
            let eps_c = PARAMAGNETIC.eval(rs).0;
            let eps_x = total - eps_c;
            let expected = -0.75 * (3.0 / std::f64::consts::PI).cbrt() * rho.cbrt();
            assert_relative_eq!(eps_x, expected, max_relative = 1e-13);
        }
    }

    #[test]
    fn potential_is_the_derivative_of_the_energy_density() {
        // v_sigma = d(rho eps_xc)/d rho_sigma by construction; central
        // differences check the analytic derivatives of both the VWN fits and
        // the spin interpolation.
        // Both channels must stay positive: a central difference through
        // rho_sigma = 0 would step into negative density, where the functional is
        // undefined. The fully polarised limit is covered by the libxc
        // comparison in tests/reference_xc.rs instead.
        let cases = [(0.3, 0.3), (0.5, 0.1), (1e-3, 4e-4), (12.0, 7.0), (0.9, 0.05)];
        for (a, b) in cases {
            let point = lda(a, b);
            let energy = |x: f64, y: f64| {
                let p = lda(x, y);
                (x + y) * p.exc
            };
            // Each step scales with its own channel: the exchange term goes as
            // rho_sigma^(4/3), so a step set by the larger channel would be far
            // too coarse for the smaller one.
            let ha = 1e-6 * a;
            let hb = 1e-6 * b;
            let fd_alpha = (energy(a + ha, b) - energy(a - ha, b)) / (2.0 * ha);
            let fd_beta = (energy(a, b + hb) - energy(a, b - hb)) / (2.0 * hb);
            assert_relative_eq!(point.v_alpha, fd_alpha, max_relative = 1e-6);
            assert_relative_eq!(point.v_beta, fd_beta, max_relative = 1e-6);
        }
    }

    #[test]
    fn fully_polarised_correlation_is_the_ferromagnetic_fit() {
        // At zeta = 1 the interpolation must collapse onto eps_F exactly; this is
        // the property the substituted form of beta(rs) is meant to preserve.
        for rho in [1e-3, 0.1, 3.0] {
            let point = lda(rho, 0.0);
            let rs = (3.0 / (4.0 * std::f64::consts::PI * rho)).cbrt();
            let eps_x = -exchange_constant() * four_thirds(rho) / rho;
            assert_relative_eq!(
                point.exc - eps_x,
                FERROMAGNETIC.eval(rs).0,
                max_relative = 1e-12
            );
        }
    }

    #[test]
    fn vanishing_channel_potential_is_the_one_sided_limit() {
        // With one channel empty, its potential is a one-sided derivative. The
        // analytic expression must agree with the limit taken from inside the
        // allowed region; libxc regularises this boundary differently, so this
        // is the only check on it.
        for rho in [1e-8, 1e-3, 1.0] {
            let at_zero = lda(rho, 0.0);
            let mut previous = f64::INFINITY;
            let mut closest = 0.0;
            // The gap closes only as h^(1/3), because the exchange potential of
            // the empty channel is -4/3 C_x rho_beta^(1/3); the step therefore
            // has to get very small before the agreement looks tight. What
            // matters is that it keeps shrinking towards the analytic value.
            for exponent in 4..=15 {
                let h = rho * 10f64.powi(-exponent);
                let approached = lda(rho, h).v_beta;
                let gap = (approached - at_zero.v_beta).abs();
                assert!(gap < previous, "not converging at rho = {rho}");
                previous = gap;
                closest = approached;
            }
            assert_relative_eq!(at_zero.v_beta, closest, max_relative = 1e-4);
        }
    }

    #[test]
    fn spin_symmetry_holds() {
        let a = lda(0.7, 0.2);
        let b = lda(0.2, 0.7);
        assert_relative_eq!(a.exc, b.exc, epsilon = 1e-15);
        assert_relative_eq!(a.v_alpha, b.v_beta, epsilon = 1e-15);
        assert_relative_eq!(a.v_beta, b.v_alpha, epsilon = 1e-15);
    }

    #[test]
    fn vanishing_density_is_handled() {
        let point = lda(0.0, 0.0);
        assert_eq!(point.exc, 0.0);
        assert_eq!(point.v_alpha, 0.0);
        assert_eq!(point.v_beta, 0.0);
        // And nothing blows up just above the cutoff.
        let tiny = lda(1e-25, 1e-25);
        assert!(tiny.exc.is_finite() && tiny.v_alpha.is_finite());
        assert!(tiny.exc < 0.0, "exchange-correlation energy is negative");
    }

    #[test]
    fn energy_is_negative_and_grows_with_density() {
        let mut previous = 0.0;
        for rho in [1e-3, 0.01, 0.1, 1.0, 10.0] {
            let (exc, v) = lda_restricted(rho);
            assert!(exc < 0.0 && v < 0.0);
            assert!(exc < previous, "eps_xc must fall as density rises");
            previous = exc;
        }
    }
}
