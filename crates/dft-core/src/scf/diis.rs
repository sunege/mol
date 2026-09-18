//! Pulay's direct inversion in the iterative subspace.
//!
//! The Fock matrices of the last few iterations are combined so that the
//! commutator residual `FDS - SDF` is as small as possible in the least-squares
//! sense. Without it an LDA SCF on a molecule like benzene either oscillates or
//! needs hundreds of iterations.

use std::collections::VecDeque;

use nalgebra::{DMatrix, DVector};

/// History of Fock matrices with their residuals.
#[derive(Debug, Clone)]
pub struct Diis {
    subspace: usize,
    fock: VecDeque<DMatrix<f64>>,
    residual: VecDeque<DMatrix<f64>>,
}

impl Diis {
    pub fn new(subspace: usize) -> Self {
        assert!(subspace >= 2, "a DIIS subspace of one extrapolates nothing");
        Diis { subspace, fock: VecDeque::new(), residual: VecDeque::new() }
    }

    /// Records one iteration. `residual` is the commutator in an orthonormal
    /// basis, which vanishes exactly at convergence.
    pub fn push(&mut self, fock: DMatrix<f64>, residual: DMatrix<f64>) {
        if self.fock.len() == self.subspace {
            self.fock.pop_front();
            self.residual.pop_front();
        }
        self.fock.push_back(fock);
        self.residual.push_back(residual);
    }

    pub fn len(&self) -> usize {
        self.fock.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fock.is_empty()
    }

    /// Extrapolated Fock matrix, or `None` while the history is too short or the
    /// least-squares system is too ill-conditioned to trust - in which case the
    /// caller simply uses the latest Fock matrix.
    pub fn extrapolate(&self) -> Option<DMatrix<f64>> {
        let n = self.fock.len();
        if n < 2 {
            return None;
        }
        // [ B  1 ] [c]   [0]
        // [ 1' 0 ] [l] = [1]
        let size = n + 1;
        let mut system = DMatrix::zeros(size, size);
        for i in 0..n {
            for j in 0..n {
                system[(i, j)] = self.residual[i].dot(&self.residual[j]);
            }
            system[(i, n)] = 1.0;
            system[(n, i)] = 1.0;
        }
        let mut rhs = DVector::zeros(size);
        rhs[n] = 1.0;

        let solution = system.lu().solve(&rhs)?;
        if solution.iter().any(|v| !v.is_finite()) {
            return None;
        }
        // Wild coefficients mean the subspace has gone linearly dependent;
        // falling back to the plain Fock matrix is safer than following them.
        if solution.rows(0, n).amax() > 1e4 {
            return None;
        }

        let mut extrapolated = DMatrix::zeros(self.fock[0].nrows(), self.fock[0].ncols());
        for i in 0..n {
            extrapolated += &self.fock[i] * solution[i];
        }
        Some(extrapolated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn nothing_to_extrapolate_from_a_single_entry() {
        let mut diis = Diis::new(4);
        diis.push(DMatrix::identity(2, 2), DMatrix::identity(2, 2));
        assert!(diis.extrapolate().is_none());
    }

    #[test]
    fn coefficients_sum_to_one_and_kill_a_linear_residual() {
        // Two iterations whose residuals are exact opposites: the combination
        // with zero residual is the midpoint, so the extrapolated Fock matrix
        // must be the average of the two.
        let mut diis = Diis::new(4);
        let f1 = DMatrix::from_row_slice(2, 2, &[1.0, 0.0, 0.0, 1.0]);
        let f2 = DMatrix::from_row_slice(2, 2, &[3.0, 0.0, 0.0, 3.0]);
        let e1 = DMatrix::from_row_slice(2, 2, &[1.0, 0.0, 0.0, 1.0]);
        let e2 = DMatrix::from_row_slice(2, 2, &[-1.0, 0.0, 0.0, -1.0]);
        diis.push(f1, e1);
        diis.push(f2, e2);
        let extrapolated = diis.extrapolate().unwrap();
        assert_relative_eq!(extrapolated[(0, 0)], 2.0, epsilon = 1e-12);
    }

    #[test]
    fn history_is_capped_at_the_subspace_size() {
        let mut diis = Diis::new(3);
        for i in 0..10 {
            diis.push(
                DMatrix::from_element(2, 2, i as f64),
                DMatrix::from_element(2, 2, 1.0 / (i as f64 + 1.0)),
            );
        }
        assert_eq!(diis.len(), 3);
    }

    #[test]
    fn identical_residuals_are_rejected_rather_than_solved() {
        // A singular B matrix: the caller must be told to fall back.
        let mut diis = Diis::new(4);
        for _ in 0..3 {
            diis.push(DMatrix::identity(2, 2), DMatrix::from_element(2, 2, 0.5));
        }
        assert!(diis.extrapolate().is_none());
    }
}
