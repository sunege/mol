//! Marching cubes: a triangle mesh for one level set of a sampled scalar field.
//!
//! The 256-case table is **derived, not transcribed**. Published tables encode a
//! particular set of disambiguation choices, and a single mistyped entry leaves
//! a hole that no energy test would ever catch, so the table is constructed here
//! from the definition instead:
//!
//! 1. A cube edge is *cut* when its two corners fall on opposite sides of the
//!    level. Each face of the cube then carries zero, two or four cut edges.
//! 2. Two cut edges on a face are joined by one contour segment. Four cut edges
//!    mean the two corners above the level sit diagonally, and the contour can
//!    be drawn two ways; this module always separates them, that is, it treats
//!    the centre of the face as being below the level. The rule only looks at
//!    the four corner values, which the two cubes sharing the face both see, so
//!    neighbouring cubes cannot disagree and the mesh cannot have holes.
//! 3. Every cut edge lies on exactly two faces, so it ends up with one segment
//!    arriving and one leaving: the segments close into loops with no
//!    leftovers. Each loop is emitted as a triangle fan.
//!
//! Winding is baked into the table as well. Each contour segment is given a
//! direction from the corner signs alone, so that the surface it carries faces
//! away from the corners above the level; a segment on a shared face is then
//! walked the opposite way by the cube on the other side, which is exactly what
//! consistent winding across the mesh means.
//!
//! One consequence of the fan worth knowing before reading the tests: the
//! diagonals it draws are interior to their loop, and two loops that happen to
//! share a pair of non-consecutive vertices each draw the same diagonal. Such an
//! edge sits in four triangles without there being a hole anywhere, so closure
//! is checked by walking every directed edge and requiring the reverse walk to
//! cancel it, rather than by counting triangles per edge.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::density::DensityGrid;

/// A triangle mesh, laid out the way a GPU vertex buffer wants it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    /// Three coordinates per vertex, in Bohr.
    pub positions: Vec<f32>,
    /// Three components per vertex, a unit vector pointing away from the dense
    /// side of the surface.
    pub normals: Vec<f32>,
    /// Three indices per triangle.
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn n_vertices(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn n_triangles(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    /// Vertex `i` as a `[f64; 3]`.
    pub fn vertex(&self, i: usize) -> [f64; 3] {
        [
            self.positions[3 * i] as f64,
            self.positions[3 * i + 1] as f64,
            self.positions[3 * i + 2] as f64,
        ]
    }

    /// Normal of vertex `i`.
    pub fn normal(&self, i: usize) -> [f64; 3] {
        [
            self.normals[3 * i] as f64,
            self.normals[3 * i + 1] as f64,
            self.normals[3 * i + 2] as f64,
        ]
    }
}

/// Corner `v` of a cube, in units of the cell: bit 0 is x, bit 1 is y, bit 2 z.
fn corner_offset(v: usize) -> [usize; 3] {
    [v & 1, (v >> 1) & 1, (v >> 2) & 1]
}

/// The twelve edges, each as (corner it starts from, axis it runs along).
fn build_edges() -> Vec<(usize, usize)> {
    let mut edges = Vec::with_capacity(12);
    for axis in 0..3 {
        for v in 0..8 {
            if v & (1 << axis) == 0 {
                edges.push((v, axis));
            }
        }
    }
    edges
}

/// The six faces, each as its four corners in cyclic order around the face.
fn build_faces() -> Vec<[usize; 4]> {
    let mut faces = Vec::with_capacity(6);
    for axis in 0..3 {
        let u = (axis + 1) % 3;
        let v = (axis + 2) % 3;
        for side in 0..2 {
            let at = |a: usize, b: usize| (side << axis) | (a << u) | (b << v);
            faces.push([at(0, 0), at(1, 0), at(1, 1), at(0, 1)]);
        }
    }
    faces
}

/// Contour loops of every corner configuration, as lists of edge indices.
///
/// Index `mask`, where bit `v` is set when corner `v` is above the level.
struct CaseTable {
    edges: Vec<(usize, usize)>,
    loops: Vec<Vec<Vec<u8>>>,
}

fn table() -> &'static CaseTable {
    static TABLE: OnceLock<CaseTable> = OnceLock::new();
    TABLE.get_or_init(build_table)
}

fn build_table() -> CaseTable {
    let edges = build_edges();
    let faces = build_faces();
    let index_of: HashMap<(usize, usize), usize> = edges
        .iter()
        .enumerate()
        .map(|(i, &(v, axis))| ((v.min(v | 1 << axis), v.max(v | 1 << axis)), i))
        .collect();

    let loops = (0..256u16)
        .map(|mask| build_case(mask as u8, &edges, &faces, &index_of))
        .collect();
    CaseTable { edges, loops }
}

fn build_case(
    mask: u8,
    edges: &[(usize, usize)],
    faces: &[[usize; 4]],
    index_of: &HashMap<(usize, usize), usize>,
) -> Vec<Vec<u8>> {
    let above = |v: usize| mask & (1 << v) != 0;
    let edge_between = |a: usize, b: usize| index_of[&(a.min(b), a.max(b))];

    // Directed successor of each cut edge. Giving the segments a direction as
    // they are made is what makes the loops come out wound around their own
    // outward normal, with no geometry to guess at afterwards.
    let mut next = [usize::MAX; 12];

    for (f, face) in faces.iter().enumerate() {
        // `build_faces` lists the two sides of each axis in turn.
        let (axis, side) = (f / 2, f % 2);
        let mut face_normal = [0.0; 3];
        face_normal[axis] = if side == 1 { 1.0 } else { -1.0 };

        // Cut edges, named by their position in the cyclic corner list: edge `k`
        // runs from `face[k]` to `face[k + 1]`.
        let cut: Vec<usize> =
            (0..4).filter(|&k| above(face[k]) != above(face[(k + 1) % 4])).collect();

        // Each segment, as the two cut edges it joins plus the in-plane
        // direction from the side above the level to the side below it.
        let segments: Vec<(usize, usize, [f64; 3])> = match cut.len() {
            0 => Vec::new(),
            2 => {
                let ends: Vec<usize> = cut
                    .iter()
                    .map(|&k| edge_between(face[k], face[(k + 1) % 4]))
                    .collect();
                let mean = |take_above: bool| {
                    let members: Vec<usize> =
                        face.iter().copied().filter(|&c| above(c) == take_above).collect();
                    let mut centre = [0.0; 3];
                    for &c in &members {
                        let p = corner_point(c);
                        for k in 0..3 {
                            centre[k] += p[k] / members.len() as f64;
                        }
                    }
                    centre
                };
                vec![(ends[0], ends[1], subtract(mean(false), mean(true)))]
            }
            4 => {
                // Ambiguous face: the two corners above the level are diagonal.
                // Cutting each of them off on its own - taking the centre of the
                // face to be below the level - joins the two edges that meet at
                // it. The rule reads only the four corner values, which the two
                // cubes sharing this face both see, so they cannot disagree.
                let mut centre = [0.0; 3];
                for &c in face.iter() {
                    let p = corner_point(c);
                    for k in 0..3 {
                        centre[k] += p[k] / 4.0;
                    }
                }
                (0..4)
                    .filter(|&k| above(face[(k + 1) % 4]))
                    .map(|k| {
                        let corner = face[(k + 1) % 4];
                        (
                            edge_between(face[k], corner),
                            edge_between(corner, face[(k + 2) % 4]),
                            subtract(centre, corner_point(corner)),
                        )
                    })
                    .collect()
            }
            _ => unreachable!("sign changes around a face come in pairs"),
        };

        for (a, b, outward) in segments {
            // A surface patch reaching into the cube from this segment has
            // normal `n = t x w`, where `t` is the direction it is walked and
            // `w` points into the cube. With `w = -face_normal` and `n` required
            // to be `outward`, that inverts to `t = outward x face_normal`.
            let direction = cross(outward, face_normal);
            let along = subtract(edge_midpoint(b, edges), edge_midpoint(a, edges));
            let (from, to) = if dot(along, direction) > 0.0 { (a, b) } else { (b, a) };
            debug_assert_eq!(next[from], usize::MAX, "case {mask}: edge {from} forks");
            next[from] = to;
        }
    }

    // Follow the successors into closed loops.
    let mut visited = [false; 12];
    let mut loops: Vec<Vec<u8>> = Vec::new();
    for start in 0..12 {
        if visited[start] || next[start] == usize::MAX {
            continue;
        }
        let mut cycle = Vec::new();
        let mut current = start;
        while !visited[current] {
            visited[current] = true;
            cycle.push(current as u8);
            current = next[current];
        }
        debug_assert_eq!(current, start, "case {mask}: the segments do not close");
        loops.push(cycle);
    }
    loops
}

/// Corner `v` of a cube, in units of the cell.
fn corner_point(v: usize) -> [f64; 3] {
    let o = corner_offset(v);
    [o[0] as f64, o[1] as f64, o[2] as f64]
}

/// Where the crossing on edge `e` sits when it is taken to be the midpoint.
/// Good enough to decide which way round a segment goes, which is all the case
/// table needs: moving a crossing along its own edge cannot reverse it.
fn edge_midpoint(e: usize, edges: &[(usize, usize)]) -> [f64; 3] {
    let (v, axis) = edges[e];
    let mut p = corner_point(v);
    p[axis] += 0.5;
    p
}

fn subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Which side of the level the surface wraps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// The region where the field is above the level, which is the only side a
    /// density has.
    Above,
    /// The region where it is below the level: the negative half of a signed
    /// field such as the deformation density.
    Below,
}

/// Triangulates the surface of the region where `grid` is above `iso`.
pub fn extract(grid: &DensityGrid, iso: f64) -> Mesh {
    extract_side(grid, iso, Side::Above)
}

/// Triangulates the surface of the region `side` of `iso`.
///
/// The normals point out of that region, whichever it is. An empty mesh is a
/// normal answer, not a failure: it just means every sample is on one side.
pub fn extract_side(grid: &DensityGrid, iso: f64, side: Side) -> Mesh {
    let table = table();
    let spec = grid.spec;
    let [nx, ny, nz] = spec.dims;
    let mut mesh = Mesh::default();
    if nx < 2 || ny < 2 || nz < 2 {
        return mesh;
    }

    // Vertices are shared between the cubes that meet on an edge, so each cut
    // edge is built once and looked up afterwards. A cut edge is named by the
    // sample it starts from and the axis it runs along.
    let mut vertex_of = vec![u32::MAX; 3 * spec.n_points()];
    let mut loop_vertices: Vec<u32> = Vec::with_capacity(12);

    for iz in 0..nz - 1 {
        for iy in 0..ny - 1 {
            for ix in 0..nx - 1 {
                let mut mask = 0u8;
                for v in 0..8 {
                    let [dx, dy, dz] = corner_offset(v);
                    let value = grid.at(ix + dx, iy + dy, iz + dz);
                    let inside = match side {
                        Side::Above => value > iso,
                        Side::Below => value < iso,
                    };
                    if inside {
                        mask |= 1 << v;
                    }
                }
                if mask == 0 || mask == 255 {
                    continue;
                }
                for contour in &table.loops[mask as usize] {
                    loop_vertices.clear();
                    for &e in contour {
                        let (low_corner, axis) = table.edges[e as usize];
                        let [dx, dy, dz] = corner_offset(low_corner);
                        let base = [ix + dx, iy + dy, iz + dz];
                        loop_vertices.push(vertex_on_edge(
                            grid,
                            iso,
                            side,
                            base,
                            axis,
                            &mut vertex_of,
                            &mut mesh,
                        ));
                    }
                    // Fan from the first vertex. The loop is the section of one
                    // cube, so it is close enough to planar for a fan.
                    for k in 1..loop_vertices.len() - 1 {
                        mesh.indices.extend_from_slice(&[
                            loop_vertices[0],
                            loop_vertices[k],
                            loop_vertices[k + 1],
                        ]);
                    }
                }
            }
        }
    }

    mesh
}

/// Index of the vertex where the level crosses the edge leaving `base` along
/// `axis`, creating it on first use.
fn vertex_on_edge(
    grid: &DensityGrid,
    iso: f64,
    side: Side,
    base: [usize; 3],
    axis: usize,
    vertex_of: &mut [u32],
    mesh: &mut Mesh,
) -> u32 {
    let spec = grid.spec;
    let key = 3 * spec.index(base[0], base[1], base[2]) + axis;
    if vertex_of[key] != u32::MAX {
        return vertex_of[key];
    }

    let mut far = base;
    far[axis] += 1;
    let low = grid.at(base[0], base[1], base[2]);
    let high = grid.at(far[0], far[1], far[2]);
    // The edge is only ever visited when the level falls between its ends, so
    // the denominator cannot vanish; the clamp is for rounding only.
    let t = ((iso - low) / (high - low)).clamp(0.0, 1.0);

    let mut position = spec.point(base[0], base[1], base[2]);
    position[axis] += t * spec.spacing;

    let g0 = grid.gradient(base[0], base[1], base[2]);
    let g1 = grid.gradient(far[0], far[1], far[2]);
    // Out of the region being wrapped: down the gradient when that region is the
    // high side, up it when it is the low side.
    let outward = match side {
        Side::Above => -1.0,
        Side::Below => 1.0,
    };
    let mut normal = [0.0f64; 3];
    for k in 0..3 {
        normal[k] = outward * (g0[k] + t * (g1[k] - g0[k]));
    }
    let length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
    if length > 0.0 {
        for component in &mut normal {
            *component /= length;
        }
    } else {
        // A flat spot: any unit vector will do, and this one is at least along
        // the edge the crossing sits on.
        normal[axis] = outward;
    }

    let index = mesh.n_vertices() as u32;
    mesh.positions.extend(position.iter().map(|&x| x as f32));
    mesh.normals.extend(normal.iter().map(|&x| x as f32));
    vertex_of[key] = index;
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::density::GridSpec;
    use approx::assert_relative_eq;

    /// A field sampled on a lattice, for tests that need a known level set.
    fn sampled(
        dims: [usize; 3],
        spacing: f64,
        origin: [f64; 3],
        f: impl Fn([f64; 3]) -> f64,
    ) -> DensityGrid {
        let spec = GridSpec { origin, spacing, dims };
        let values = (0..spec.n_points()).map(|i| f(spec.point_at(i))).collect();
        DensityGrid { spec, values }
    }

    /// `radius - |r - centre|`, whose zero level set is a sphere of `radius`.
    /// Almost linear along a cube edge, so the interpolated vertices sit on the
    /// sphere and the test measures the triangulation rather than the sampling.
    fn ball(radius: f64, centre: [f64; 3]) -> impl Fn([f64; 3]) -> f64 {
        move |p| {
            let d = ((p[0] - centre[0]).powi(2)
                + (p[1] - centre[1]).powi(2)
                + (p[2] - centre[2]).powi(2))
            .sqrt();
            radius - d
        }
    }

    /// A sphere of `radius` cut from a lattice of `samples` points per axis,
    /// spanning one and a half radii of empty space around it.
    fn sphere_mesh(radius: f64, samples: usize) -> Mesh {
        let spacing = 3.0 * radius / (samples - 1) as f64;
        let half = 0.5 * (samples - 1) as f64 * spacing;
        let grid = sampled([samples; 3], spacing, [-half; 3], ball(radius, [0.0; 3]));
        extract(&grid, 0.0)
    }

    /// Newell's normal of a loop taken through its edge midpoints, positive on
    /// the side the loop is walked counter-clockwise from.
    fn loop_normal(cycle: &[u8], edges: &[(usize, usize)]) -> [f64; 3] {
        let mut normal = [0.0; 3];
        for k in 0..cycle.len() {
            let a = edge_midpoint(cycle[k] as usize, edges);
            let b = edge_midpoint(cycle[(k + 1) % cycle.len()] as usize, edges);
            for axis in 0..3 {
                let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
                normal[axis] += (a[u] - b[u]) * (a[v] + b[v]);
            }
        }
        normal
    }

    fn triangle(mesh: &Mesh, t: usize) -> [[f64; 3]; 3] {
        [
            mesh.vertex(mesh.indices[3 * t] as usize),
            mesh.vertex(mesh.indices[3 * t + 1] as usize),
            mesh.vertex(mesh.indices[3 * t + 2] as usize),
        ]
    }

    fn surface_area(mesh: &Mesh) -> f64 {
        (0..mesh.n_triangles())
            .map(|t| {
                let p = triangle(mesh, t);
                let n = cross(subtract(p[1], p[0]), subtract(p[2], p[0]));
                0.5 * dot(n, n).sqrt()
            })
            .sum()
    }

    /// Volume enclosed by a closed, outward-wound mesh, by the divergence
    /// theorem: `V = 1/6 sum p0 . (p1 x p2)`, which needs no knowledge of the
    /// shape and so is an independent check on both winding and closure.
    fn enclosed_volume(mesh: &Mesh) -> f64 {
        (0..mesh.n_triangles())
            .map(|t| {
                let p = triangle(mesh, t);
                dot(p[0], cross(p[1], p[2])) / 6.0
            })
            .sum()
    }

    /// Asserts that the mesh is a closed surface whose triangles all agree on
    /// which side is out: every directed edge is cancelled by the same edge
    /// walked the other way.
    ///
    /// Counting each undirected edge instead would be wrong here. A contour loop
    /// is emitted as a fan, and the diagonals of that fan are interior to the
    /// loop; two loops that share a pair of non-consecutive vertices can each
    /// draw the same diagonal, which leaves it in four triangles without
    /// leaving a hole anywhere. The balance below is blind to that and still
    /// catches every gap and every flipped triangle.
    fn assert_closed_and_oriented(mesh: &Mesh, what: &str) {
        let mut balance: HashMap<(u32, u32), i32> = HashMap::new();
        for t in 0..mesh.n_triangles() {
            let v = [mesh.indices[3 * t], mesh.indices[3 * t + 1], mesh.indices[3 * t + 2]];
            for k in 0..3 {
                let (a, b) = (v[k], v[(k + 1) % 3]);
                assert_ne!(a, b, "{what}: triangle {t} has a repeated corner");
                *balance.entry((a.min(b), a.max(b))).or_insert(0) += if a < b { 1 } else { -1 };
            }
        }
        let unmatched = balance.values().filter(|&&n| n != 0).count();
        assert_eq!(unmatched, 0, "{what}: {unmatched} edges are not walked both ways");
    }

    #[test]
    fn every_case_closes_into_loops_over_exactly_the_cut_edges() {
        let table = table();
        for mask in 0..256usize {
            let above = |v: usize| mask & (1 << v) != 0;
            let expected: Vec<usize> = (0..12)
                .filter(|&e| {
                    let (v, axis) = table.edges[e];
                    above(v) != above(v | 1 << axis)
                })
                .collect();

            let mut used: Vec<usize> =
                table.loops[mask].iter().flatten().map(|&e| e as usize).collect();
            used.sort_unstable();
            let before = used.len();
            used.dedup();
            assert_eq!(before, used.len(), "case {mask} uses an edge twice");
            assert_eq!(used, expected, "case {mask} does not cover exactly its cut edges");

            for contour in &table.loops[mask] {
                assert!(contour.len() >= 3, "case {mask} has a loop of under three edges");
                // Independent check on the winding: along a cut edge the field
                // falls from the corner above the level to the one below, so the
                // outward normal leans along that edge's axis, towards the
                // corner above. Summed over the loop's edges - individual terms
                // can vanish when the loop is far from flat - that has to agree
                // with the loop's own normal.
                let normal = loop_normal(contour, &table.edges);
                let agreement: f64 = contour
                    .iter()
                    .map(|&e| {
                        let (low, axis) = table.edges[e as usize];
                        if above(low) { normal[axis] } else { -normal[axis] }
                    })
                    .sum();
                assert!(agreement > 1e-9, "case {mask}: loop {contour:?} winds inwards");
            }
        }
        assert!(table.loops[0].is_empty(), "nothing is above the level");
        assert!(table.loops[255].is_empty(), "everything is above the level");
    }

    #[test]
    fn the_isolated_corner_case_is_one_triangle_facing_away_from_it() {
        let table = table();
        // Only corner 0, at the origin of the cube, is above the level: the
        // contour is the triangle across its three edges and its normal points
        // into the (+, +, +) octant.
        let contour = &table.loops[1];
        assert_eq!(contour.len(), 1);
        assert_eq!(contour[0].len(), 3);

        let n = loop_normal(&contour[0], &table.edges);
        for axis in 0..3 {
            assert!(n[axis] > 0.0, "the triangle winds the wrong way about axis {axis}");
        }

        // And the mirror configuration, where that corner is the only one below
        // the level, faces the other way.
        let m = loop_normal(&table.loops[254][0], &table.edges);
        for axis in 0..3 {
            assert!(m[axis] < 0.0, "the mirrored triangle should face the other way on {axis}");
        }
    }

    #[test]
    fn a_level_outside_the_sampled_range_gives_no_mesh() {
        let grid = sampled([12; 3], 0.5, [-3.0; 3], ball(1.0, [0.0; 3]));
        for level in [100.0, -100.0] {
            let mesh = extract(&grid, level);
            assert!(mesh.is_empty());
            assert_eq!(mesh.n_vertices(), 0);
        }
    }

    #[test]
    fn a_sphere_has_the_right_area_and_volume() {
        let radius = 2.0;
        let mesh = sphere_mesh(radius, 61);
        assert!(mesh.n_triangles() > 1000, "only {} triangles", mesh.n_triangles());

        let expected_volume = 4.0 / 3.0 * std::f64::consts::PI * radius.powi(3);
        let expected_area = 4.0 * std::f64::consts::PI * radius * radius;
        // A polyhedron with its vertices on the sphere falls short of both, by
        // an amount that goes as the square of the facet size.
        assert_relative_eq!(enclosed_volume(&mesh), expected_volume, max_relative = 2e-3);
        assert_relative_eq!(surface_area(&mesh), expected_area, max_relative = 5e-3);
    }

    #[test]
    fn refining_the_lattice_converges_on_the_sphere() {
        let radius: f64 = 2.0;
        let exact = 4.0 / 3.0 * std::f64::consts::PI * radius.powi(3);
        let coarse = (enclosed_volume(&sphere_mesh(radius, 21)) - exact).abs();
        let fine = (enclosed_volume(&sphere_mesh(radius, 81)) - exact).abs();
        assert!(fine < coarse / 4.0, "coarse {coarse:e} did not improve to {fine:e}");
    }

    #[test]
    fn the_sphere_mesh_is_closed_and_consistently_wound() {
        let mesh = sphere_mesh(2.0, 41);
        assert_closed_and_oriented(&mesh, "sphere");
        // The vector areas of a closed surface cancel, which the divergence
        // theorem needs and which no single triangle can fake.
        let mut total = [0.0; 3];
        for t in 0..mesh.n_triangles() {
            let p = triangle(&mesh, t);
            let a = cross(subtract(p[1], p[0]), subtract(p[2], p[0]));
            for k in 0..3 {
                total[k] += a[k];
            }
        }
        for k in 0..3 {
            assert!(total[k].abs() < 1e-6, "vector area does not cancel: {total:?}");
        }

        // Normals point away from the dense interior and are unit length.
        for i in 0..mesh.n_vertices() {
            assert!(dot(mesh.normal(i), mesh.vertex(i)) > 0.0, "normal {i} points inwards");
            assert_relative_eq!(dot(mesh.normal(i), mesh.normal(i)), 1.0, epsilon = 1e-6);
        }
    }

    #[test]
    fn two_separate_blobs_produce_two_closed_shells() {
        // Density-like field: two Gaussians far enough apart that the level set
        // is a pair of disconnected spheres.
        let blob = |p: [f64; 3]| {
            let g = |c: [f64; 3]| {
                (-((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2))).exp()
            };
            g([-3.0, 0.0, 0.0]) + g([3.0, 0.0, 0.0])
        };
        let grid = sampled([81, 41, 41], 0.15, [-6.0, -3.0, -3.0], blob);
        let mesh = extract(&grid, 0.2);
        assert!(!mesh.is_empty());
        assert_closed_and_oriented(&mesh, "two blobs");

        // exp(-r^2) = 0.2 at r = sqrt(ln 5), twice over.
        let radius: f64 = 5.0f64.ln().sqrt();
        let expected = 2.0 * 4.0 / 3.0 * std::f64::consts::PI * radius.powi(3);
        assert_relative_eq!(enclosed_volume(&mesh), expected, max_relative = 1e-2);
    }

    #[test]
    fn the_low_side_of_a_level_is_the_same_surface_turned_inside_out() {
        // A well in an otherwise flat field: wrapping the low side must give the
        // same shell as wrapping the high side of the negated field, with the
        // normals pointing into the well rather than out of it.
        let well = |p: [f64; 3]| -(-(p[0] * p[0] + p[1] * p[1] + p[2] * p[2])).exp();
        let grid = sampled([41; 3], 0.15, [-3.0; 3], well);
        let mesh = extract_side(&grid, -0.2, Side::Below);
        assert!(!mesh.is_empty());
        assert_closed_and_oriented(&mesh, "well");

        // exp(-r^2) = 0.2 at r = sqrt(ln 5), and the surface wraps the well.
        let radius: f64 = 5.0f64.ln().sqrt();
        let expected = 4.0 / 3.0 * std::f64::consts::PI * radius.powi(3);
        assert_relative_eq!(enclosed_volume(&mesh), expected, max_relative = 1e-2);

        // Normals point away from the well's interior, which is the low region.
        for i in 0..mesh.n_vertices() {
            assert!(dot(mesh.normal(i), mesh.vertex(i)) > 0.0, "normal {i} points inwards");
        }

        // The same surface from the other direction, vertex for vertex.
        let negated = DensityGrid {
            spec: grid.spec,
            values: grid.values.iter().map(|v| -v).collect(),
        };
        let mirrored = extract_side(&negated, 0.2, Side::Above);
        assert_eq!(mirrored.n_vertices(), mesh.n_vertices());
        assert_eq!(mirrored.n_triangles(), mesh.n_triangles());
        assert_eq!(mirrored.positions, mesh.positions);
        assert_eq!(mirrored.normals, mesh.normals);
    }

    #[test]
    fn a_noisy_field_still_gives_a_closed_surface() {
        // The hard case for the table: neighbouring samples land on opposite
        // sides of the level all over the lattice, so the ambiguous face
        // configurations all come up. A bit-mixing hash of the sample index
        // stands in for random numbers and keeps the test deterministic.
        let spec = GridSpec { origin: [0.0; 3], spacing: 1.0, dims: [14, 13, 12] };
        let values = (0..spec.n_points())
            .map(|i| {
                let [nx, ny, nz] = spec.dims;
                let (ix, iy, iz) = (i % nx, (i / nx) % ny, i / (nx * ny));
                // Zero on the faces of the box, so the level set stays inside it
                // and the surface really should come out closed. A contour that
                // runs off the side of the lattice has a boundary by rights.
                if ix == 0 || iy == 0 || iz == 0 || ix == nx - 1 || iy == ny - 1 || iz == nz - 1 {
                    return 0.0;
                }
                let mut x = i as u64 ^ 0x9e37_79b9_7f4a_7c15;
                x ^= x >> 33;
                x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
                x ^= x >> 33;
                (x % 1_000) as f64 / 1_000.0
            })
            .collect();
        let grid = DensityGrid { spec, values };

        for level in [0.1, 0.5, 0.9] {
            let mesh = extract(&grid, level);
            assert!(!mesh.is_empty(), "level {level} produced nothing");
            assert_closed_and_oriented(&mesh, &format!("noise at {level}"));
        }
    }

    #[test]
    fn vertices_are_shared_between_the_cubes_that_meet_on_an_edge() {
        // A plane cutting the lattice: every cube along it contributes a quad,
        // and without sharing there would be four times as many vertices.
        let grid = sampled([20; 3], 0.5, [0.0; 3], |p| p[2]);
        let mesh = extract(&grid, 2.4);
        // One vertex per cut edge, and the cut edges are the vertical ones
        // through every sample of the plane.
        assert_eq!(mesh.n_vertices(), 20 * 20);
        assert_eq!(mesh.n_triangles(), 2 * 19 * 19);
        assert!(mesh.positions.chunks(3).all(|p| (p[2] as f64 - 2.4).abs() < 1e-6));
        // Every normal points straight up the z axis, away from the high side.
        for i in 0..mesh.n_vertices() {
            assert_relative_eq!(mesh.normal(i)[2], -1.0, epsilon = 1e-6);
        }
    }
}
