//! Basis functions on a block of grid points, leaving out the ones that vanish
//! there.
//!
//! Evaluating the basis was half the cost of the exchange-correlation term, and
//! a good part of what it produces is negligible: on benzene's fine grid a third
//! of all the values are below `1e-12` - core functions away from their own
//! nucleus, and nearly everything at the outer radial points. The grid is stored in a
//! spatially coherent order (see `grid::build`), so a block of consecutive
//! points is a small cluster, and a function that is negligible at the point of
//! the cluster nearest to its nucleus is negligible at all of them.
//!
//! What is left out has to be *provably* small, not probably: the bound below
//! holds for every point of the block, so screening removes values under
//! [`SCREENING`] and nothing else. The energy moves by less than `1e-12`
//! Hartree and the tests hold the screened and unscreened sums together.
//!
//! Shells that share a nucleus and exponents - STO-3G's 2s and 2p - are
//! evaluated together, so `exp(-a r^2)` is computed once per primitive for both.

use crate::basis::{powi, BasisSet};

/// Grid points per block: the grid's own blocking, which is what makes each
/// block compact. Big enough for the matrix products to pay off, small enough
/// that the basis-value block stays in cache.
pub(crate) use crate::grid::BLOCK;

/// A group of shells is left out of a block when no point of the block can see
/// any of its functions - or, for the gradient, their derivatives - above this.
///
/// Dropping a function `|phi_mu| < 1e-14` moves the density by at most
/// `2e-14 sum_nu |D_mu_nu phi_nu|`, which even beside an argon core is under
/// `1e-10` electrons per Bohr^3 at a point where the density is in the hundreds.
pub(crate) const SCREENING: f64 = 1e-14;

/// A primitive whose `a r^2` exceeds this is taken as exactly zero rather than
/// passed to `exp`. `e^-50` is `2e-22`; even multiplied by the `2a` a derivative
/// brings down and the largest normalised coefficient in the table (argon's
/// core), it stays below `1e-17`, three orders under [`SCREENING`].
const NEGLIGIBLE_EXPONENT: f64 = 50.0;

/// Makes `buffer` at least `len` long without touching what is already there.
fn grow(buffer: &mut Vec<f64>, len: usize) {
    if buffer.len() < len {
        buffer.resize(len, 0.0);
    }
}

/// One shell of a group.
struct Member {
    l: u8,
    /// First basis-function index.
    offset: usize,
    coefficients: Vec<f64>,
    powers: Vec<[u8; 3]>,
    scales: Vec<f64>,
}

/// Shells on one nucleus with identical exponents.
struct Group {
    origin: [f64; 3],
    exponents: Vec<f64>,
    members: Vec<Member>,
    /// Per primitive, the largest `|coefficient * scale|` over the members.
    reach: Vec<f64>,
    max_l: i32,
}

impl Group {
    /// An upper bound on `|phi|` over every point at least `d` from the
    /// nucleus, for every function of the group; with `derivative` set, on each
    /// component of `grad phi` as well.
    ///
    /// A component is `scale * sum_k c_k exp(-a_k r^2) * x^i y^j z^k`, and
    /// `|x^i y^j z^k| <= r^l <= max(1, r^L)` for every `l <= L`. So each primitive
    /// is bounded by the largest of `exp(-a r^2) max(1, r^m)` over `r >= d`,
    /// which is `exp(-a d^2)` or the peak of `r^m exp(-a r^2)` at
    /// `sqrt(m / 2a)`, whichever is larger (the peak only counts if it lies
    /// beyond `d`). A derivative brings down at most `l r^(l-1)` from the
    /// polynomial and `2 a r^(l+1)` from the Gaussian, which the same bound
    /// covers with `m = L` and `m = L + 1`.
    fn bound(&self, d: f64, derivative: bool) -> f64 {
        let beyond = |a: f64, m: i32| -> f64 {
            let flat = (-a * d * d).exp();
            if m == 0 {
                return flat;
            }
            let r = d.max((m as f64 / (2.0 * a)).sqrt());
            flat.max(r.powi(m) * (-a * r * r).exp())
        };
        let mut total = 0.0;
        for (&a, &reach) in self.exponents.iter().zip(&self.reach) {
            let value = beyond(a, self.max_l);
            let slope = if derivative {
                self.max_l as f64 * value + 2.0 * a * beyond(a, self.max_l + 1)
            } else {
                0.0
            };
            total += reach * value.max(slope);
        }
        total
    }
}

/// The basis on one block of points at a time.
pub(crate) struct BlockBasis {
    groups: Vec<Group>,
    threshold: f64,
    /// Basis-function indices of the functions kept for the current block.
    pub(crate) functions: Vec<usize>,
    /// The same as runs of consecutive indices, `(position in the block, first
    /// basis function, length)`. A group's functions are consecutive in the
    /// basis and so are the groups of one atom, so a block has a handful of
    /// runs, and adding a block into a full matrix is a few slice additions per
    /// column rather than one indexed add per entry.
    pub(crate) runs: Vec<(usize, usize, usize)>,
    /// Their values, one column of `functions.len()` entries per point.
    pub(crate) values: Vec<f64>,
    /// Their gradients with respect to the electron coordinate, laid out like
    /// `values`, filled only when asked for.
    pub(crate) gradient: [Vec<f64>; 3],
    kept: Vec<usize>,
    exponentials: Vec<f64>,
}

impl BlockBasis {
    pub(crate) fn new(basis: &BasisSet, threshold: f64) -> Self {
        let groups: Vec<Group> = basis
            .groups()
            .iter()
            .map(|group| {
                let first = &basis.shells[group.shells[0]];
                let members: Vec<Member> = group
                    .shells
                    .iter()
                    .map(|&s| {
                        let shell = &basis.shells[s];
                        Member {
                            l: shell.l,
                            offset: basis.offset(s),
                            coefficients: shell.coefficients.clone(),
                            powers: shell.powers.clone(),
                            scales: shell.scales.clone(),
                        }
                    })
                    .collect();
                let reach = (0..first.n_primitives())
                    .map(|k| {
                        members
                            .iter()
                            .map(|member| {
                                let scale =
                                    member.scales.iter().fold(0.0f64, |m, s| m.max(s.abs()));
                                member.coefficients[k].abs() * scale
                            })
                            .fold(0.0, f64::max)
                    })
                    .collect();
                Group {
                    origin: first.origin,
                    exponents: first.exponents.clone(),
                    members,
                    reach,
                    max_l: group.max_l as i32,
                }
            })
            .collect();
        let most_primitives = groups.iter().map(|g| g.exponents.len()).max().unwrap_or(0);
        BlockBasis {
            groups,
            threshold,
            functions: Vec::new(),
            runs: Vec::new(),
            values: Vec::new(),
            gradient: [Vec::new(), Vec::new(), Vec::new()],
            kept: Vec::new(),
            exponentials: vec![0.0; most_primitives],
        }
    }

    /// Chooses the functions that matter on `points` and evaluates them, with
    /// their gradients when `with_gradient` is set. Returns how many were kept;
    /// zero means the block contributes nothing.
    pub(crate) fn load(&mut self, points: &[[f64; 3]], with_gradient: bool) -> usize {
        self.kept.clear();
        self.functions.clear();
        for (index, group) in self.groups.iter().enumerate() {
            // Distance from the nucleus to the nearest point of the block.
            let nearest = points
                .iter()
                .map(|p| {
                    (p[0] - group.origin[0]).powi(2)
                        + (p[1] - group.origin[1]).powi(2)
                        + (p[2] - group.origin[2]).powi(2)
                })
                .fold(f64::INFINITY, f64::min)
                .sqrt();
            if group.bound(nearest, with_gradient) < self.threshold {
                continue;
            }
            self.kept.push(index);
            for member in &group.members {
                self.functions.extend(member.offset..member.offset + member.powers.len());
            }
        }

        self.runs.clear();
        for (position, &function) in self.functions.iter().enumerate() {
            match self.runs.last_mut() {
                Some((_, first, length)) if *first + *length == function => *length += 1,
                _ => self.runs.push((position, function, 1)),
            }
        }

        let m = self.functions.len();
        // Every entry up to `m * points.len()` is written below, so the buffers
        // only ever grow; clearing them each block was a measurable cost.
        grow(&mut self.values, m * points.len());
        if with_gradient {
            for axis in &mut self.gradient {
                grow(axis, m * points.len());
            }
        }
        if m == 0 {
            return 0;
        }

        for (j, &point) in points.iter().enumerate() {
            let mut slot = j * m;
            for &index in &self.kept {
                let group = &self.groups[index];
                let d = [
                    point[0] - group.origin[0],
                    point[1] - group.origin[1],
                    point[2] - group.origin[2],
                ];
                let r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
                for (e, &a) in self.exponentials.iter_mut().zip(&group.exponents) {
                    let exponent = a * r2;
                    *e = if exponent > NEGLIGIBLE_EXPONENT { 0.0 } else { (-exponent).exp() };
                }
                let exponentials = &self.exponentials[..group.exponents.len()];

                for member in &group.members {
                    // The same arithmetic, in the same order, as
                    // `Shell::evaluate_into` and `Shell::evaluate_gradient_into`,
                    // so an unscreened block reproduces them. s and p shells -
                    // all of STO-3G - skip the general monomial, whose factors
                    // of one change nothing but cost a branch each.
                    let mut radial = 0.0;
                    for (&c, &e) in member.coefficients.iter().zip(exponentials) {
                        radial += c * e;
                    }
                    match member.l {
                        0 => {
                            self.values[slot] = member.scales[0] * radial;
                            slot += 1;
                        }
                        1 => {
                            for axis in 0..3 {
                                self.values[slot] = member.scales[axis] * radial * d[axis];
                                slot += 1;
                            }
                        }
                        _ => {
                            for (&[lx, ly, lz], &scale) in member.powers.iter().zip(&member.scales)
                            {
                                self.values[slot] = scale
                                    * radial
                                    * powi(d[0], lx)
                                    * powi(d[1], ly)
                                    * powi(d[2], lz);
                                slot += 1;
                            }
                        }
                    }
                    if with_gradient && member.l <= 1 {
                        let mut radial = 0.0;
                        let mut radial_slope = 0.0;
                        for ((&c, &e), &a) in
                            member.coefficients.iter().zip(exponentials).zip(&group.exponents)
                        {
                            let term = c * e;
                            radial += term;
                            radial_slope += -2.0 * a * term;
                        }
                        let first = slot - member.powers.len();
                        if member.l == 0 {
                            for axis in 0..3 {
                                self.gradient[axis][first] =
                                    member.scales[0] * (d[axis] * radial_slope);
                            }
                        } else {
                            for component in 0..3 {
                                let scale = member.scales[component];
                                let tail = d[component] * radial_slope;
                                for axis in 0..3 {
                                    self.gradient[axis][first + component] = if axis == component {
                                        scale * (radial + d[axis] * tail)
                                    } else {
                                        scale * (d[axis] * tail)
                                    };
                                }
                            }
                        }
                    } else if with_gradient {
                        let mut radial = 0.0;
                        let mut radial_slope = 0.0;
                        for ((&c, &e), &a) in
                            member.coefficients.iter().zip(exponentials).zip(&group.exponents)
                        {
                            let term = c * e;
                            radial += term;
                            radial_slope += -2.0 * a * term;
                        }
                        let first = slot - member.powers.len();
                        for (component, (&powers, &scale)) in
                            member.powers.iter().zip(&member.scales).enumerate()
                        {
                            let monomial = [
                                powi(d[0], powers[0]),
                                powi(d[1], powers[1]),
                                powi(d[2], powers[2]),
                            ];
                            let product = monomial[0] * monomial[1] * monomial[2];
                            let lowered = |axis: usize| -> f64 {
                                if powers[axis] == 0 {
                                    return 0.0;
                                }
                                let mut term =
                                    powers[axis] as f64 * powi(d[axis], powers[axis] - 1);
                                for other in 0..3 {
                                    if other != axis {
                                        term *= monomial[other];
                                    }
                                }
                                term
                            };
                            let tail = product * radial_slope;
                            for axis in 0..3 {
                                self.gradient[axis][first + component] =
                                    scale * (lowered(axis) * radial + d[axis] * tail);
                            }
                        }
                    }
                }
            }
        }
        m
    }
}

/// The screened basis on every block of a grid, evaluated once.
///
/// Within one SCF neither the grid nor the basis changes, so every iteration
/// would evaluate exactly the same numbers; this keeps them. On benzene's fine
/// grid that is 3.6 million values - about 30 MB - held for the length of one
/// SCF and dropped with it.
pub struct BasisOnGrid {
    blocks: Vec<CachedBlock>,
    values: Vec<f64>,
}

struct CachedBlock {
    /// First grid point of the block; it runs to the next block's start.
    start: usize,
    count: usize,
    functions: Vec<usize>,
    runs: Vec<(usize, usize, usize)>,
    /// Where the block's `functions.len() * count` values begin.
    offset: usize,
}

/// One block as the exchange-correlation loops see it.
pub(crate) struct BlockView<'a> {
    pub(crate) start: usize,
    pub(crate) count: usize,
    pub(crate) functions: &'a [usize],
    pub(crate) runs: &'a [(usize, usize, usize)],
    /// `functions.len()` values per point, point after point.
    pub(crate) values: &'a [f64],
}

impl BasisOnGrid {
    pub fn new(basis: &BasisSet, grid: &crate::grid::MolecularGrid) -> Self {
        Self::with_threshold(basis, grid, SCREENING)
    }

    pub(crate) fn with_threshold(
        basis: &BasisSet,
        grid: &crate::grid::MolecularGrid,
        threshold: f64,
    ) -> Self {
        let mut source = BlockBasis::new(basis, threshold);
        let mut blocks = Vec::with_capacity(grid.len().div_ceil(BLOCK));
        let mut values = Vec::new();
        for (index, points) in grid.points.chunks(BLOCK).enumerate() {
            let m = source.load(points, false);
            if m == 0 {
                continue;
            }
            blocks.push(CachedBlock {
                start: index * BLOCK,
                count: points.len(),
                functions: source.functions.clone(),
                runs: source.runs.clone(),
                offset: values.len(),
            });
            values.extend_from_slice(&source.values[..m * points.len()]);
        }
        values.shrink_to_fit();
        BasisOnGrid { blocks, values }
    }

    /// Every block with at least one function on it, in grid order.
    pub(crate) fn blocks(&self) -> impl Iterator<Item = BlockView<'_>> {
        self.blocks.iter().map(|block| BlockView {
            start: block.start,
            count: block.count,
            functions: &block.functions,
            runs: &block.runs,
            values: &self.values[block.offset..block.offset + block.functions.len() * block.count],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis::Shell;
    use crate::grid::{self, GridQuality};
    use crate::molecule::Molecule;

    fn benzene() -> Molecule {
        let mut atoms = Vec::new();
        for i in 0..6 {
            let angle = i as f64 * std::f64::consts::PI / 3.0;
            atoms.push((6, [1.39 * angle.cos(), 1.39 * angle.sin(), 0.0]));
            atoms.push((1, [2.48 * angle.cos(), 2.48 * angle.sin(), 0.0]));
        }
        Molecule::from_angstrom(&atoms).unwrap()
    }

    /// With nothing screened, a block holds what the shells themselves evaluate:
    /// every function, in basis order, the same arithmetic. The only difference
    /// is the primitives past [`NEGLIGIBLE_EXPONENT`], which come out as zero
    /// instead of as `1e-40`.
    #[test]
    fn an_unscreened_block_is_the_plain_basis() {
        let molecule = benzene();
        let basis = BasisSet::sto3g(&molecule).unwrap();
        let grid = grid::build(&molecule, GridQuality::Coarse);
        let n = basis.n_functions();
        let mut blocks = BlockBasis::new(&basis, 0.0);
        let points = &grid.points[3000..3000 + BLOCK];
        assert_eq!(blocks.load(points, true), n);
        assert_eq!(blocks.functions, (0..n).collect::<Vec<_>>());
        let (mut value, mut dx, mut dy, mut dz) =
            (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        let same = |block: &[f64], plain: &[f64]| {
            for (b, p) in block.iter().zip(plain) {
                assert!((b - p).abs() <= 1e-17 + 1e-15 * p.abs(), "{b:e} vs {p:e}");
            }
        };
        for (j, &point) in points.iter().enumerate() {
            basis.evaluate_into(point, &mut value);
            basis.evaluate_gradient_into(point, &mut dx, &mut dy, &mut dz);
            same(&blocks.values[j * n..(j + 1) * n], &value);
            same(&blocks.gradient[0][j * n..(j + 1) * n], &dx);
            same(&blocks.gradient[1][j * n..(j + 1) * n], &dy);
            same(&blocks.gradient[2][j * n..(j + 1) * n], &dz);
        }
    }

    /// Everything screened out really is below the threshold, at every point of
    /// every block - values and, when asked for, derivatives. The bound is only
    /// worth having if it is never wrong.
    #[test]
    fn nothing_above_the_threshold_is_ever_left_out() {
        let molecule = benzene();
        // A d shell as well, so the polynomial part of the bound is exercised
        // beyond what STO-3G needs.
        let mut shells = BasisSet::sto3g(&molecule).unwrap().shells;
        shells.push(Shell::new(0, molecule.atoms[0].pos, 2, &[0.8, 0.2], &[0.5, 0.6]));
        let basis = BasisSet::from_shells(shells);
        let grid = grid::build(&molecule, GridQuality::Medium);
        let n = basis.n_functions();
        let mut blocks = BlockBasis::new(&basis, SCREENING);
        let (mut value, mut dx, mut dy, mut dz) =
            (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        let mut dropped = 0usize;
        for points in grid.points.chunks(BLOCK) {
            blocks.load(points, true);
            for &point in points {
                basis.evaluate_into(point, &mut value);
                basis.evaluate_gradient_into(point, &mut dx, &mut dy, &mut dz);
                for mu in (0..n).filter(|mu| !blocks.functions.contains(mu)) {
                    dropped += 1;
                    let largest = [value[mu], dx[mu], dy[mu], dz[mu]]
                        .iter()
                        .fold(0.0f64, |m, v| m.max(v.abs()));
                    assert!(largest < SCREENING, "dropped a function worth {largest:e}");
                }
            }
        }
        // And screening is not vacuous: a good share of the work goes away.
        let share = dropped as f64 / (grid.len() * n) as f64;
        assert!(share > 0.15, "only {share:.3} of the values were screened out");
    }
}
