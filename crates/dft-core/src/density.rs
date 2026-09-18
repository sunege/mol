//! The electron density on a regular Cartesian grid.
//!
//! This is the input to the isosurface: unlike the exchange-correlation
//! quadrature, which needs Becke's atom-centred cells, an isosurface wants a
//! uniform lattice so that marching cubes can walk it cell by cell.
//!
//! The evaluation itself is the same contraction the XC term uses,
//!
//! ```text
//! rho(r) = sum_mu_nu D_mu_nu phi_mu(r) phi_nu(r)
//! ```
//!
//! done in blocks so the inner product becomes a matrix product.

use nalgebra::{DMatrix, DMatrixView};

use crate::basis::BasisSet;
use crate::molecule::Molecule;

/// Grid points per block, as in [`crate::xc`]: large enough for the matrix
/// product to pay off, small enough to stay in cache.
const BLOCK: usize = 128;

/// Empty space kept beyond the outermost nucleus, in Bohr.
///
/// A hydrogen 1s density is already below 1e-4 electrons per cubic Bohr four
/// Bohr out, well under the smallest level the slider offers, so nothing the
/// user can ask for gets clipped by the box.
pub const DEFAULT_PADDING: f64 = 4.0;

/// Finest spacing the sampler will use, in Bohr (about 0.12 Angstrom).
pub const DEFAULT_SPACING: f64 = 0.22;

/// Ceiling on the number of sample points, which bounds both the evaluation
/// time and the memory the worker holds between slider moves. Large molecules
/// get a coarser spacing rather than a longer wait.
pub const DEFAULT_MAX_POINTS: usize = 300_000;

/// Where the sample lattice sits and how fine it is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridSpec {
    /// Position of sample `(0, 0, 0)` in Bohr.
    pub origin: [f64; 3],
    /// Distance between neighbouring samples in Bohr, the same on all axes so
    /// marching cubes works on cubes.
    pub spacing: f64,
    /// Number of samples along x, y and z.
    pub dims: [usize; 3],
}

impl GridSpec {
    /// A lattice that encloses the molecule with `padding` Bohr of space around
    /// it, at `spacing` or the coarsest spacing that fits in `max_points`.
    pub fn enclosing(
        molecule: &Molecule,
        padding: f64,
        spacing: f64,
        max_points: usize,
    ) -> GridSpec {
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for atom in &molecule.atoms {
            for k in 0..3 {
                low[k] = low[k].min(atom.pos[k]);
                high[k] = high[k].max(atom.pos[k]);
            }
        }

        let extent = [
            high[0] - low[0] + 2.0 * padding,
            high[1] - low[1] + 2.0 * padding,
            high[2] - low[2] + 2.0 * padding,
        ];
        // Cells of side `s` fill the box with extent.x*extent.y*extent.z / s^3
        // of them, so this is the finest spacing that stays inside the budget.
        let volume = extent[0] * extent[1] * extent[2];
        let spacing = spacing.max((volume / max_points.max(1) as f64).cbrt());

        let mut dims = [0usize; 3];
        let mut origin = [0.0; 3];
        for k in 0..3 {
            // One more sample than there are cells, and at least the two a cell
            // needs, so a flat molecule still gets a box with volume.
            dims[k] = (extent[k] / spacing).ceil() as usize + 1;
            dims[k] = dims[k].max(2);
            let centre = 0.5 * (low[k] + high[k]);
            origin[k] = centre - 0.5 * (dims[k] - 1) as f64 * spacing;
        }
        GridSpec { origin, spacing, dims }
    }

    /// The default lattice for a molecule.
    pub fn for_molecule(molecule: &Molecule) -> GridSpec {
        GridSpec::enclosing(molecule, DEFAULT_PADDING, DEFAULT_SPACING, DEFAULT_MAX_POINTS)
    }

    pub fn n_points(&self) -> usize {
        self.dims[0] * self.dims[1] * self.dims[2]
    }

    /// Linear index of a sample. `x` varies fastest, which is the order
    /// [`evaluate`] fills and marching cubes reads.
    pub fn index(&self, ix: usize, iy: usize, iz: usize) -> usize {
        (iz * self.dims[1] + iy) * self.dims[0] + ix
    }

    /// Position of a sample in Bohr.
    pub fn point(&self, ix: usize, iy: usize, iz: usize) -> [f64; 3] {
        [
            self.origin[0] + ix as f64 * self.spacing,
            self.origin[1] + iy as f64 * self.spacing,
            self.origin[2] + iz as f64 * self.spacing,
        ]
    }

    /// Position of the sample with linear index `i`.
    pub fn point_at(&self, i: usize) -> [f64; 3] {
        let ix = i % self.dims[0];
        let iy = (i / self.dims[0]) % self.dims[1];
        let iz = i / (self.dims[0] * self.dims[1]);
        self.point(ix, iy, iz)
    }
}

/// Sampled electron density, in electrons per cubic Bohr.
#[derive(Debug, Clone)]
pub struct DensityGrid {
    pub spec: GridSpec,
    /// One value per sample, indexed by [`GridSpec::index`].
    pub values: Vec<f64>,
}

impl DensityGrid {
    pub fn dims(&self) -> [usize; 3] {
        self.spec.dims
    }

    pub fn at(&self, ix: usize, iy: usize, iz: usize) -> f64 {
        self.values[self.spec.index(ix, iy, iz)]
    }

    pub fn max(&self) -> f64 {
        self.values.iter().copied().fold(0.0, f64::max)
    }

    /// `integral rho dr` by the midpoint-free sum over samples. It undershoots
    /// the electron count slightly because the sharp cusp at each nucleus is
    /// under-resolved, which is exactly why the SCF integrates on a Becke grid
    /// and this lattice is only ever used for display.
    pub fn integrate(&self) -> f64 {
        self.values.iter().sum::<f64>() * self.spec.spacing.powi(3)
    }

    /// Density gradient at a sample by central differences, one-sided on the
    /// faces of the box. Marching cubes turns this into the surface normal.
    pub fn gradient(&self, ix: usize, iy: usize, iz: usize) -> [f64; 3] {
        let [nx, ny, nz] = self.spec.dims;
        let index = [ix, iy, iz];
        let limit = [nx, ny, nz];
        let mut grad = [0.0; 3];
        for axis in 0..3 {
            let mut lo = index;
            let mut hi = index;
            if index[axis] > 0 {
                lo[axis] -= 1;
            }
            if index[axis] + 1 < limit[axis] {
                hi[axis] += 1;
            }
            let span = (hi[axis] - lo[axis]) as f64 * self.spec.spacing;
            if span == 0.0 {
                continue;
            }
            grad[axis] = (self.at(hi[0], hi[1], hi[2]) - self.at(lo[0], lo[1], lo[2])) / span;
        }
        grad
    }
}

/// Evaluates the density of `density` (the total, both spins) on `spec`.
///
/// `density` need not be a physical density matrix: the deformation density is a
/// difference of two, and comes out signed.
pub fn evaluate(basis: &BasisSet, density: &DMatrix<f64>, spec: &GridSpec) -> DensityGrid {
    let n = basis.n_functions();
    debug_assert_eq!(density.nrows(), n);

    let total = spec.n_points();
    let mut values = vec![0.0; total];
    // Column `j` holds every basis function at point `j` of the block, so each
    // column is contiguous and `D * phi` is a single matrix product.
    let mut phi_values = vec![0.0; n * BLOCK];

    let mut start = 0;
    while start < total {
        let count = BLOCK.min(total - start);
        for j in 0..count {
            basis.evaluate_into(spec.point_at(start + j), &mut phi_values[j * n..(j + 1) * n]);
        }
        let phi = DMatrixView::from_slice(&phi_values[..n * count], n, count);
        let weighted = density * phi;
        for j in 0..count {
            let mut rho = 0.0;
            for mu in 0..n {
                rho += phi[(mu, j)] * weighted[(mu, j)];
            }
            // Deliberately not clamped at zero. A real density matrix gives a
            // non-negative quadratic form anyway, to within rounding in the far
            // tail, and the same routine samples the signed deformation density
            // (see `crate::bonding`), where the negative half is the point.
            values[start + j] = rho;
        }
        start += count;
    }

    DensityGrid { spec: *spec, values }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis::Shell;
    use crate::molecule::Atom;
    use approx::assert_relative_eq;

    #[test]
    fn the_box_encloses_every_nucleus_with_the_requested_padding() {
        let mol = Molecule::from_angstrom(&[
            (8, [0.0, 0.0, 0.1173]),
            (1, [0.0, 0.7572, -0.4693]),
            (1, [0.0, -0.7572, -0.4693]),
        ])
        .unwrap();
        let spec = GridSpec::enclosing(&mol, 4.0, 0.22, DEFAULT_MAX_POINTS);
        let far = spec.point(spec.dims[0] - 1, spec.dims[1] - 1, spec.dims[2] - 1);
        for atom in &mol.atoms {
            for k in 0..3 {
                assert!(atom.pos[k] - spec.origin[k] >= 4.0 - 1e-9, "padding on the low side");
                assert!(far[k] - atom.pos[k] >= 4.0 - 1e-9, "padding on the high side");
            }
        }
        // Water is planar in x, and the box still has to have thickness there.
        assert!(spec.dims[0] >= 2);
    }

    #[test]
    fn the_point_budget_coarsens_the_spacing_instead_of_growing_the_grid() {
        // A long chain: at the finest spacing this box would need far more than
        // the budget allows.
        let atoms: Vec<Atom> =
            (0..40).map(|i| Atom { z: 6, pos: [i as f64 * 2.6, 0.0, 0.0] }).collect();
        let mol = Molecule::new(atoms).unwrap();
        let budget = 50_000;
        let spec = GridSpec::enclosing(&mol, 4.0, 0.22, budget);
        assert!(spec.spacing > 0.22, "spacing should have been coarsened");
        // `ceil` on each axis can overshoot the budget a little; a factor of two
        // would mean the spacing formula is wrong.
        assert!(spec.n_points() < 2 * budget, "{} points", spec.n_points());
    }

    #[test]
    fn linear_index_and_position_agree() {
        let mol = Molecule::new(vec![Atom { z: 1, pos: [0.0; 3] }]).unwrap();
        let spec = GridSpec::for_molecule(&mol);
        for (ix, iy, iz) in [(0, 0, 0), (3, 1, 2), (spec.dims[0] - 1, 0, spec.dims[2] - 1)] {
            let i = spec.index(ix, iy, iz);
            assert_eq!(spec.point_at(i), spec.point(ix, iy, iz));
        }
        assert_eq!(spec.index(spec.dims[0] - 1, spec.dims[1] - 1, spec.dims[2] - 1) + 1, spec.n_points());
    }

    /// A single normalised s function with occupation two integrates to two
    /// electrons, and the lattice is fine enough to see that.
    #[test]
    fn a_single_gaussian_integrates_to_its_occupation() {
        let mol = Molecule::new(vec![Atom { z: 1, pos: [0.0; 3] }]).unwrap();
        // Deliberately wide, so the lattice resolves it and the box contains it.
        let basis = BasisSet::from_shells(vec![Shell::new(0, [0.0; 3], 0, &[0.4], &[1.0])]);
        let spec = GridSpec::for_molecule(&mol);
        let density = DMatrix::from_element(1, 1, 2.0);
        let grid = evaluate(&basis, &density, &spec);
        assert_relative_eq!(grid.integrate(), 2.0, max_relative = 1e-4);

        // And the samples themselves are the function, squared and doubled.
        let point = spec.point(3, 4, 5);
        let phi = basis.evaluate(point)[0];
        assert_relative_eq!(grid.at(3, 4, 5), 2.0 * phi * phi, max_relative = 1e-12);
    }

    #[test]
    fn the_gradient_matches_a_finite_difference_of_the_samples() {
        let mol = Molecule::new(vec![Atom { z: 1, pos: [0.0; 3] }]).unwrap();
        let basis = BasisSet::from_shells(vec![Shell::new(0, [0.0; 3], 0, &[0.4], &[1.0])]);
        let spec = GridSpec::for_molecule(&mol);
        let grid = evaluate(&basis, &DMatrix::from_element(1, 1, 2.0), &spec);

        let (ix, iy, iz) = (12, 9, 7);
        let analytic = grid.gradient(ix, iy, iz);
        let h = spec.spacing;
        let expected = [
            (grid.at(ix + 1, iy, iz) - grid.at(ix - 1, iy, iz)) / (2.0 * h),
            (grid.at(ix, iy + 1, iz) - grid.at(ix, iy - 1, iz)) / (2.0 * h),
            (grid.at(ix, iy, iz + 1) - grid.at(ix, iy, iz - 1)) / (2.0 * h),
        ];
        for k in 0..3 {
            assert_relative_eq!(analytic[k], expected[k], max_relative = 1e-12);
        }

        // On the face of the box the difference is one-sided but still a
        // difference quotient of neighbouring samples.
        let edge = grid.gradient(0, iy, iz);
        assert_relative_eq!(edge[0], (grid.at(1, iy, iz) - grid.at(0, iy, iz)) / h, max_relative = 1e-12);
    }

    #[test]
    fn a_real_density_matrix_stays_non_negative() {
        // Nothing clamps the samples, so this is a statement about the algebra:
        // the quadratic form of a positive semi-definite density matrix cannot
        // go negative except by rounding.
        let mol = Molecule::from_angstrom(&[(8, [0.0; 3]), (1, [0.0, 0.0, 0.96])]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let n = basis.n_functions();
        let spec = GridSpec::for_molecule(&mol);
        let grid = evaluate(&basis, &(DMatrix::identity(n, n) * 0.5), &spec);
        let lowest = grid.values.iter().copied().fold(f64::INFINITY, f64::min);
        assert!(lowest > -1e-12, "sample at {lowest}");
        assert!(grid.max() > 0.0);
    }

    #[test]
    fn a_difference_of_density_matrices_comes_out_signed() {
        // What the deformation density needs: the samples are not clamped.
        let mol = Molecule::from_angstrom(&[(1, [0.0; 3]), (1, [0.0, 0.0, 0.74])]).unwrap();
        let basis = BasisSet::sto3g(&mol).unwrap();
        let n = basis.n_functions();
        let spec = GridSpec::for_molecule(&mol);
        let grid = evaluate(&basis, &(DMatrix::identity(n, n) * -1.0), &spec);
        assert!(grid.values.iter().copied().fold(f64::INFINITY, f64::min) < -0.01);
    }
}
