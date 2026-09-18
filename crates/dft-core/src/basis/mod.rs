//! Contracted Cartesian Gaussian basis sets.
//!
//! A basis function is
//!
//! ```text
//! phi(r) = s * sum_k d_k * x^lx y^ly z^lz exp(-a_k |r - R|^2)
//! ```
//!
//! with the normalisation split in two:
//!
//! * `d_k` holds the published contraction coefficient times the normalisation
//!   of a primitive with powers `(l, 0, 0)`, scaled so the contracted function
//!   has unit self-overlap. It is shared by every component of the shell.
//! * `s` is the per-component factor `sqrt((2l-1)!! / (2lx-1)!!(2ly-1)!!(2lz-1)!!)`
//!   that keeps each Cartesian component normalised. It is 1 for s and p shells
//!   and first bites for d shells, where `<xy|xy>` would otherwise come out a
//!   third of `<xx|xx>`.
//!
//! Splitting it this way lets the integral code work with one coefficient list
//! per shell and apply `s` only when a shell block is written into a matrix.

mod sto3g_data;

use crate::element::MAX_Z;
use crate::molecule::Molecule;

/// A shell exactly as a basis-set table publishes it: exponents with
/// contraction coefficients over normalised primitives.
#[derive(Debug, Clone, Copy)]
pub struct ShellDef {
    pub l: u8,
    pub exponents: &'static [f64],
    pub coefficients: &'static [f64],
}

/// Reasons a basis set cannot be built for a molecule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BasisError {
    /// No STO-3G contraction is tabulated for this element.
    UnsupportedElement { z: u8 },
}

/// Number of Cartesian components in a shell of angular momentum `l`.
pub const fn n_components(l: u8) -> usize {
    let l = l as usize;
    (l + 1) * (l + 2) / 2
}

/// Cartesian powers of a shell in the crate-wide order: `x, y, z` for p and
/// `xx, xy, xz, yy, yz, zz` for d.
///
/// This is libcint's (and therefore PySCF's) ordering, so reference matrices
/// generated with PySCF need no permutation before being compared.
pub fn cartesian_powers(l: u8) -> Vec<[u8; 3]> {
    let li = l as i32;
    let mut out = Vec::with_capacity(n_components(l));
    for lx in (0..=li).rev() {
        for ly in (0..=(li - lx)).rev() {
            out.push([lx as u8, ly as u8, (li - lx - ly) as u8]);
        }
    }
    out
}

/// `(2k - 1)!!`, with `(-1)!! = 1`.
pub fn double_factorial_odd(k: u8) -> f64 {
    let mut product = 1.0;
    let mut i = 2 * k as i32 - 1;
    while i > 1 {
        product *= i as f64;
        i -= 2;
    }
    product
}

/// A contracted Cartesian Gaussian shell centred on one nucleus.
#[derive(Debug, Clone, PartialEq)]
pub struct Shell {
    /// Index of the nucleus the shell sits on. The gradient code needs this to
    /// know which atom a derivative belongs to.
    pub center: usize,
    /// Centre in Bohr, copied so the integral code never touches the molecule.
    pub origin: [f64; 3],
    pub l: u8,
    pub exponents: Vec<f64>,
    /// Normalised contraction coefficients, shared by all components.
    pub coefficients: Vec<f64>,
    /// Cartesian powers of each component, in [`cartesian_powers`] order. Cached
    /// because `evaluate_into` runs once per shell per grid point, which is the
    /// hottest loop in the SCF.
    pub powers: Vec<[u8; 3]>,
    /// Per-component factors, indexed like [`cartesian_powers`].
    pub scales: Vec<f64>,
}

impl Shell {
    /// Builds a shell from published coefficients, applying both normalisations.
    pub fn new(
        center: usize,
        origin: [f64; 3],
        l: u8,
        exponents: &[f64],
        coefficients: &[f64],
    ) -> Self {
        assert_eq!(exponents.len(), coefficients.len(), "malformed contraction");

        // Normalisation of a primitive with powers (l, 0, 0).
        let primitive_norm = |a: f64| {
            (2.0 * a / std::f64::consts::PI).powf(0.75)
                * (4.0 * a).powf(l as f64 / 2.0)
                / double_factorial_odd(l).sqrt()
        };
        let mut d: Vec<f64> = exponents
            .iter()
            .zip(coefficients)
            .map(|(&a, &c)| c * primitive_norm(a))
            .collect();

        // Self-overlap of the contracted (l, 0, 0) function. Each primitive is
        // already normalised, so this is 1 plus the cross terms; STO-3G
        // contractions are close to but not exactly normalised.
        let mut norm = 0.0;
        for (i, &ai) in exponents.iter().enumerate() {
            for (j, &aj) in exponents.iter().enumerate() {
                let p = ai + aj;
                norm += d[i]
                    * d[j]
                    * double_factorial_odd(l)
                    / (2.0 * p).powi(l as i32)
                    * (std::f64::consts::PI / p).powf(1.5);
            }
        }
        let inv = 1.0 / norm.sqrt();
        for c in &mut d {
            *c *= inv;
        }

        let scales = cartesian_powers(l)
            .into_iter()
            .map(|[lx, ly, lz]| {
                (double_factorial_odd(l)
                    / (double_factorial_odd(lx)
                        * double_factorial_odd(ly)
                        * double_factorial_odd(lz)))
                .sqrt()
            })
            .collect();

        Shell {
            center,
            origin,
            l,
            exponents: exponents.to_vec(),
            coefficients: d,
            powers: cartesian_powers(l),
            scales,
        }
    }

    /// Number of basis functions this shell contributes.
    pub fn n_components(&self) -> usize {
        n_components(self.l)
    }

    pub fn n_primitives(&self) -> usize {
        self.exponents.len()
    }

    /// Evaluates every component of the shell at `point` (Bohr), writing
    /// `n_components()` values into `out`.
    pub fn evaluate_into(&self, point: [f64; 3], out: &mut [f64]) {
        let dx = point[0] - self.origin[0];
        let dy = point[1] - self.origin[1];
        let dz = point[2] - self.origin[2];
        let r2 = dx * dx + dy * dy + dz * dz;

        let mut radial = 0.0;
        for (&a, &c) in self.exponents.iter().zip(&self.coefficients) {
            radial += c * (-a * r2).exp();
        }

        for (out_i, (&[lx, ly, lz], &scale)) in
            out.iter_mut().zip(self.powers.iter().zip(&self.scales))
        {
            *out_i = scale * radial * powi(dx, lx) * powi(dy, ly) * powi(dz, lz);
        }
    }

    /// Gradient of every component with respect to the *electron* coordinate,
    /// writing `n_components()` values into each of the three slices.
    ///
    /// The nuclear gradient wants the derivative with respect to the centre
    /// instead, which is minus this: a basis function depends on `r - R`, so
    /// moving the nucleus one way is the same as moving the electron the other.
    /// The sign flip happens where the atom index is in hand.
    pub fn evaluate_gradient_into(
        &self,
        point: [f64; 3],
        dx_out: &mut [f64],
        dy_out: &mut [f64],
        dz_out: &mut [f64],
    ) {
        let d = [
            point[0] - self.origin[0],
            point[1] - self.origin[1],
            point[2] - self.origin[2],
        ];
        let r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];

        // The contracted radial part and its derivative with respect to r^2,
        // which differ only by the -2a every primitive picks up.
        let mut radial = 0.0;
        let mut radial_slope = 0.0;
        for (&a, &c) in self.exponents.iter().zip(&self.coefficients) {
            let term = c * (-a * r2).exp();
            radial += term;
            radial_slope += -2.0 * a * term;
        }

        for (component, (&powers, &scale)) in self.powers.iter().zip(&self.scales).enumerate() {
            let monomial = [powi(d[0], powers[0]), powi(d[1], powers[1]), powi(d[2], powers[2])];
            let product = monomial[0] * monomial[1] * monomial[2];
            // d/dx [x^l y^m z^n R(r^2)] = l x^(l-1) y^m z^n R + x^l y^m z^n * x * 2R'(r^2),
            // with the factor 2 already carried by `radial_slope`.
            let lowered = |axis: usize| -> f64 {
                if powers[axis] == 0 {
                    return 0.0;
                }
                let mut term = powers[axis] as f64 * powi(d[axis], powers[axis] - 1);
                for other in 0..3 {
                    if other != axis {
                        term *= monomial[other];
                    }
                }
                term
            };
            let tail = product * radial_slope;
            dx_out[component] = scale * (lowered(0) * radial + d[0] * tail);
            dy_out[component] = scale * (lowered(1) * radial + d[1] * tail);
            dz_out[component] = scale * (lowered(2) * radial + d[2] * tail);
        }
    }
}

fn powi(x: f64, n: u8) -> f64 {
    match n {
        0 => 1.0,
        1 => x,
        2 => x * x,
        _ => x.powi(n as i32),
    }
}

/// All shells of a molecule, in the order that fixes basis-function indices:
/// atom by atom, and within an atom in the order the element's table lists them
/// (ascending angular momentum for STO-3G). PySCF orders its shells the same
/// way, so reference matrices line up index for index.
#[derive(Debug, Clone, PartialEq)]
pub struct BasisSet {
    pub shells: Vec<Shell>,
    /// First basis-function index of each shell, plus a trailing total.
    offsets: Vec<usize>,
}

impl BasisSet {
    /// Builds the fixed STO-3G basis for a molecule.
    pub fn sto3g(molecule: &Molecule) -> Result<Self, BasisError> {
        let mut shells = Vec::new();
        for (center, atom) in molecule.atoms.iter().enumerate() {
            if atom.z == 0 || atom.z > MAX_Z {
                return Err(BasisError::UnsupportedElement { z: atom.z });
            }
            for def in sto3g_data::STO3G[(atom.z - 1) as usize] {
                shells.push(Shell::new(
                    center,
                    atom.pos,
                    def.l,
                    def.exponents,
                    def.coefficients,
                ));
            }
        }
        Ok(BasisSet::from_shells(shells))
    }

    pub fn from_shells(shells: Vec<Shell>) -> Self {
        let mut offsets = Vec::with_capacity(shells.len() + 1);
        let mut total = 0;
        for shell in &shells {
            offsets.push(total);
            total += shell.n_components();
        }
        offsets.push(total);
        BasisSet { shells, offsets }
    }

    pub fn n_functions(&self) -> usize {
        self.offsets[self.shells.len()]
    }

    pub fn n_shells(&self) -> usize {
        self.shells.len()
    }

    /// First basis-function index of shell `s`.
    pub fn offset(&self, s: usize) -> usize {
        self.offsets[s]
    }

    /// Basis-function range of one atom.
    ///
    /// Shells are ordered atom by atom, so each atom owns a contiguous block;
    /// the SAD guess relies on that to drop an atomic density matrix straight
    /// onto the diagonal.
    pub fn atom_range(&self, atom: usize) -> std::ops::Range<usize> {
        let mut start = self.n_functions();
        let mut end = 0;
        for (s, shell) in self.shells.iter().enumerate() {
            if shell.center == atom {
                start = start.min(self.offsets[s]);
                end = end.max(self.offsets[s + 1]);
            }
        }
        if start > end {
            return 0..0;
        }
        start..end
    }

    /// The nucleus each basis function sits on, indexed by function.
    ///
    /// The gradient code needs it in the inner loop: a derivative with respect
    /// to an atom only touches the functions centred on that atom.
    pub fn function_centers(&self) -> Vec<usize> {
        let mut centers = Vec::with_capacity(self.n_functions());
        for shell in &self.shells {
            centers.extend(std::iter::repeat(shell.center).take(shell.n_components()));
        }
        centers
    }

    /// Highest angular momentum present, which sizes the integral scratch space.
    pub fn max_angular_momentum(&self) -> u8 {
        self.shells.iter().map(|s| s.l).max().unwrap_or(0)
    }

    /// Evaluates every basis function at `point` (Bohr) into `out`, which must
    /// have length `n_functions()`.
    pub fn evaluate_into(&self, point: [f64; 3], out: &mut [f64]) {
        debug_assert_eq!(out.len(), self.n_functions());
        for (s, shell) in self.shells.iter().enumerate() {
            let from = self.offsets[s];
            let to = self.offsets[s + 1];
            shell.evaluate_into(point, &mut out[from..to]);
        }
    }

    /// Gradients of every basis function at `point` (Bohr) with respect to the
    /// electron coordinate, one slice of `n_functions()` values per direction.
    pub fn evaluate_gradient_into(
        &self,
        point: [f64; 3],
        dx_out: &mut [f64],
        dy_out: &mut [f64],
        dz_out: &mut [f64],
    ) {
        debug_assert_eq!(dx_out.len(), self.n_functions());
        for (s, shell) in self.shells.iter().enumerate() {
            let from = self.offsets[s];
            let to = self.offsets[s + 1];
            shell.evaluate_gradient_into(
                point,
                &mut dx_out[from..to],
                &mut dy_out[from..to],
                &mut dz_out[from..to],
            );
        }
    }

    /// Evaluates every basis function at `point` (Bohr).
    pub fn evaluate(&self, point: [f64; 3]) -> Vec<f64> {
        let mut out = vec![0.0; self.n_functions()];
        self.evaluate_into(point, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::molecule::Atom;
    use approx::assert_relative_eq;

    #[test]
    fn cartesian_order_matches_libcint() {
        assert_eq!(cartesian_powers(0), vec![[0, 0, 0]]);
        assert_eq!(cartesian_powers(1), vec![[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
        assert_eq!(
            cartesian_powers(2),
            vec![[2, 0, 0], [1, 1, 0], [1, 0, 1], [0, 2, 0], [0, 1, 1], [0, 0, 2]]
        );
        for l in 0..=4u8 {
            assert_eq!(cartesian_powers(l).len(), n_components(l));
            for powers in cartesian_powers(l) {
                assert_eq!(powers.iter().map(|&p| p as u32).sum::<u32>(), l as u32);
            }
        }
    }

    #[test]
    fn double_factorial_matches_longhand() {
        assert_eq!(double_factorial_odd(0), 1.0); // (-1)!!
        assert_eq!(double_factorial_odd(1), 1.0);
        assert_eq!(double_factorial_odd(2), 3.0);
        assert_eq!(double_factorial_odd(3), 15.0); // 5 * 3 * 1
        assert_eq!(double_factorial_odd(4), 105.0); // 7 * 5 * 3 * 1
    }

    /// Self-overlap of every component of a shell, by midpoint quadrature over a
    /// cube. Crude, but it checks the normalisation convention without reusing
    /// any of the integral code.
    fn component_norms(shell: &Shell, half_width: f64, n: usize) -> Vec<f64> {
        let count = shell.n_components();
        let mut norms = vec![0.0; count];
        let mut values = vec![0.0; count];
        let h = 2.0 * half_width / n as f64;
        for i in 0..n {
            let x = -half_width + (i as f64 + 0.5) * h;
            for j in 0..n {
                let y = -half_width + (j as f64 + 0.5) * h;
                for k in 0..n {
                    let z = -half_width + (k as f64 + 0.5) * h;
                    shell.evaluate_into([x, y, z], &mut values);
                    for (norm, value) in norms.iter_mut().zip(&values) {
                        *norm += value * value;
                    }
                }
            }
        }
        let volume = h * h * h;
        norms.iter().map(|n| n * volume).collect()
    }

    #[test]
    fn every_component_is_normalised() {
        // Wide contractions, so a modest cube captures essentially all of each
        // function. d shells are the case that matters: without the per-component
        // factor, <xy|xy> would come out at a third of <xx|xx>.
        for l in 0..=2u8 {
            let shell = Shell::new(0, [0.0; 3], l, &[1.2, 0.4], &[0.5, 0.7]);
            for (component, norm) in component_norms(&shell, 6.0, 110).into_iter().enumerate() {
                assert_relative_eq!(norm, 1.0, epsilon = 2e-4);
                assert!(norm > 0.0, "component {component} of l={l} vanished");
            }
        }
    }

    /// The analytic basis-function gradient against central differences of the
    /// values themselves, on a d shell where the monomial factor actually has
    /// something to differentiate.
    #[test]
    fn basis_gradients_match_central_differences() {
        for l in 0..=2u8 {
            let shell = Shell::new(0, [0.2, -0.4, 0.7], l, &[1.7, 0.45], &[0.4, 0.8]);
            let n = shell.n_components();
            let point = [0.9, 0.3, -1.1];
            let (mut dx, mut dy, mut dz) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
            shell.evaluate_gradient_into(point, &mut dx, &mut dy, &mut dz);

            let h = 1e-5;
            for axis in 0..3 {
                let mut plus = point;
                let mut minus = point;
                plus[axis] += h;
                minus[axis] -= h;
                let (mut a, mut b) = (vec![0.0; n], vec![0.0; n]);
                shell.evaluate_into(plus, &mut a);
                shell.evaluate_into(minus, &mut b);
                let analytic = [&dx, &dy, &dz][axis];
                for component in 0..n {
                    let numeric = (a[component] - b[component]) / (2.0 * h);
                    assert_relative_eq!(analytic[component], numeric, epsilon = 1e-7);
                }
            }
        }
    }

    #[test]
    fn water_sto3g_has_seven_functions() {
        let mol = Molecule::from_angstrom(&[
            (8, [0.0, 0.0, 0.1173]),
            (1, [0.0, 0.7572, -0.4693]),
            (1, [0.0, -0.7572, -0.4693]),
        ])
        .unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        // O: 1s, 2s, 2p (5 functions); each H: 1s.
        assert_eq!(basis.n_shells(), 5);
        assert_eq!(basis.n_functions(), 7);
        assert_eq!(basis.offset(2), 2); // the 2p block starts after 1s and 2s
        assert_eq!(basis.max_angular_momentum(), 1);
    }

    #[test]
    fn third_row_elements_get_nine_functions() {
        let mol = Molecule::new(vec![Atom { z: 16, pos: [0.0; 3] }]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        // S: 1s, 2s, 2p, 3s, 3p.
        assert_eq!(basis.n_shells(), 5);
        assert_eq!(basis.n_functions(), 9);
    }

    #[test]
    fn every_supported_element_has_a_contraction() {
        for z in 1..=MAX_Z {
            let mol = Molecule::new(vec![Atom { z, pos: [0.0; 3] }]).unwrap();
            let basis = BasisSet::sto3g(&mol).unwrap();
            assert!(basis.n_functions() > 0, "no basis for Z={z}");
            // Enough functions to hold every electron in pairs.
            assert!(2 * basis.n_functions() >= z as usize, "basis too small for Z={z}");
        }
    }
}
