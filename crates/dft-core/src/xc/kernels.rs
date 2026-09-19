//! The two matrix products of the exchange-correlation term, at the size one
//! block gives them.
//!
//! Both are small - the block's basis functions (tens) against its grid points
//! (128) - and a general matrix-multiply library spends much of its time at that
//! size packing operands. On `wasm32` it is worse: `matrixmultiply` has no
//! WebAssembly kernel and its portable fallback was a third of the browser's
//! whole run time. These loops are written so the compiler can vectorise them
//! as they stand - every inner loop is an element-wise update along a
//! contiguous column, which needs no reordering of any sum - and both products
//! that are symmetric use only one triangle.
//!
//! Layout throughout: column-major, one column per grid point, `m` entries per
//! column.

/// Rows of the output held in registers at once.
const ROWS: usize = 4;

/// `out[:, j] = D phi[:, j]` for every point `j`, with `D` an `m x m`
/// column-major matrix.
///
/// A tile of four rows by two points is summed in registers over the whole of
/// `D`'s columns and written once: per step, one column slice of `D` and one
/// value per point are read for eight multiply-adds. Each entry is still the
/// sum over `b` in order, so the result does not depend on the tiling.
pub(crate) fn times_density(d: &[f64], m: usize, phi: &[f64], count: usize, out: &mut [f64]) {
    debug_assert!(d.len() >= m * m && phi.len() >= m * count && out.len() >= m * count);
    let full_rows = m - m % ROWS;
    let mut j = 0;
    while j < count {
        let pair = j + 1 < count;
        let p0 = &phi[j * m..(j + 1) * m];
        let p1 = if pair { &phi[(j + 1) * m..(j + 2) * m] } else { p0 };
        let mut a = 0;
        while a < full_rows {
            let mut first = [0.0; ROWS];
            let mut second = [0.0; ROWS];
            for b in 0..m {
                let column: &[f64; ROWS] = d[b * m + a..b * m + a + ROWS].try_into().unwrap();
                let (s0, s1) = (p0[b], p1[b]);
                for r in 0..ROWS {
                    first[r] += column[r] * s0;
                    second[r] += column[r] * s1;
                }
            }
            out[j * m + a..j * m + a + ROWS].copy_from_slice(&first);
            if pair {
                out[(j + 1) * m + a..(j + 1) * m + a + ROWS].copy_from_slice(&second);
            }
            a += ROWS;
        }
        for a in full_rows..m {
            let (mut first, mut second) = (0.0, 0.0);
            for b in 0..m {
                let value = d[b * m + a];
                first += value * p0[b];
                second += value * p1[b];
            }
            out[j * m + a] = first;
            if pair {
                out[(j + 1) * m + a] = second;
            }
        }
        j += 2;
    }
}

/// `rho[j] = phi[:, j]^T D phi[:, j]` for every point, with `D` symmetric.
///
/// The SCF needs the density at each point and nothing else of `D phi`, and a
/// quadratic form over a symmetric matrix only needs its lower triangle:
/// `sum_a phi_a (D_aa phi_a + 2 sum_(b<a) D_ab phi_b)`. `lower` is that
/// triangle, doubled below the diagonal and zero above it (see
/// [`doubled_lower_triangle`]), so the same tiles as [`times_density`] stop at
/// the diagonal and do half the work.
pub(crate) fn density_at_points(
    lower: &[f64],
    m: usize,
    phi: &[f64],
    count: usize,
    rho: &mut [f64],
) {
    debug_assert!(lower.len() >= m * m && phi.len() >= m * count && rho.len() >= count);
    let full_rows = m - m % ROWS;
    let mut j = 0;
    while j < count {
        let pair = j + 1 < count;
        let p0 = &phi[j * m..(j + 1) * m];
        let p1 = if pair { &phi[(j + 1) * m..(j + 2) * m] } else { p0 };
        let (mut rho0, mut rho1) = (0.0, 0.0);
        let mut a = 0;
        while a < full_rows {
            let mut first = [0.0; ROWS];
            let mut second = [0.0; ROWS];
            // Columns past the tile's last row are zero in the triangle.
            for b in 0..a + ROWS {
                let column: &[f64; ROWS] =
                    lower[b * m + a..b * m + a + ROWS].try_into().unwrap();
                let (s0, s1) = (p0[b], p1[b]);
                for r in 0..ROWS {
                    first[r] += column[r] * s0;
                    second[r] += column[r] * s1;
                }
            }
            for r in 0..ROWS {
                rho0 += p0[a + r] * first[r];
                rho1 += p1[a + r] * second[r];
            }
            a += ROWS;
        }
        for a in full_rows..m {
            let (mut first, mut second) = (0.0, 0.0);
            for b in 0..=a {
                let value = lower[b * m + a];
                first += value * p0[b];
                second += value * p1[b];
            }
            rho0 += p0[a] * first;
            rho1 += p1[a] * second;
        }
        rho[j] = rho0;
        if pair {
            rho[j + 1] = rho1;
        }
        j += 2;
    }
}

/// The lower triangle of a symmetric `m x m` matrix gathered from `full` at
/// `functions`, doubled below the diagonal and zero above it: what
/// [`density_at_points`] reads.
pub(crate) fn doubled_lower_triangle(
    full: &nalgebra::DMatrix<f64>,
    functions: &[usize],
    out: &mut Vec<f64>,
) {
    let m = functions.len();
    out.clear();
    for (b, &nu) in functions.iter().enumerate() {
        for (a, &mu) in functions.iter().enumerate() {
            out.push(match a.cmp(&b) {
                std::cmp::Ordering::Less => 0.0,
                std::cmp::Ordering::Equal => full[(mu, nu)],
                std::cmp::Ordering::Greater => 2.0 * full[(mu, nu)],
            });
        }
    }
    debug_assert_eq!(out.len(), m * m);
}

/// `out = sum_j scaled[:, j] phi[:, j]^T`, an `m x m` column-major matrix that
/// is symmetric whenever `scaled` is `phi` with each column multiplied by a
/// number - which is the only way it is used (`V_xc = Phi diag(w v) Phi^T`).
///
/// Four points at a time are added into the lower triangle as one rank-four
/// update, column by column, and the triangle is mirrored at the end: half a
/// full product, symmetric to the last bit. Here, unlike in [`times_density`],
/// the output is the small thing (a few kilobytes that stay in cache) and the
/// operands are the large one, so the loop runs over the points outside and
/// the matrix inside.
pub(crate) fn symmetric_product(
    scaled: &[f64],
    phi: &[f64],
    m: usize,
    count: usize,
    out: &mut [f64],
) {
    debug_assert!(scaled.len() >= m * count && phi.len() >= m * count && out.len() >= m * m);
    out[..m * m].fill(0.0);
    let mut j = 0;
    while j + 4 <= count {
        let s: [&[f64]; 4] = std::array::from_fn(|k| &scaled[(j + k) * m..(j + k + 1) * m]);
        let p: [&[f64]; 4] = std::array::from_fn(|k| &phi[(j + k) * m..(j + k + 1) * m]);
        for b in 0..m {
            let (p0, p1, p2, p3) = (p[0][b], p[1][b], p[2][b], p[3][b]);
            let column = &mut out[b * m + b..(b + 1) * m];
            for ((((target, &s0), &s1), &s2), &s3) in column
                .iter_mut()
                .zip(&s[0][b..])
                .zip(&s[1][b..])
                .zip(&s[2][b..])
                .zip(&s[3][b..])
            {
                *target += s0 * p0 + s1 * p1 + s2 * p2 + s3 * p3;
            }
        }
        j += 4;
    }
    while j < count {
        let s = &scaled[j * m..(j + 1) * m];
        let p = &phi[j * m..(j + 1) * m];
        for b in 0..m {
            let pb = p[b];
            let column = &mut out[b * m + b..(b + 1) * m];
            for (target, &value) in column.iter_mut().zip(&s[b..]) {
                *target += value * pb;
            }
        }
        j += 1;
    }
    for column in 0..m {
        for row in (column + 1)..m {
            out[row * m + column] = out[column * m + row];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::DMatrix;

    fn matrix(rows: usize, columns: usize, seed: usize) -> DMatrix<f64> {
        DMatrix::from_fn(rows, columns, |i, j| {
            (((i * 31 + j * 17 + seed) % 97) as f64 - 48.0) / 37.0
        })
    }

    #[test]
    fn times_density_is_the_matrix_product() {
        for (m, count) in [(1, 1), (7, 5), (36, 128), (13, 127), (4, 2)] {
            let d = matrix(m, m, 3);
            let phi = matrix(m, count, 11);
            let mut out = vec![f64::NAN; m * count];
            times_density(d.as_slice(), m, phi.as_slice(), count, &mut out);
            let expected = &d * &phi;
            for (got, want) in out.iter().zip(expected.iter()) {
                assert!((got - want).abs() < 1e-12 * (1.0 + want.abs()), "{got} vs {want}");
            }
        }
    }

    #[test]
    fn density_at_points_is_the_quadratic_form() {
        for (m, count) in [(1, 1), (7, 5), (36, 128), (13, 127), (4, 2), (9, 3)] {
            let raw = matrix(m, m, 7);
            let d = (&raw + raw.transpose()) * 0.5;
            let phi = matrix(m, count, 13);
            let functions: Vec<usize> = (0..m).collect();
            let mut lower = Vec::new();
            doubled_lower_triangle(&d, &functions, &mut lower);
            let mut rho = vec![f64::NAN; count];
            density_at_points(&lower, m, phi.as_slice(), count, &mut rho);
            for j in 0..count {
                let column = phi.column(j);
                let want = (column.transpose() * &d * column)[(0, 0)];
                assert!((rho[j] - want).abs() < 1e-12 * (1.0 + want.abs()), "{} vs {want}", rho[j]);
            }
        }
    }

    #[test]
    fn symmetric_product_is_the_matrix_product() {
        for (m, count) in [(1, 1), (7, 5), (36, 128), (13, 127), (4, 3)] {
            let phi = matrix(m, count, 5);
            let factors: Vec<f64> = (0..count).map(|j| ((j % 7) as f64 - 3.0) / 5.0).collect();
            let mut scaled = phi.clone();
            for (j, &f) in factors.iter().enumerate() {
                scaled.column_mut(j).scale_mut(f);
            }
            let mut out = vec![f64::NAN; m * m];
            symmetric_product(scaled.as_slice(), phi.as_slice(), m, count, &mut out);
            let expected = &scaled * phi.transpose();
            for (got, want) in out.iter().zip(expected.iter()) {
                assert!((got - want).abs() < 1e-12 * (1.0 + want.abs()), "{got} vs {want}");
            }
            // Symmetric to the last bit, not just to rounding.
            for a in 0..m {
                for b in 0..m {
                    assert_eq!(out[a * m + b], out[b * m + a]);
                }
            }
        }
    }
}
