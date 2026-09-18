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
import { findBonds } from './bonds';
import type { ElementInfo } from '../worker/protocol';

export interface SceneAtom {
  z: number;
  /** Position in Angstrom. */
  pos: [number, number, number];
}

/** Spheres are drawn well inside their van der Waals radius so bonds stay visible. */
const SPHERE_SCALE = 0.32;
const BOND_RADIUS = 0.09;
/** Pointer travel below this many pixels counts as a click, not a drag. */
const CLICK_SLOP_PX = 4;

export type PlaceHandler = (position: [number, number, number]) => void;
export type MoveHandler = (index: number, position: [number, number, number]) => void;
export type SelectHandler = (index: number | null) => void;

export class MoleculeViewer {
  #renderer: THREE.WebGLRenderer;
  #scene = new THREE.Scene();
  #camera: THREE.PerspectiveCamera;
  #controls: OrbitControls;
  #atomGroup = new THREE.Group();
  #bondGroup = new THREE.Group();
  #highlight: THREE.Mesh;
  #elements = new Map<number, ElementInfo>();
  #atoms: SceneAtom[] = [];
  #activeZ = 6;
  #selected: number | null = null;
  #frame = 0;
  #observer: ResizeObserver;
  #container: HTMLElement;

  // Allocated once, shared by every atom and bond.
  #sphereGeometry = new THREE.SphereGeometry(1, 32, 24);
  #cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
  #atomMaterials = new Map<number, THREE.MeshStandardMaterial>();
  #bondMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.5 });

  // Pointer gesture state.
  #raycaster = new THREE.Raycaster();
  #pointerStart: { x: number; y: number } | null = null;
  #downIndex: number | null = null;
  #dragIndex: number | null = null;
  #dragPlane = new THREE.Plane();

  /** Called when the user clicks empty space with a placement element active. */
  onPlace: PlaceHandler | null = null;
  /** Called continuously while an atom is dragged. */
  onMove: MoveHandler | null = null;
  /** Called when the selection changes. */
  onSelect: SelectHandler | null = null;

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

    this.#scene.add(this.#atomGroup, this.#bondGroup, this.#highlight);

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
      this.#renderer.render(this.#scene, this.#camera);
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

  setSelected(index: number | null) {
    this.#selected = index;
    this.#updateHighlight();
  }

  /** Replaces the rendered molecule. Cheap enough to call every frame. */
  setMolecule(atoms: SceneAtom[]) {
    this.#atoms = atoms;
    this.#syncAtomMeshes();
    this.#syncBondMeshes();
    this.#updateHighlight();
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
    this.#highlight.scale.setScalar(this.#atomRadius(atom.z) * 1.45);
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
    const hit = this.#pick(event);
    this.#downIndex = hit?.index ?? null;

    if (hit && !event.shiftKey) {
      // Dragging an atom must not also orbit the camera.
      this.#controls.enabled = false;
      this.#dragIndex = hit.index;
      this.#renderer.domElement.setPointerCapture(event.pointerId);
    }
  };

  #handlePointerMove = (event: PointerEvent) => {
    if (this.#dragIndex === null || !this.#pointerStart) return;
    if (!this.#movedBeyondSlop(event)) return;
    const atom = this.#atoms[this.#dragIndex];
    if (!atom) return;
    const point = this.#planePoint(event, new THREE.Vector3(...atom.pos));
    if (point) this.onMove?.(this.#dragIndex, [point.x, point.y, point.z]);
  };

  #handlePointerUp = (event: PointerEvent) => {
    const wasClick = this.#pointerStart !== null && !this.#movedBeyondSlop(event);
    const downIndex = this.#downIndex;

    if (this.#dragIndex !== null) {
      this.#renderer.domElement.releasePointerCapture?.(event.pointerId);
    }
    this.#dragIndex = null;
    this.#downIndex = null;
    this.#pointerStart = null;
    this.#controls.enabled = true;

    if (!wasClick) return;

    if (downIndex !== null && event.shiftKey) {
      this.#attachTo(downIndex, event);
    } else if (downIndex !== null) {
      this.onSelect?.(downIndex);
    } else {
      const point = this.#planePoint(event, this.#centroid());
      if (point) this.onPlace?.([point.x, point.y, point.z]);
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

  #resize() {
    const { clientWidth, clientHeight } = this.#container;
    if (clientWidth === 0 || clientHeight === 0) return;
    // Let Three.js write the canvas CSS size too: with setPixelRatio active the
    // backing store is larger than the layout box, and skipping the style would
    // lay the canvas out at device-pixel size (twice as wide on a Retina
    // display), overflowing the viewport and covering the side panel.
    this.#renderer.setSize(clientWidth, clientHeight);
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
    this.#sphereGeometry.dispose();
    this.#cylinderGeometry.dispose();
    for (const material of this.#atomMaterials.values()) material.dispose();
    this.#bondMaterial.dispose();
    (this.#highlight.material as THREE.Material).dispose();
    this.#controls.dispose();
    this.#renderer.dispose();
    dom.remove();
  }
}
