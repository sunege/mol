//! The LDA functional against libxc.
//!
//! `LDA_X` + `LDA_C_VWN` is exactly the Slater + VWN5 pair the engine
//! implements, so these values pin down every fitting constant in `xc::lda`.

mod common;

use common::{load, XcReference};
use dft_core::xc::lda;

#[test]
fn unpolarized_values_match_libxc() {
    let reference: XcReference = load("xc_lda.json");
    assert!(!reference.unpolarized.is_empty());
    for point in &reference.unpolarized {
        let (exc, v) = lda::lda_restricted(point.rho);
        // Relative comparison: the densities span twelve orders of magnitude.
        let relative = |a: f64, b: f64| (a - b).abs() / b.abs().max(1e-300);
        assert!(
            relative(exc, point.exc) < 1e-11,
            "rho = {}: eps_xc = {exc}, libxc {}",
            point.rho,
            point.exc
        );
        assert!(
            relative(v, point.vrho) < 1e-11,
            "rho = {}: v_xc = {v}, libxc {}",
            point.rho,
            point.vrho
        );
    }
}

/// The spin-polarised path is unused until the unrestricted SCF of phase 4, but
/// the interpolation between the paramagnetic and ferromagnetic fits is the part
/// of VWN5 most easily got wrong, so it is pinned down here.
///
/// Two deliberate allowances, both settled by evaluating the fit and its
/// derivatives in 60-digit arithmetic, which agrees with this code to the last
/// stored digit in every case:
///
/// * The absolute floor is not slack for this implementation. At a fully
///   polarised density of 1e-8 the VWN expression loses most of its significant
///   digits to cancellation, and it is *libxc* that drifts there, by 5e-11 in
///   `eps_c` and 1.2e-10 in the potential. Such a density contributes on the
///   order of 1e-18 Hartree to any energy.
/// * The potential of a channel whose density is exactly zero is skipped. There
///   `v_sigma` is a one-sided derivative; this code returns its analytic limit
///   and libxc returns something 0.3% away, so it evidently regularises the
///   boundary. `lda::tests::vanishing_channel_potential_is_the_one_sided_limit`
///   covers that case instead.
#[test]
fn polarized_values_match_libxc() {
    let reference: XcReference = load("xc_lda.json");
    assert!(!reference.polarized.is_empty());
    for point in &reference.polarized {
        let result = lda::lda(point.rho_a, point.rho_b);
        let agrees = |mine: f64, theirs: f64| {
            (mine - theirs).abs() <= 1e-11 * theirs.abs() + 1e-9
        };
        let mut checks = vec![("eps_xc", result.exc, point.exc)];
        if point.rho_a > 0.0 {
            checks.push(("v_alpha", result.v_alpha, point.vrho_a));
        }
        if point.rho_b > 0.0 {
            checks.push(("v_beta", result.v_beta, point.vrho_b));
        }
        for (name, mine, theirs) in checks {
            assert!(
                agrees(mine, theirs),
                "rho = ({}, {}): {name} = {mine}, libxc {theirs}",
                point.rho_a,
                point.rho_b
            );
        }
    }
}
