//! The two linear-algebra steps the SCF needs beyond matrix products.

use nalgebra::{DMatrix, DVector, SymmetricEigen};

/// Overlap eigenvalues below this are dropped as linearly dependent. STO-3G is
/// far from over-complete so this should never fire, but a user is free to place
/// two atoms almost on top of each other.
pub const OVERLAP_THRESHOLD: f64 = 1e-8;

/// Eigenvalues in ascending order with the matching eigenvectors as columns.
///
/// `SymmetricEigen` does not order its output, and everything downstream (orbital
/// occupation, HOMO/LUMO) depends on the ordering.
pub fn symmetric_eigen_sorted(matrix: DMatrix<f64>) -> (DVector<f64>, DMatrix<f64>) {
    let n = matrix.nrows();
    let eigen = SymmetricEigen::new(matrix);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        eigen.eigenvalues[a]
            .partial_cmp(&eigen.eigenvalues[b])
            .expect("eigenvalues of a symmetric matrix are real")
    });
    let values = DVector::from_iterator(n, order.iter().map(|&i| eigen.eigenvalues[i]));
    let mut vectors = DMatrix::zeros(n, n);
    for (column, &i) in order.iter().enumerate() {
        vectors.set_column(column, &eigen.eigenvectors.column(i));
    }
    (values, vectors)
}

/// Canonical orthogonalisation: a matrix `X` with `X^T S X = I`.
///
/// `X = U s^(-1/2)` from the eigendecomposition of the overlap, with columns
/// whose eigenvalue is below `threshold` discarded. The result can therefore have
/// fewer columns than rows, which shrinks the orbital space rather than letting a
/// near-singular overlap wreck the SCF.
pub fn canonical_orthogonalizer(overlap: &DMatrix<f64>, threshold: f64) -> DMatrix<f64> {
    let (values, vectors) = symmetric_eigen_sorted(overlap.clone());
    let keep: Vec<usize> = (0..values.len()).filter(|&i| values[i] > threshold).collect();
    let mut x = DMatrix::zeros(overlap.nrows(), keep.len());
    for (column, &i) in keep.iter().enumerate() {
        let scale = 1.0 / values[i].sqrt();
        x.set_column(column, &(vectors.column(i) * scale));
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    fn random_symmetric(n: usize, seed: u64) -> DMatrix<f64> {
        // A deterministic, reproducible spread of values; no rng dependency.
        let mut state = seed;
        let mut next = || {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            ((state >> 11) as f64 / (1u64 << 53) as f64) - 0.5
        };
        let a = DMatrix::from_fn(n, n, |_, _| next());
        &a + &a.transpose()
    }

    #[test]
    fn eigenvalues_come_back_sorted_with_matching_vectors() {
        let matrix = random_symmetric(6, 42);
        let (values, vectors) = symmetric_eigen_sorted(matrix.clone());
        for i in 1..values.len() {
            assert!(values[i - 1] <= values[i]);
        }
        for i in 0..values.len() {
            let left = &matrix * vectors.column(i);
            let right = vectors.column(i) * values[i];
            assert_relative_eq!(left, right, epsilon = 1e-10);
        }
    }

    #[test]
    fn orthogonalizer_diagonalises_the_overlap() {
        // A genuine overlap matrix: Gram matrix of linearly independent vectors.
        let basis = random_symmetric(5, 7) + DMatrix::identity(5, 5) * 4.0;
        let overlap = &basis * &basis.transpose();
        let x = canonical_orthogonalizer(&overlap, OVERLAP_THRESHOLD);
        let identity = x.transpose() * &overlap * &x;
        assert_relative_eq!(identity, DMatrix::identity(5, 5), epsilon = 1e-10);
    }

    #[test]
    fn near_dependent_directions_are_dropped() {
        // Two nearly identical functions: one combination has almost no norm.
        let overlap = DMatrix::from_row_slice(2, 2, &[1.0, 1.0 - 1e-12, 1.0 - 1e-12, 1.0]);
        let x = canonical_orthogonalizer(&overlap, 1e-8);
        assert_eq!(x.ncols(), 1, "the dependent direction should be discarded");
        let identity = x.transpose() * &overlap * &x;
        assert_relative_eq!(identity[(0, 0)], 1.0, epsilon = 1e-8);
    }
}
