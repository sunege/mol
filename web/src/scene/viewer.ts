/**
 * Three.js scene for the molecule, plus the pointer interactions that build it.
 *
 * Kept imperative and outside React on purpose: the geometry is rewritten on
 * every pointer move while dragging, and later on every animation frame while
 * an optimisation streams in, so a reconciler buys nothing here.
 *
 * Meshes and geometries are reused across updates. Only `Mesh` objects are
 * created or dropped when the atom count changes; the sphere and cylinder
 * geometries are allocated once and scaled per instance.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { findBonds } from './bonds';
import { dashLayout } from './dashes';
import { axisDragPosition, axisParameter, handleLength, type Vec3 } from './axisDrag';
import { clickAction, pressAction, type Axis, type HandleHit, type ViewerMode } from './gestures';
import {
  distance,
  formatMeasurement,
  formatValue,
  measureAtoms,
  measurementAnchor,
  type Measurement,
} from './measure';
import type { CameraAxes } from '../components/orient';
import type { ElementInfo, IsoMesh, SurfaceGeometry } from '../worker/protocol';

export interface SceneAtom {
  z: number;
  /** Position in Angstrom. */
  pos: [number, number, number];
}

/** Spheres are drawn well inside their van der Waals radius so bonds stay visible. */
const SPHERE_SCALE = 0.32;
const BOND_RADIUS = 0.09;
/**
 * The isosurface is drawn around the atoms, so it has to be see-through enough
 * for them to stay visible through it.
 */
const ISOSURFACE_OPACITY = 0.42;
/**
 * Colours of the two halves of a signed surface, of which there are two kinds.
 * For the deformation density, blue is where forming the molecule gathered
 * electrons and red where it took them away. For one orbital they are the two
 * signs of its amplitude, and say nothing about how many electrons are
 * anywhere. An ordinary density only ever uses the first.
 */
const POSITIVE_COLOR = 0x5fa8ff;
const NEGATIVE_COLOR = 0xff6b6b;
/** Pointer travel below this many pixels counts as a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Halo around the atom selected for editing, relative to the atom's sphere. */
const SELECTED_HALO = 1.45;
/**
 * The colour of everything that belongs to a measurement: the halos on the
 * picked atoms, the dashes between them and the label. Chosen apart from the
 * editing selection (blue) and from both density surfaces (blue and red).
 */
const MEASURE_COLOR = 0xffb84d;

/** The axis handles' colours: X red, Y green, Z blue, as in most 3D editors. */
const AXIS_COLORS: Record<Axis, number> = { x: 0xe5534b, y: 0x57ab5a, z: 0x539bf5 };
const AXIS_VECTORS: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/**
 * The handles' proportions, as fractions of their length on screen
 * (`handleLength`). Each arrow starts a little way out from the atom's centre,
 * so the middle of the selected atom can still be grabbed to drag it freely.
 */
const HANDLE_START = 0.25;
const HANDLE_SHAFT_RADIUS = 0.025;
const HANDLE_TIP_LENGTH = 0.22;
const HANDLE_TIP_RADIUS = 0.07;
/** The invisible, fatter cylinder the pointer is tested against: a few pixels are hard to hit. */
const HANDLE_HIT_RADIUS = 0.09;
/** Over the atoms, bonds, surfaces and measurement dashes. */
const HANDLE_RENDER_ORDER = 10;
/**
 * A thin rim around a measured atom rather than a ball around it: anything
 * bigger crowds the density surface the atoms sit inside. Different from
 * {@link SELECTED_HALO} so that an atom which is both selected and measured
 * shows both rings instead of two halos fighting over one surface.
 */
const MEASURED_HALO = 1.2;
/**
 * The dashes joining measured atoms are short cylinders, thinner than a bond.
 * Lines drawn by WebGL are a single device pixel wide, too thin to read on a
 * projector, and a fat dash crowds everything around it.
 *
 * Being thinner than a bond, they would disappear inside one - picked atoms are
 * usually bonded - so they are drawn without depth testing, over whatever is in
 * front of them. They do run from centre to centre, across the two atoms: the
 * gap between two bonded atoms' spheres is about a tenth of an Angstrom, far
 * too short for a dashed line to be visible in.
 */
const DASH_RADIUS = BOND_RADIUS * 0.5;
const DASH_LENGTH = 0.12;
const DASH_GAP = 0.08;
/** How far into an angle its label sits, beyond the vertex atom's halo (Angstrom). */
const ANGLE_LABEL_MARGIN = 0.25;

export type PlaceHandler = (position: [number, number, number]) => void;
export type MoveHandler = (index: number, position: [number, number, number]) => void;
export type SelectHandler = (index: number | null) => void;
export type MeasureHandler = (index: number) => void;
export type MeasurementHandler = (measurement: Measurement | null) => void;

/** Shared settings of both density surfaces; only the colour differs. */
function isosurfaceMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.25,
    metalness: 0.0,
    transparent: true,
    opacity: ISOSURFACE_OPACITY,
    // The surface wraps the molecule, so the camera sees its inside as well as
    // its outside; without this the far half would be culled away.
    side: THREE.DoubleSide,
    // Sorting transparent triangles per frame is not worth it here: leaving the
    // depth buffer alone lets the atoms inside show through from any angle.
    depthWrite: false,
  });
}

export class MoleculeViewer {
  #renderer: THREE.WebGLRenderer;
  #scene = new THREE.Scene();
  #camera: THREE.PerspectiveCamera;
  #controls: OrbitControls;
  #atomGroup = new THREE.Group();
  #bondGroup = new THREE.Group();
  #measuredGroup = new THREE.Group();
  #dashGroup = new THREE.Group();
  #bondLabelGroup = new THREE.Group();
  #measureLabel: CSS2DObject;
  #labelRenderer = new CSS2DRenderer();
  #positiveSurface: THREE.Mesh;
  #negativeSurface: THREE.Mesh;
  #highlight: THREE.Mesh;
  /**
   * The selected atom's X / Y / Z arrows, in edit mode only (V6-10). One
   * length on screen: scaled every frame, in `#scaleHandles`.
   */
  #handles = new THREE.Group();
  #elements = new Map<number, ElementInfo>();
  #atoms: SceneAtom[] = [];
  #activeZ = 6;
  #mode: ViewerMode = 'edit';
  #selected: number | null = null;
  #measured: number[] = [];
  #showBondLengths = false;
  /** The bonds drawn now, shared by the cylinders and the bond-length labels. */
  #bonds: Array<[number, number]> = [];
  #frame = 0;
  #observer: ResizeObserver;
  #container: HTMLElement;

  // Allocated once, shared by every atom and bond.
  #sphereGeometry = new THREE.SphereGeometry(1, 32, 24);
  #cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
  #atomMaterials = new Map<number, THREE.MeshStandardMaterial>();
  #bondMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.5 });
  #positiveMaterial = isosurfaceMaterial(POSITIVE_COLOR);
  #negativeMaterial = isosurfaceMaterial(NEGATIVE_COLOR);
  #measuredMaterial = new THREE.MeshBasicMaterial({
    color: MEASURE_COLOR,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  #dashMaterial = new THREE.MeshBasicMaterial({
    color: MEASURE_COLOR,
    // Over the bonds and the density surface, whatever the angle of view.
    depthTest: false,
    depthWrite: false,
  });
  // One arrow along +Y of unit length; each axis turns its own copy.
  #handleShaft = new THREE.CylinderGeometry(
    HANDLE_SHAFT_RADIUS,
    HANDLE_SHAFT_RADIUS,
    1 - HANDLE_START - HANDLE_TIP_LENGTH,
    8,
  ).translate(0, (1 + HANDLE_START - HANDLE_TIP_LENGTH) / 2, 0);
  #handleTip = new THREE.ConeGeometry(HANDLE_TIP_RADIUS, HANDLE_TIP_LENGTH, 12).translate(
    0,
    1 - HANDLE_TIP_LENGTH / 2,
    0,
  );
  #handleHit = new THREE.CylinderGeometry(
    HANDLE_HIT_RADIUS,
    HANDLE_HIT_RADIUS,
    1 - HANDLE_START,
    8,
  ).translate(0, (1 + HANDLE_START) / 2, 0);
  #handleMaterials = new Map<Axis, THREE.MeshBasicMaterial>();
  // Never drawn, but the raycaster still tests it (it only skips a mesh with no material).
  #handleHitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  #viewportHeight = 1;
  #scratch = new THREE.Vector3();
  #forward = new THREE.Vector3();

  // Pointer gesture state.
  #raycaster = new THREE.Raycaster();
  #pointerStart: { x: number; y: number } | null = null;
  #downIndex: number | null = null;
  #dragIndex: number | null = null;
  #dragPlane = new THREE.Plane();
  /** The handle under the pointer when the button went down. */
  #downHandle: HandleHit | null = null;
  /**
   * An atom being moved along one world axis: where it was at the press, and
   * where on that axis's line the press landed (`axisDrag.ts`).
   */
  #axisDrag: { index: number; axis: Vec3; start: Vec3; s0: number } | null = null;
  /** Whether the pointer is over a handle now, for the cursor. */
  #overHandle = false;

  /** Called when the user clicks empty space with a placement element active. */
  onPlace: PlaceHandler | null = null;
  /** Called continuously while an atom is dragged. */
  onMove: MoveHandler | null = null;
  /** Called when the selection changes. */
  onSelect: SelectHandler | null = null;
  /** Called when an atom is clicked in observe mode, to pick or unpick it for measuring. */
  onMeasure: MeasureHandler | null = null;
  /**
   * Called with the measurement of the picked atoms every time the atoms are
   * redrawn, including every frame of an animation, and with `null` when fewer
   * than two are picked.
   */
  onMeasurement: MeasurementHandler | null = null;

  constructor(container: HTMLElement) {
    this.#container = container;
    this.#renderer = new THREE.WebGLRenderer({ antialias: true });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.#renderer.domElement);

    this.#scene.background = new THREE.Color(0x0e1116);

    this.#camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.#camera.position.set(0, 2, 8);

    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = true;

    this.#scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 6, 8);
    this.#scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-6, -3, -4);
    this.#scene.add(fill);

    this.#highlight = new THREE.Mesh(
      this.#sphereGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x3f8cff,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    this.#highlight.visible = false;
    this.#buildHandles();

    this.#positiveSurface = new THREE.Mesh(new THREE.BufferGeometry(), this.#positiveMaterial);
    this.#negativeSurface = new THREE.Mesh(new THREE.BufferGeometry(), this.#negativeMaterial);
    for (const surface of [this.#positiveSurface, this.#negativeSurface]) {
      surface.visible = false;
      // Drawn after the opaque atoms and bonds, which transparency needs.
      surface.renderOrder = 1;
    }

    this.#measureLabel = new CSS2DObject(labelElement('measure-label'));
    this.#measureLabel.visible = false;
    this.#bondLabelGroup.visible = false;

    this.#scene.add(
      this.#atomGroup,
      this.#bondGroup,
      this.#positiveSurface,
      this.#negativeSurface,
      this.#highlight,
      this.#handles,
      this.#measuredGroup,
      this.#dashGroup,
      this.#bondLabelGroup,
      this.#measureLabel,
    );

    // Labels are HTML laid over the canvas, so they stay crisp and readable at
    // any zoom. The layer never takes the pointer: a click on a label goes
    // through to the atom underneath.
    const labels = this.#labelRenderer.domElement;
    labels.className = 'viewer-labels';
    container.appendChild(labels);

    // Capture phase, so an atom hit can switch OrbitControls off before it
    // starts an orbit gesture on the same pointerdown.
    const dom = this.#renderer.domElement;
    dom.addEventListener('pointerdown', this.#handlePointerDown, { capture: true });
    dom.addEventListener('pointermove', this.#handlePointerMove);
    dom.addEventListener('pointerup', this.#handlePointerUp);
    dom.addEventListener('pointercancel', this.#handlePointerUp);

    this.#observer = new ResizeObserver(() => this.#resize());
    this.#observer.observe(container);
    this.#resize();

    const tick = () => {
      this.#frame = requestAnimationFrame(tick);
      this.#controls.update();
      this.#scaleHandles();
      this.#renderer.render(this.#scene, this.#camera);
      this.#labelRenderer.render(this.#scene, this.#camera);
    };
    tick();
  }

  setElements(elements: ElementInfo[]) {
    this.#elements = new Map(elements.map((e) => [e.z, e]));
  }

  /** The element a click on empty space will place. */
  setActiveElement(z: number) {
    this.#activeZ = z;
  }

  /**
   * Switches what pointer gestures do (see `gestures.ts`). A drag under way is
   * dropped, so an atom never carries on following the pointer in a mode where
   * atoms cannot be moved.
   */
  setMode(mode: ViewerMode) {
    this.#mode = mode;
    this.#dragIndex = null;
    this.#axisDrag = null;
    this.#controls.enabled = true;
    this.#updateHandles();
    this.#syncCursor();
  }

  setSelected(index: number | null) {
    this.#selected = index;
    this.#updateHighlight();
    this.#updateHandles();
  }

  /**
   * The atoms to measure between, in the order they were picked: two for a
   * distance, three for the angle at the second, four for the dihedral about
   * the middle two. The value is worked out here, whenever the atoms move, so
   * it follows a drag or an animation without the caller doing anything.
   */
  setMeasured(indices: readonly number[]) {
    this.#measured = indices.slice();
    this.#syncMeasurement();
    this.#syncBondLabels();
  }

  /** Labels every drawn bond with its length. */
  setShowBondLengths(show: boolean) {
    this.#showBondLengths = show;
    this.#bondLabelGroup.visible = show;
    this.#syncBondLabels();
  }

  /**
   * Replaces the rendered molecule. Cheap enough to call every frame.
   *
   * The array is copied because {@link setPositions} replaces entries in it
   * while an animation runs, and the caller's copy is React state.
   */
  setMolecule(atoms: SceneAtom[]) {
    this.#atoms = atoms.slice();
    this.#syncAll();
  }

  /**
   * Moves the atoms already on screen, keeping their elements.
   *
   * This is what an animation drives: a frame is only a set of coordinates, and
   * the elements it belongs to are already here. Bonds are recomputed, so they
   * stretch and break as the atoms separate, which is most of what a molecule
   * coming apart looks like.
   *
   * Coordinates are in Angstrom, three per atom, in the order the atoms were
   * given to {@link setMolecule}. A frame of the wrong length is ignored rather
   * than half-applied: it belongs to a molecule that has since been edited.
   */
  setPositions(positions: ArrayLike<number>) {
    if (positions.length !== this.#atoms.length * 3) return;
    for (let i = 0; i < this.#atoms.length; i++) {
      this.#atoms[i] = {
        z: this.#atoms[i].z,
        pos: [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]],
      };
    }
    this.#syncAll();
  }

  /** Everything drawn from the atom positions. */
  #syncAll() {
    this.#syncAtomMeshes();
    this.#syncBondMeshes();
    this.#updateHighlight();
    this.#updateHandles();
    this.#syncMeasurement();
    this.#syncBondLabels();
  }

  /**
   * Replaces the electron-density surfaces, or clears them with `null`.
   *
   * A signed density fills both: the second one is the region the density falls
   * below the negative of the threshold, drawn in the other colour. An ordinary
   * density leaves it empty.
   */
  setIsosurface(mesh: IsoMesh | null) {
    this.#setSurface(this.#positiveSurface, mesh?.positive ?? null);
    this.#setSurface(this.#negativeSurface, mesh?.negative ?? null);
  }

  /**
   * Swaps one surface's geometry. The mesh and its material are kept, since only
   * the vertex count changes with the threshold, and the old geometry is
   * disposed rather than left to the garbage collector: its buffers live on the
   * GPU, which JavaScript's collector knows nothing about.
   */
  #setSurface(target: THREE.Mesh, surface: SurfaceGeometry | null) {
    const previous = target.geometry;
    if (!surface || surface.indices.length === 0) {
      target.visible = false;
      // Nothing to release when it is already empty, which it is every time the
      // user drags an atom around with the surfaces switched off.
      if (previous.getAttribute('position')) {
        target.geometry = new THREE.BufferGeometry();
        previous.dispose();
      }
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    // Needed for frustum culling; the engine gives no bounding box of its own.
    geometry.computeBoundingSphere();

    target.geometry = geometry;
    target.visible = true;
    previous.dispose();
  }

  #materialFor(z: number): THREE.MeshStandardMaterial {
    let material = this.#atomMaterials.get(z);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: this.#elements.get(z)?.color ?? 0xcccccc,
        roughness: 0.35,
        metalness: 0.05,
      });
      this.#atomMaterials.set(z, material);
    }
    return material;
  }

  #atomRadius(z: number): number {
    return (this.#elements.get(z)?.vdwRadius ?? 1.5) * SPHERE_SCALE;
  }

  #syncAtomMeshes() {
    const group = this.#atomGroup;
    while (group.children.length > this.#atoms.length) group.children.pop();
    while (group.children.length < this.#atoms.length) {
      group.add(new THREE.Mesh(this.#sphereGeometry, this.#bondMaterial));
    }
    this.#atoms.forEach((atom, i) => {
      const mesh = group.children[i] as THREE.Mesh;
      mesh.material = this.#materialFor(atom.z);
      mesh.scale.setScalar(this.#atomRadius(atom.z));
      mesh.position.set(...atom.pos);
      mesh.userData.index = i;
    });
  }

  #syncBondMeshes() {
    const pairs = findBonds(this.#atoms, (z) => this.#covalentRadius(z));
    this.#bonds = pairs;
    const group = this.#bondGroup;
    while (group.children.length > pairs.length) group.children.pop();
    while (group.children.length < pairs.length) {
      group.add(new THREE.Mesh(this.#cylinderGeometry, this.#bondMaterial));
    }

    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    pairs.forEach(([a, b], i) => {
      const mesh = group.children[i] as THREE.Mesh;
      start.set(...this.#atoms[a].pos);
      end.set(...this.#atoms[b].pos);
      direction.subVectors(end, start);
      const length = direction.length();
      mesh.position.copy(start).addScaledVector(direction, 0.5);
      // The unit cylinder runs along +Y; rotate that axis onto the bond vector.
      mesh.quaternion.setFromUnitVectors(up, direction.clone().normalize());
      mesh.scale.set(BOND_RADIUS, length, BOND_RADIUS);
    });
  }

  #covalentRadius(z: number): number {
    return this.#elements.get(z)?.covalentRadius ?? 0.8;
  }

  #updateHighlight() {
    const index = this.#selected;
    if (index === null || index >= this.#atoms.length) {
      this.#highlight.visible = false;
      return;
    }
    const atom = this.#atoms[index];
    this.#highlight.visible = true;
    this.#highlight.position.set(...atom.pos);
    this.#highlight.scale.setScalar(this.#atomRadius(atom.z) * SELECTED_HALO);
  }

  /** Three arrows along +X, +Y and +Z, each tagged with its axis for the raycaster. */
  #buildHandles() {
    for (const axis of ['x', 'y', 'z'] as const) {
      const material = new THREE.MeshBasicMaterial({
        color: AXIS_COLORS[axis],
        // Never hidden inside its own atom, or behind another.
        depthTest: false,
        depthWrite: false,
      });
      this.#handleMaterials.set(axis, material);
      const arrow = new THREE.Group();
      for (const geometry of [this.#handleShaft, this.#handleTip]) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = HANDLE_RENDER_ORDER;
        mesh.userData.axis = axis;
        arrow.add(mesh);
      }
      const hit = new THREE.Mesh(this.#handleHit, this.#handleHitMaterial);
      hit.userData.axis = axis;
      arrow.add(hit);
      // The geometry points along +Y.
      if (axis === 'x') arrow.rotation.z = -Math.PI / 2;
      if (axis === 'z') arrow.rotation.x = Math.PI / 2;
      this.#handles.add(arrow);
    }
    this.#handles.visible = false;
  }

  /** The handles sit on the selected atom, and only while atoms can be edited. */
  #updateHandles() {
    const index = this.#selected;
    const atom = index === null ? undefined : this.#atoms[index];
    const shown = this.#mode === 'edit' && atom !== undefined;
    this.#handles.visible = shown;
    if (atom) this.#handles.position.set(...atom.pos);
    if (!shown) this.#setOverHandle(false);
  }

  /** The same length on screen however far the camera is, every frame. */
  #scaleHandles() {
    if (!this.#handles.visible) return;
    // Depth along the view, which is what the perspective divides by.
    this.#camera.getWorldDirection(this.#forward);
    const depth = this.#scratch
      .copy(this.#handles.position)
      .sub(this.#camera.position)
      .dot(this.#forward);
    if (depth <= 0) return;
    this.#handles.scale.setScalar(handleLength(depth, this.#camera.fov, this.#viewportHeight));
  }

  /** The picked atoms, or none if one of them is gone. */
  #measuredAtoms(): SceneAtom[] {
    const atoms = this.#atoms;
    if (this.#measured.some((i) => i >= atoms.length)) return [];
    return this.#measured.map((i) => atoms[i]);
  }

  /** Halos on the picked atoms, dashes between them in order, and the label. */
  #syncMeasurement() {
    const picked = this.#measuredAtoms();

    const halos = this.#measuredGroup;
    while (halos.children.length > picked.length) halos.children.pop();
    while (halos.children.length < picked.length) {
      halos.add(new THREE.Mesh(this.#sphereGeometry, this.#measuredMaterial));
    }
    picked.forEach((atom, i) => {
      const halo = halos.children[i];
      halo.position.set(...atom.pos);
      halo.scale.setScalar(this.#atomRadius(atom.z) * MEASURED_HALO);
    });

    this.#syncDashes(picked);

    const measurement =
      picked.length >= 2 ? measureAtoms(this.#atoms, this.#measured) : null;
    const anchor = measurement
      ? measurementAnchor(
          picked.map((atom) => atom.pos),
          // Clear of the vertex atom's halo, so the label is not on top of it.
          (picked[1] ? this.#atomRadius(picked[1].z) * MEASURED_HALO : 0) + ANGLE_LABEL_MARGIN,
        )
      : null;
    const label = this.#measureLabel;
    if (measurement && anchor) {
      label.visible = true;
      label.position.set(...anchor);
      setText(label.element, formatMeasurement(measurement));
    } else {
      label.visible = false;
    }
    this.onMeasurement?.(measurement);
  }

  /** Dashed segments from each picked atom to the next. */
  #syncDashes(picked: SceneAtom[]) {
    const segments: Array<{ center: THREE.Vector3; direction: THREE.Vector3; length: number }> =
      [];
    for (let k = 0; k + 1 < picked.length; k++) {
      const start = new THREE.Vector3(...picked[k].pos);
      const direction = new THREE.Vector3(...picked[k + 1].pos).sub(start);
      const span = direction.length();
      if (span < 1e-6) continue;
      direction.divideScalar(span);
      const { length, centers } = dashLayout(span, DASH_LENGTH, DASH_GAP);
      for (const offset of centers) {
        segments.push({
          center: start.clone().addScaledVector(direction, offset),
          direction,
          length,
        });
      }
    }

    const group = this.#dashGroup;
    while (group.children.length > segments.length) group.children.pop();
    while (group.children.length < segments.length) {
      const dash = new THREE.Mesh(this.#cylinderGeometry, this.#dashMaterial);
      // With depth testing off, draw order is all that decides what covers
      // what: after the atoms, the bonds and both density surfaces.
      dash.renderOrder = 2;
      group.add(dash);
    }
    const up = new THREE.Vector3(0, 1, 0);
    segments.forEach(({ center, direction, length }, i) => {
      const dash = group.children[i];
      dash.position.copy(center);
      dash.quaternion.setFromUnitVectors(up, direction);
      dash.scale.set(DASH_RADIUS, length, DASH_RADIUS);
    });
  }

  /**
   * A length on every drawn bond, when switched on. A bond that is also the
   * distance being measured keeps only the measurement's label, which says the
   * same thing and would otherwise sit on top of it.
   */
  #syncBondLabels() {
    const group = this.#bondLabelGroup;
    if (!this.#showBondLengths) return;

    const measuredPair =
      this.#measured.length === 2 && this.#measuredAtoms().length === 2
        ? [Math.min(...this.#measured), Math.max(...this.#measured)]
        : null;
    const bonds = this.#bonds.filter(
      ([a, b]) => !(measuredPair && a === measuredPair[0] && b === measuredPair[1]),
    );

    // Removing a CSS2DObject from its parent is what takes its element out of
    // the page, so the pool shrinks with remove() rather than by truncation.
    while (group.children.length > bonds.length) group.remove(group.children.at(-1)!);
    while (group.children.length < bonds.length) {
      group.add(new CSS2DObject(labelElement('bond-label')));
    }
    bonds.forEach(([a, b], i) => {
      const label = group.children[i] as CSS2DObject;
      const p = this.#atoms[a].pos;
      const q = this.#atoms[b].pos;
      label.position.set((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2);
      setText(label.element, formatValue('distance', distance(p, q)));
    });
  }

  // --- pointer interaction -------------------------------------------------

  /** Normalised device coordinates for a pointer event. */
  #ndc(event: PointerEvent): THREE.Vector2 {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** The atom under the pointer, with the point on its surface that was hit. */
  #pick(event: PointerEvent): { index: number; point: THREE.Vector3 } | null {
    this.#raycaster.setFromCamera(this.#ndc(event), this.#camera);
    const hits = this.#raycaster.intersectObjects(this.#atomGroup.children, false);
    if (hits.length === 0) return null;
    return { index: hits[0].object.userData.index as number, point: hits[0].point };
  }

  /** The axis handle under the pointer, while the handles are shown. */
  #pickHandle(event: PointerEvent): HandleHit | null {
    const index = this.#selected;
    if (!this.#handles.visible || index === null) return null;
    this.#raycaster.setFromCamera(this.#ndc(event), this.#camera);
    const hits = this.#raycaster.intersectObjects(this.#handles.children, true);
    if (hits.length === 0) return null;
    return { axis: hits[0].object.userData.axis as Axis, index };
  }

  /**
   * Where on the line through `point` along `axis` the pointer's ray comes
   * nearest (`axisDrag.ts`), or `null` while the axis points along the view.
   */
  #axisParameter(event: PointerEvent, point: Vec3, axis: Vec3): number | null {
    this.#raycaster.setFromCamera(this.#ndc(event), this.#camera);
    const { origin, direction } = this.#raycaster.ray;
    return axisParameter(origin.toArray(), direction.toArray(), point, axis);
  }

  #setOverHandle(over: boolean) {
    this.#overHandle = over;
    this.#syncCursor();
  }

  /** `grabbing` while a handle is dragged, `grab` over one, else the page's own. */
  #syncCursor() {
    const cursor = this.#axisDrag ? 'grabbing' : this.#overHandle ? 'grab' : '';
    const style = this.#renderer.domElement.style;
    if (style.cursor !== cursor) style.cursor = cursor;
  }

  /** Where the pointer ray crosses a camera-facing plane through `through`. */
  #planePoint(event: PointerEvent, through: THREE.Vector3): THREE.Vector3 | null {
    const normal = this.#camera.getWorldDirection(new THREE.Vector3());
    this.#dragPlane.setFromNormalAndCoplanarPoint(normal, through);
    this.#raycaster.setFromCamera(this.#ndc(event), this.#camera);
    return this.#raycaster.ray.intersectPlane(this.#dragPlane, new THREE.Vector3());
  }

  /** Centre of the molecule, or the origin when it is empty. */
  #centroid(): THREE.Vector3 {
    const centre = new THREE.Vector3();
    if (this.#atoms.length === 0) return centre;
    for (const atom of this.#atoms) centre.add(new THREE.Vector3(...atom.pos));
    return centre.divideScalar(this.#atoms.length);
  }

  #handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.#pointerStart = { x: event.clientX, y: event.clientY };
    // The handles first: they are drawn over their own atom.
    this.#downHandle = this.#pickHandle(event);
    this.#downIndex = this.#pick(event)?.index ?? null;

    const press = pressAction(this.#mode, this.#downIndex, event.shiftKey, this.#downHandle);
    if (press.kind === 'drag') {
      // Dragging an atom must not also orbit the camera.
      this.#controls.enabled = false;
      this.#dragIndex = press.index;
      this.#renderer.domElement.setPointerCapture(event.pointerId);
    } else if (press.kind === 'axisDrag') {
      const atom = this.#atoms[press.index];
      if (!atom) return;
      const axis = AXIS_VECTORS[press.axis];
      const s0 = this.#axisParameter(event, atom.pos, axis);
      // Edge-on: the arrow is a dot, and the view turns instead.
      if (s0 === null) return;
      this.#controls.enabled = false;
      this.#axisDrag = { index: press.index, axis, start: [...atom.pos], s0 };
      this.#renderer.domElement.setPointerCapture(event.pointerId);
      this.#syncCursor();
    }
  };

  #handlePointerMove = (event: PointerEvent) => {
    const drag = this.#axisDrag;
    if (drag) {
      if (!this.#movedBeyondSlop(event)) return;
      const s = this.#axisParameter(event, drag.start, drag.axis);
      // The axis has turned edge-on mid-drag: hold still until it turns back.
      if (s === null) return;
      this.onMove?.(drag.index, axisDragPosition(drag.start, drag.axis, drag.s0, s));
      return;
    }
    // Only hovering (no button down) asks about the handles: one small raycast.
    if (!this.#pointerStart) {
      this.#setOverHandle(event.buttons === 0 && this.#pickHandle(event) !== null);
      return;
    }
    if (this.#dragIndex === null) return;
    if (!this.#movedBeyondSlop(event)) return;
    const atom = this.#atoms[this.#dragIndex];
    if (!atom) return;
    const point = this.#planePoint(event, new THREE.Vector3(...atom.pos));
    if (point) this.onMove?.(this.#dragIndex, [point.x, point.y, point.z]);
  };

  #handlePointerUp = (event: PointerEvent) => {
    const wasClick = this.#pointerStart !== null && !this.#movedBeyondSlop(event);
    const downIndex = this.#downIndex;
    const downHandle = this.#downHandle;

    if (this.#dragIndex !== null || this.#axisDrag !== null) {
      this.#renderer.domElement.releasePointerCapture?.(event.pointerId);
    }
    this.#dragIndex = null;
    this.#axisDrag = null;
    // Back to `grab` if it was over the handle; the next move says otherwise.
    this.#syncCursor();
    this.#downIndex = null;
    this.#downHandle = null;
    this.#pointerStart = null;
    this.#controls.enabled = true;

    if (!wasClick) return;

    const click = clickAction(this.#mode, downIndex, event.shiftKey, downHandle);
    switch (click.kind) {
      case 'attach':
        this.#attachTo(click.index, event);
        break;
      case 'select':
        this.onSelect?.(click.index);
        break;
      case 'place': {
        const point = this.#planePoint(event, this.#centroid());
        if (point) this.onPlace?.([point.x, point.y, point.z]);
        break;
      }
      case 'measure':
        this.onMeasure?.(click.index);
        break;
      case 'none':
        break;
    }
  };

  /** Places a new atom on the clicked face of an existing one, at bond length. */
  #attachTo(index: number, event: PointerEvent) {
    const hit = this.#pick(event);
    if (!hit || hit.index !== index) return;
    const centre = new THREE.Vector3(...this.#atoms[index].pos);
    const outward = hit.point.clone().sub(centre).normalize();
    const distance =
      this.#covalentRadius(this.#atoms[index].z) + this.#covalentRadius(this.#activeZ);
    const position = centre.addScaledVector(outward, distance);
    this.onPlace?.([position.x, position.y, position.z]);
  }

  #movedBeyondSlop(event: PointerEvent): boolean {
    if (!this.#pointerStart) return false;
    return (
      Math.hypot(
        event.clientX - this.#pointerStart.x,
        event.clientY - this.#pointerStart.y,
      ) > CLICK_SLOP_PX
    );
  }

  // --- camera / lifecycle --------------------------------------------------

  /** Frames the camera on the current molecule. */
  frameAll() {
    const box = new THREE.Box3().setFromObject(this.#atomGroup);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const distance = radius / Math.sin((this.#camera.fov * Math.PI) / 360);
    this.#controls.target.copy(sphere.center);
    this.#camera.position
      .copy(sphere.center)
      .add(new THREE.Vector3(0, 0.4, 1).setLength(distance * 1.6));
    this.#controls.update();
  }

  /**
   * The camera's own axes in the world, as they are now: across the screen to
   * the right and up, and the way it looks (V6-8). Read once, when a line of
   * the correlation diagram is pressed, to turn a degenerate orbital to the
   * screen (`components/orient.ts`); nothing follows the camera afterwards.
   */
  cameraAxes(): CameraAxes {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const back = new THREE.Vector3();
    this.#camera.updateMatrixWorld();
    this.#camera.matrixWorld.extractBasis(right, up, back);
    const forward = this.#camera.getWorldDirection(new THREE.Vector3());
    return { right: right.toArray(), up: up.toArray(), forward: forward.toArray() };
  }

  #resize() {
    const { clientWidth, clientHeight } = this.#container;
    if (clientWidth === 0 || clientHeight === 0) return;
    // Let Three.js write the canvas CSS size too: with setPixelRatio active the
    // backing store is larger than the layout box, and skipping the style would
    // lay the canvas out at device-pixel size (twice as wide on a Retina
    // display), overflowing the viewport and covering the side panel.
    this.#renderer.setSize(clientWidth, clientHeight);
    // The labels are placed in CSS pixels, the same units as the layout box.
    this.#labelRenderer.setSize(clientWidth, clientHeight);
    // `handleLength` works in CSS pixels, like the layout box.
    this.#viewportHeight = clientHeight;
    this.#camera.aspect = clientWidth / clientHeight;
    this.#camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.#frame);
    this.#observer.disconnect();

    const dom = this.#renderer.domElement;
    dom.removeEventListener('pointerdown', this.#handlePointerDown, { capture: true });
    dom.removeEventListener('pointermove', this.#handlePointerMove);
    dom.removeEventListener('pointerup', this.#handlePointerUp);
    dom.removeEventListener('pointercancel', this.#handlePointerUp);

    this.#atomGroup.clear();
    this.#bondGroup.clear();
    this.#measuredGroup.clear();
    this.#dashGroup.clear();
    // Detaching the labels removes their elements; the layer itself goes too.
    this.#bondLabelGroup.clear();
    this.#scene.remove(this.#measureLabel);
    this.#labelRenderer.domElement.remove();
    this.#positiveSurface.geometry.dispose();
    this.#negativeSurface.geometry.dispose();
    this.#sphereGeometry.dispose();
    this.#cylinderGeometry.dispose();
    for (const material of this.#atomMaterials.values()) material.dispose();
    this.#bondMaterial.dispose();
    this.#positiveMaterial.dispose();
    this.#negativeMaterial.dispose();
    this.#measuredMaterial.dispose();
    this.#dashMaterial.dispose();
    (this.#highlight.material as THREE.Material).dispose();
    this.#handles.clear();
    this.#handleShaft.dispose();
    this.#handleTip.dispose();
    this.#handleHit.dispose();
    for (const material of this.#handleMaterials.values()) material.dispose();
    this.#handleHitMaterial.dispose();
    this.#controls.dispose();
    this.#renderer.dispose();
    dom.remove();
  }
}

/** An empty label element with the given class, for a CSS2DObject. */
function labelElement(className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  return element;
}

/**
 * Writes a label's text only when it changed: labels are updated on every
 * animation frame, and most frames do not change the digits shown.
 */
function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}
