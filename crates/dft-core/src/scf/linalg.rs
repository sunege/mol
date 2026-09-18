//! The two linear-algebra steps the SCF needs beyond matrix products.
//!
//! The eigensolver is written here rather than taken from `nalgebra`, and that
//! is not a preference. `nalgebra 0.33`'s `SymmetricEigen` returns, for some
//! Kohn-Sham matrices this engine produces, an orthonormal set of vectors that
//! does not belong to the eigenvalues beside it: two eigenpairs come back
//! rotated into each other, and `V L V^T` differs from the input by parts in
//! ten, not parts in 1e15. Phases 2 to 4 could not see it, because a mixture of
//! two *occupied* orbitals holds exactly the same density, and the density is
//! all the energy depends on. The gradient can see it immediately: the Pulay
//! term weights each orbital by its own energy, so mixing two orbitals with
//! different energies corrupts the force while leaving the energy perfect.
//!
//! What is used instead is the cyclic Jacobi method. It is slower in theory and
//! irrelevant in practice at this size (benzene is a 36 by 36 matrix, which is
//! nothing beside one exchange-correlation grid pass), and it has the property
//! that matters here: the eigenvectors are the accumulated product of the exact
//! plane rotations that diagonalised the matrix, so `A V = V L` holds by
//! construction rather than by trust.

use nalgebra::{DMatrix, DVector};

/// Overlap eigenvalues below this are dropped as linearly dependent. STO-3G is
/// far from over-complete so this should never fire, but a user is free to place
/// two atoms almost on top of each other.
pub const OVERLAP_THRESHOLD: f64 = 1e-8;

/// Jacobi sweeps before giving up. Convergence is quadratic and eight sweeps is
/// already generous for any matrix this engine builds; the cap only exists so a
/// pathological input cannot hang the worker.
const MAX_SWEEPS: usize = 60;

/// Eigenvalues in ascending order with the matching eigenvectors as columns.
///
/// Ordering matters to everything downstream - which orbitals are occupied,
/// where the HOMO is - and the pairing matters to the gradient.
pub fn symmetric_eigen_sorted(matrix: DMatrix<f64>) -> (DVector<f64>, DMatrix<f64>) {
    let n = matrix.nrows();
    debug_assert_eq!(n, matrix.ncols(), "eigen decomposition needs a square matrix");
    let (values, vectors) = jacobi_eigen(matrix);

    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        values[a]
            .partial_cmp(&values[b])
            .expect("eigenvalues of a symmetric matrix are real")
    });
    let sorted_values = DVector::from_iterator(n, order.iter().map(|&i| values[i]));
    let mut sorted_vectors = DMatrix::zeros(n, n);
    for (column, &i) in order.iter().enumerate() {
        sorted_vectors.set_column(column, &vectors.column(i));
    }
    (sorted_values, sorted_vectors)
}

/// Cyclic Jacobi diagonalisation of a symmetric matrix.
///
/// Repeatedly zeroes the largest remaining off-diagonal entries with plane
/// rotations. The diagonal converges to the eigenvalues and the product of the
/// rotations to the eigenvectors, in the order the diagonal ends up in.
fn jacobi_eigen(matrix: DMatrix<f64>) -> (DVector<f64>, DMatrix<f64>) {
    let n = matrix.nrows();
    // Symmetrised explicitly: the caller's matrix is symmetric up to rounding,
    // and the rotations below assume it exactly.
    let mut a = (&matrix + matrix.transpose()) * 0.5;
    let mut vectors = DMatrix::identity(n, n);
    if n < 2 {
        return (a.diagonal(), vectors);
    }

    // What counts as "already diagonal", measured against the size of the
    // matrix so the test means the same thing for an overlap and for a core
    // Hamiltonian twenty Hartree deep.
    let tolerance = f64::EPSILON * a.norm().max(f64::MIN_POSITIVE);

    for sweep in 0..MAX_SWEEPS {
        let mut off_diagonal = 0.0;
        for p in 0..n {
            for q in (p + 1)..n {
                off_diagonal += a[(p, q)].abs();
            }
        }
        if off_diagonal <= tolerance {
            break;
        }
        // The opening sweeps skip the small entries: rotating them away costs
        // as much as rotating a large one and buys far less.
        let threshold = if sweep < 3 {
            0.2 * off_diagonal / (n * n) as f64
        } else {
            0.0
        };

        for p in 0..(n - 1) {
            for q in (p + 1)..n {
                let apq = a[(p, q)];
                if apq.abs() <= threshold {
                    continue;
                }
                // An entry too small to change either diagonal element is set
                // to zero outright, which is what lets the sweep loop finish.
                if sweep > 3
                    && a[(p, p)].abs() + 100.0 * apq.abs() == a[(p, p)].abs()
                    && a[(q, q)].abs() + 100.0 * apq.abs() == a[(q, q)].abs()
                {
                    a[(p, q)] = 0.0;
                    a[(q, p)] = 0.0;
                    continue;
                }

                // The rotation that annihilates a[p][q]: tan of the angle is
                // the smaller root of t^2 + 2 theta t - 1 = 0, and taking the
                // smaller root is what keeps the rotation close to the identity.
                let theta = 0.5 * (a[(q, q)] - a[(p, p)]) / apq;
                let root = (theta * theta + 1.0).sqrt();
                let t = if theta >= 0.0 {
                    1.0 / (theta + root)
                } else {
                    -1.0 / (-theta + root)
                };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;

                for k in 0..n {
                    if k == p || k == q {
                        continue;
                    }
                    let akp = a[(k, p)];
                    let akq = a[(k, q)];
                    let new_p = c * akp - s * akq;
                    let new_q = s * akp + c * akq;
                    a[(k, p)] = new_p;
                    a[(p, k)] = new_p;
                    a[(k, q)] = new_q;
                    a[(q, k)] = new_q;
                }
                let (app, aqq) = (a[(p, p)], a[(q, q)]);
                a[(p, p)] = c * c * app - 2.0 * s * c * apq + s * s * aqq;
                a[(q, q)] = s * s * app + 2.0 * s * c * apq + c * c * aqq;
                a[(p, q)] = 0.0;
                a[(q, p)] = 0.0;

                for k in 0..n {
                    let vkp = vectors[(k, p)];
                    let vkq = vectors[(k, q)];
                    vectors[(k, p)] = c * vkp - s * vkq;
                    vectors[(k, q)] = s * vkp + c * vkq;
                }
            }
        }
    }
    (a.diagonal(), vectors)
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

    /// The property everything else rests on: the decomposition reproduces the
    /// matrix. This is exactly what `nalgebra`'s solver failed to do, and it
    /// failed silently - orthonormal vectors, correct eigenvalues, wrong
    /// pairing - so nothing short of recomposing the matrix catches it.
    fn check_decomposition(matrix: &DMatrix<f64>, tolerance: f64) {
        let n = matrix.nrows();
        let (values, vectors) = symmetric_eigen_sorted(matrix.clone());

        for i in 1..n {
            assert!(values[i - 1] <= values[i], "eigenvalues came back unsorted");
        }
        let identity: DMatrix<f64> = DMatrix::identity(n, n);
        assert_relative_eq!(
            vectors.transpose() * &vectors,
            identity,
            epsilon = tolerance
        );
        for i in 0..n {
            let left = matrix * vectors.column(i);
            let right = vectors.column(i) * values[i];
            assert_relative_eq!(left, right, epsilon = tolerance);
        }
        let recomposed = &vectors * DMatrix::from_diagonal(&values) * vectors.transpose();
        assert_relative_eq!(recomposed, matrix.clone(), epsilon = tolerance);
    }

    /// A Kohn-Sham matrix of distorted water in the orthonormal basis, written
    /// out to the digit.
    ///
    /// GENERATED, not typed: printed from `x^T F x` of the converged SCF that
    /// first exposed the bug. `nalgebra 0.33` diagonalises this one into vectors
    /// whose recomposition is off by 0.64 - two of the seven eigenpairs are
    /// rotated into each other. The engine's own energies were still right,
    /// which is why it survived three phases unnoticed; the gradient was not.
    fn water_kohn_sham() -> DMatrix<f64> {
        DMatrix::from_row_slice(
            7,
            7,
            &[
                -18.278580732261, 0.148905920665, 0.031455838795, -0.019000186503,
                0.008945568527, -0.006946087674, 0.005046932069, 0.148905920665,
                -0.797862661674, 0.086700838186, -0.053386936767, 0.024953348142,
                -0.019362946795, 0.014058480746, 0.031455838795, 0.086700838186,
                -0.281766938043, 0.078982118431, -0.037019424549, 0.028710556945,
                -0.020854270885, -0.019000186503, -0.053386936767, 0.078982118431,
                -0.226624610806, 0.020894877093, -0.016240946563, 0.011811127296,
                0.008945568527, 0.024953348142, -0.037019424549, 0.020894877093,
                -0.097372770396, 0.006963351255, -0.005069136851, -0.006946087674,
                -0.019362946795, 0.028710556945, -0.016240946563, 0.006963351255,
                0.167262351286, 0.003745907011, 0.005046932069, 0.014058480746,
                -0.020854270885, 0.011811127296, -0.005069136851, 0.003745907011,
                0.230424049334,
            ],
        )
    }

    #[test]
    fn a_kohn_sham_matrix_decomposes_consistently() {
        check_decomposition(&water_kohn_sham(), 1e-12);
    }

    #[test]
    fn decomposition_holds_for_random_matrices() {
        for (n, seed) in [(2, 1), (3, 5), (7, 11), (12, 17), (25, 23)] {
            check_decomposition(&random_symmetric(n, seed), 1e-11);
        }
    }

    /// A wide spread of eigenvalues, which is what a core Hamiltonian has: the
    /// 1s level of oxygen sits twenty Hartree below the valence ones, and that
    /// separation is where the pairing went wrong.
    #[test]
    fn decomposition_holds_across_a_wide_eigenvalue_range() {
        let n = 8;
        let scales = DVector::from_fn(n, |i, _| 10f64.powi(i as i32 - 4));
        let rotation = {
            // An orthogonal matrix, from the eigenvectors of something random.
            let (_, q) = symmetric_eigen_sorted(random_symmetric(n, 99));
            q
        };
        let matrix = &rotation * DMatrix::from_diagonal(&scales) * rotation.transpose();
        let matrix = (&matrix + matrix.transpose()) * 0.5;
        let (values, _) = symmetric_eigen_sorted(matrix.clone());
        // The matrix spans seven decades, so the smallest eigenvalue can only
        // be resolved to about `eps * condition number` in relative terms. That
        // is the accuracy of the arithmetic, not of the method.
        for i in 0..n {
            assert_relative_eq!(values[i], scales[i], max_relative = 1e-8);
        }
        check_decomposition(&matrix, 1e-10);
    }

    /// Degenerate eigenvalues are the case a Jacobi rotation has to handle by
    /// its own convention rather than by the usual formula.
    #[test]
    fn degenerate_eigenvalues_still_decompose() {
        let mut matrix = DMatrix::identity(5, 5) * 3.0;
        matrix[(0, 1)] = 0.5;
        matrix[(1, 0)] = 0.5;
        check_decomposition(&matrix, 1e-12);
        let (values, _) = symmetric_eigen_sorted(matrix);
        assert_relative_eq!(values[0], 2.5, epsilon = 1e-12);
        assert_relative_eq!(values[4], 3.5, epsilon = 1e-12);
    }

    #[test]
    fn a_one_by_one_matrix_is_already_diagonal() {
        let (values, vectors) = symmetric_eigen_sorted(DMatrix::from_element(1, 1, -2.5));
        assert_relative_eq!(values[0], -2.5, epsilon = 1e-15);
        assert_relative_eq!(vectors[(0, 0)], 1.0, epsilon = 1e-15);
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
