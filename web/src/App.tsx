import { useCallback, useEffect, useRef, useState } from 'react';
import { MoleculeViewer, type SceneAtom } from './scene/viewer';
import { probeWebGl, type WebGlProbe } from './scene/webgl';
import { DftWorkerClient } from './worker/workerClient';
import { PRESETS, toWorkerArrays } from './molecules/presets';
import { PeriodicPicker } from './components/PeriodicPicker';
import { ISO_RANGES, IsoLevelSlider } from './components/IsoLevelSlider';
import { divergenceFrames } from './animation/divergence';
import { FramePlayer } from './animation/framePlayer';
import type {
  DensityChannel,
  DensityRequest,
  ElementInfo,
  IsoMesh,
  ScfOutcome,
} from './worker/protocol';
import './App.css';

/**
 * Phase 4: build a molecule by hand, run a real Kohn-Sham calculation on it,
 * and look at the electron density that comes out.
 *
 * The calculation is started explicitly rather than on every edit: benzene takes
 * seconds, so running it while the user drags an atom would be worse than
 * useless. From phase 5 the geometry optimisation takes over and drives itself.
 *
 * The density surface is a second, much cheaper round trip over the same
 * converged calculation, which is what lets the threshold slider stay live.
 *
 * Two things can be drawn from that density: every electron, or just the ones
 * that made the bonds. Which surface the second one turns out to be is the
 * engine's decision - it depends on whether the molecule has a pi system - so
 * the UI asks for "bonding" and reads back what it got.
 *
 * Nothing here knows what a spin state is. The engine tries the ones that could
 * be the ground state and keeps the best (requirement F4), and an arrangement of
 * nuclei it cannot solve at any of them comes back as an ordinary answer with
 * `converged: false`. That is not an error and is never written as one: the
 * molecule flies apart on screen and reassembles, which says what happened
 * without a word of chemistry (requirement F5).
 */
export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MoleculeViewer | null>(null);
  const clientRef = useRef<DftWorkerClient | null>(null);

  const [atoms, setAtoms] = useState<SceneAtom[]>(PRESETS[0].atoms);
  const [presetId, setPresetId] = useState<string | null>(PRESETS[0].id);
  const [elements, setElements] = useState<ElementInfo[]>([]);
  const [activeZ, setActiveZ] = useState(6);
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<ScfOutcome | null>(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webgl, setWebgl] = useState<WebGlProbe | null>(null);
  const [showDensity, setShowDensity] = useState(true);
  const [channel, setChannel] = useState<DensityRequest>('total');
  // A level per channel, so switching back and forth keeps each where it was.
  const [levels, setLevels] = useState<Record<DensityRequest, number>>({
    total: ISO_RANGES.total.initial,
    bonding: ISO_RANGES.bonding.initial,
  });
  const [mesh, setMesh] = useState<IsoMesh | null>(null);
  const [meshing, setMeshing] = useState(false);
  const [diverging, setDiverging] = useState(false);
  const isoLevel = levels[channel];

  // Plays the frames of a failed calculation, and from phase 5 the steps of a
  // geometry optimisation. It drives the viewer directly rather than through
  // React state: the positions change every display frame, which is not
  // something to re-render for.
  const playerRef = useRef<FramePlayer | null>(null);

  // Identifies the calculation whose result is still wanted. Cancelling or
  // editing bumps it, so a reply that arrives afterwards is ignored instead of
  // overwriting the state of a newer request.
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);

  // Whether the worker is still holding a converged calculation to cut surfaces
  // from. A ref rather than state: the isosurface pump reads it from inside a
  // running loop, where a stale render's copy would be wrong.
  const hasDensityRef = useRef(false);
  // Isosurface requests are coalesced. The worker is single-threaded, so
  // queueing every level a slider drag passes through would leave the surface
  // running seconds behind the pointer; instead one request is in flight and
  // the newest level waits its turn, replacing any older one that was waiting.
  const wantedRef = useRef<{ channel: DensityRequest; level: number } | null>(null);
  const meshInFlightRef = useRef(false);
  const meshRequestRef = useRef(0);

  const cancelCalculation = useCallback(() => {
    // Replacing the worker is not free, so only do it when something is actually
    // running - every edit comes through here.
    if (!inFlightRef.current) return;
    // A single-threaded WASM calculation cannot be interrupted from outside, so
    // the client terminates the worker and spawns a fresh one.
    inFlightRef.current = false;
    requestRef.current += 1;
    // The worker being replaced takes the converged calculation with it.
    hasDensityRef.current = false;
    clientRef.current?.cancelAll();
    setComputing(false);
  }, []);

  /**
   * Ends the divergence animation wherever it is. The molecule on screen is put
   * back by the effect that watches `diverging`, so this does not have to know
   * what the current geometry is.
   */
  const stopDivergence = useCallback(() => {
    playerRef.current?.stop();
    setDiverging(false);
  }, []);

  /**
   * Every edit invalidates the last result and abandons a calculation that is
   * still running for the old geometry. Called from the edit handlers rather
   * than from an effect on `atoms`, so the molecule and the readout change in
   * the same render.
   */
  const invalidateResult = useCallback(() => {
    setResult(null);
    setError(null);
    stopDivergence();
    // The worker's copy of the density belongs to the old geometry, so the
    // surface on screen is stale whether or not the worker survives.
    hasDensityRef.current = false;
    wantedRef.current = null;
    meshRequestRef.current += 1;
    setMesh(null);
    cancelCalculation();
  }, [cancelCalculation, stopDivergence]);

  // --- edit operations -----------------------------------------------------

  const placeAtom = useCallback(
    (pos: [number, number, number]) => {
      setAtoms((prev) => [...prev, { z: activeZ, pos }]);
      setPresetId(null);
      setSelected(null);
      invalidateResult();
    },
    [activeZ, invalidateResult],
  );

  const moveAtom = useCallback(
    (index: number, pos: [number, number, number]) => {
      setAtoms((prev) => prev.map((atom, i) => (i === index ? { ...atom, pos } : atom)));
      setPresetId(null);
      invalidateResult();
    },
    [invalidateResult],
  );

  const deleteSelected = useCallback(() => {
    setSelected((index) => {
      if (index === null) return null;
      setAtoms((prev) => prev.filter((_, i) => i !== index));
      setPresetId(null);
      return null;
    });
    invalidateResult();
  }, [invalidateResult]);

  const clearAll = useCallback(() => {
    setAtoms([]);
    setPresetId(null);
    setSelected(null);
    invalidateResult();
  }, [invalidateResult]);

  // The viewer is created once, so it calls through a ref that always holds the
  // current handlers rather than the ones captured at mount.
  const handlers = useRef({ placeAtom, moveAtom, setSelected });
  handlers.current = { placeAtom, moveAtom, setSelected };

  // --- viewer and worker lifetime -----------------------------------------

  useEffect(() => {
    if (!containerRef.current) return;

    // A missing WebGL context must not take the whole app down: the engine and
    // the readouts still work, only the 3D view is unavailable.
    const probe = probeWebGl();
    setWebgl(probe);
    let viewer: MoleculeViewer | null = null;
    if (probe.ok) {
      try {
        viewer = new MoleculeViewer(containerRef.current);
        viewer.onPlace = (pos) => handlers.current.placeAtom(pos);
        viewer.onMove = (i, pos) => handlers.current.moveAtom(i, pos);
        viewer.onSelect = (i) => handlers.current.setSelected(i);
      } catch (e) {
        setWebgl({ ...probe, ok: false, disabled: true });
        console.error('WebGL renderer could not be created', e);
      }
    }
    const client = new DftWorkerClient();
    const player = new FramePlayer({
      // Roughly eight display frames per keyframe at 60 Hz: fast enough to feel
      // like one motion, slow enough that the interpolation has something to do.
      frameMs: 55,
      onFrame: (positions) => viewer?.setPositions(positions),
      // The last frame is the molecule as the user built it, so there is
      // nothing to put back; the effect below takes over from here.
      onIdle: () => setDiverging(false),
    });
    viewerRef.current = viewer;
    clientRef.current = client;
    playerRef.current = player;

    // Only load the element table here; drawing is left to the effects below so
    // the molecule on screen is always the current one.
    let stale = false;
    client
      .elements()
      .then((list) => {
        if (stale) return;
        viewer?.setElements(list);
        setElements(list);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });

    return () => {
      stale = true;
      setElements([]);
      player.stop();
      viewer?.dispose();
      client.dispose();
      viewerRef.current = null;
      clientRef.current = null;
      playerRef.current = null;
    };
  }, []);

  // --- viewer synchronisation ---------------------------------------------

  const elementsReady = elements.length > 0;

  // While the animation is running it owns the positions; when it ends - because
  // it finished, or because the user edited the molecule out from under it - the
  // structure as built comes straight back.
  useEffect(() => {
    if (elementsReady && !diverging) viewerRef.current?.setMolecule(atoms);
  }, [atoms, elementsReady, diverging]);

  useEffect(() => {
    viewerRef.current?.setActiveElement(activeZ);
  }, [activeZ]);

  useEffect(() => {
    viewerRef.current?.setSelected(selected);
  }, [selected]);

  // Refit the camera only when a whole molecule is swapped in, never while the
  // user is dragging an atom.
  useEffect(() => {
    if (presetId && elementsReady) viewerRef.current?.frameAll();
  }, [presetId, elementsReady]);

  useEffect(() => {
    viewerRef.current?.setIsosurface(showDensity ? mesh : null);
  }, [mesh, showDensity]);

  // --- engine --------------------------------------------------------------

  /**
   * Draws whatever level is wanted, then whatever level became wanted while
   * that was happening, until there is nothing left to catch up on.
   */
  const pumpIsosurface = useCallback(async () => {
    const client = clientRef.current;
    if (!client || meshInFlightRef.current) return;
    if (wantedRef.current === null || !hasDensityRef.current) return;

    meshInFlightRef.current = true;
    setMeshing(true);
    try {
      while (wantedRef.current !== null && hasDensityRef.current) {
        const wanted = wantedRef.current;
        wantedRef.current = null;
        const token = ++meshRequestRef.current;
        try {
          const next = await client.isosurface(wanted.channel, wanted.level);
          if (meshRequestRef.current === token) setMesh(next);
        } catch {
          // The worker was replaced, or there is no calculation to cut. Neither
          // is something to put in front of the user: the surface just goes.
          if (meshRequestRef.current === token) setMesh(null);
        }
      }
    } finally {
      meshInFlightRef.current = false;
      setMeshing(false);
    }
  }, []);

  const requestIsosurface = useCallback(
    (wanted: DensityRequest, level: number) => {
      wantedRef.current = { channel: wanted, level };
      void pumpIsosurface();
    },
    [pumpIsosurface],
  );

  // A new threshold, a different channel, or switching the surface back on all
  // ask for a fresh mesh. A finished calculation does the same from its own
  // handler, where the density first becomes available.
  useEffect(() => {
    if (showDensity && hasDensityRef.current) requestIsosurface(channel, isoLevel);
  }, [channel, isoLevel, showDensity, requestIsosurface]);

  /**
   * Switching channel drops the surface on screen rather than leaving it up
   * while the new density is sampled: the two are drawn in different colours and
   * mean different things, so the stale one would be read as the new one.
   */
  const selectChannel = useCallback((next: DensityRequest) => {
    setChannel((current) => {
      if (current !== next) {
        meshRequestRef.current += 1;
        setMesh(null);
      }
      return next;
    });
  }, []);

  /**
   * Shows a calculation that would not converge as the molecule coming apart.
   *
   * There is no message and no density: the engine found no bound arrangement of
   * electrons for these nuclei, so there is nothing true to draw, and the
   * animation is the whole of the answer (requirement F5).
   */
  const showDivergence = useCallback((current: SceneAtom[]) => {
    const player = playerRef.current;
    if (!player || current.length === 0) return;
    setDiverging(true);
    player.push(...divergenceFrames(toWorkerArrays(current).xyz));
  }, []);

  const calculate = useCallback(() => {
    const client = clientRef.current;
    if (!client || atoms.length === 0) return;
    const { z, xyz } = toWorkerArrays(atoms);
    const token = ++requestRef.current;
    inFlightRef.current = true;
    stopDivergence();
    setComputing(true);
    // Drop the previous answer immediately: leaving it on screen next to
    // "計算中…" reads as though it belonged to the run in progress.
    setResult(null);
    setError(null);
    client
      .scf(z, xyz)
      .then((outcome) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        setResult(outcome);
        if (!outcome.converged) {
          showDivergence(atoms);
          return;
        }
        // The worker is now holding a density; show it without making the user
        // ask, so placing atoms and seeing the cloud is one action.
        hasDensityRef.current = true;
        if (showDensity) requestIsosurface(channel, isoLevel);
      })
      .catch((e: Error) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        setError(describeEngineError(e.message));
      });
  }, [
    atoms,
    showDensity,
    channel,
    isoLevel,
    requestIsosurface,
    showDivergence,
    stopDivergence,
  ]);

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selected !== null) {
          event.preventDefault();
          deleteSelected();
        }
      } else if (event.key === 'Escape') {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, deleteSelected]);

  // Narrowed once, so every readout below agrees on what counts as an answer.
  const converged = result !== null && result.converged;
  const selectedAtom = selected === null ? null : atoms[selected];
  const selectedSymbol = selectedAtom
    ? (elements.find((e) => e.z === selectedAtom.z)?.symbol ?? `Z=${selectedAtom.z}`)
    : null;

  return (
    <div className="app">
      <div className="viewport" ref={containerRef}>
        {webgl && !webgl.ok && (
          <div className="webgl-error">
            <p>
              このブラウザでは WebGL を初期化できないため、3D 表示は利用できません。
              計算エンジンは動作しています。
            </p>
            <p className="hint">
              {webgl.disabled
                ? 'GPU アクセラレーションが無効な環境です。Safari や Firefox で http://localhost:5173 を開くと表示されます。'
                : 'このブラウザは WebGL に対応していません。'}
            </p>
          </div>
        )}
      </div>

      <aside className="panel">
        <h1>分子シミュレータ</h1>
        <p className="phase">Phase 4 — 自動スピン・電荷決定</p>

        <h2>配置する元素</h2>
        <PeriodicPicker elements={elements} value={activeZ} onChange={setActiveZ} />

        <p className="hint">
          何もない場所をクリックで配置 · 原子をドラッグで移動 · 原子を Shift+クリックで
          結合距離に隣接配置 · 背景をドラッグで回転
        </p>

        <h2>編集</h2>
        <div className="row">
          <button type="button" onClick={deleteSelected} disabled={selected === null}>
            削除{selectedSymbol ? `（${selectedSymbol}）` : ''}
          </button>
          <button type="button" onClick={clearAll} disabled={atoms.length === 0}>
            全消去
          </button>
          <button
            type="button"
            onClick={() => viewerRef.current?.frameAll()}
            disabled={atoms.length === 0}
          >
            全体表示
          </button>
        </div>

        <h2>プリセット</h2>
        <div className="row">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={preset.id === presetId ? 'active' : ''}
              onClick={() => {
                setPresetId(preset.id);
                setAtoms(preset.atoms);
                setSelected(null);
                invalidateResult();
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <h2>計算</h2>
        <div className="row">
          <button
            type="button"
            className={computing ? '' : 'active'}
            onClick={computing ? cancelCalculation : calculate}
            disabled={atoms.length === 0}
          >
            {computing ? '中止' : '計算する'}
          </button>
        </div>

        <h2>電子密度</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showDensity}
            onChange={(event) => setShowDensity(event.target.checked)}
          />
          電子の雲を表示する
        </label>
        <div className="row">
          <button
            type="button"
            className={channel === 'total' ? 'active' : ''}
            disabled={!showDensity}
            onClick={() => selectChannel('total')}
          >
            すべての電子
          </button>
          <button
            type="button"
            className={channel === 'bonding' ? 'active' : ''}
            disabled={!showDensity}
            onClick={() => selectChannel('bonding')}
          >
            結合に寄与する電子
          </button>
        </div>
        <IsoLevelSlider
          value={isoLevel}
          range={ISO_RANGES[channel]}
          onChange={(level) => setLevels((prev) => ({ ...prev, [channel]: level }))}
          disabled={!showDensity || !converged}
        />
        <p className="hint">{explainChannel(channel, mesh)}</p>

        <dl>
          <dt>原子数</dt>
          <dd>{atoms.length}</dd>
          <dt>状態</dt>
          <dd>
            {error ? (
              <span className="error">{error}</span>
            ) : computing ? (
              '計算中…'
            ) : converged ? (
              '完了'
            ) : (
              // A calculation that did not converge is deliberately blank rather
              // than described: the molecule flying apart on screen is what says
              // it (requirement F5), and a line of text here would be the error
              // message that requirement rules out.
              '—'
            )}
          </dd>
          <dt>全エネルギー</dt>
          {/* Only a converged energy is a number about the molecule; the last
              iterate of a diverging one is a number about the iteration. */}
          <dd>{converged ? `${result.energy.toFixed(6)} Ha` : '—'}</dd>
          <dt>反復</dt>
          <dd>{converged ? `${result.iterations} 回` : '—'}</dd>
          <dt>計算時間</dt>
          <dd>{result ? `${(result.elapsedMs / 1000).toFixed(2)} 秒` : '—'}</dd>
          <dt>等値面</dt>
          <dd>{describeMesh(result, mesh, meshing)}</dd>
          <dt>WebGL</dt>
          <dd>
            {webgl === null
              ? '確認中…'
              : webgl.ok
                ? `${webgl.context} · ${webgl.renderer ?? 'renderer 不明'}`
                : webgl.disabled
                  ? '利用不可（GPU 無効）'
                  : '非対応'}
          </dd>
        </dl>
      </aside>
    </div>
  );
}

/**
 * What the isosurface readout says, in the states it can be in.
 *
 * An empty mesh is one of them: a threshold above the densest point of the
 * molecule has no surface to draw, which is an answer rather than a failure.
 */
function describeMesh(
  result: ScfOutcome | null,
  mesh: IsoMesh | null,
  meshing: boolean,
): string {
  if (result === null || !result.converged) return '—';
  if (meshing && mesh === null) return '生成中…';
  if (mesh === null) return '—';
  const faces = [mesh.positive, mesh.negative]
    .filter((surface) => surface.indices.length > 0)
    .map((surface) => (surface.indices.length / 3).toLocaleString());
  if (faces.length === 0) return 'しきい値が高すぎます';
  return `${faces.join(' + ')} 面 · ${Math.round(mesh.elapsedMs)} ms`;
}

/**
 * The line under the slider, which has to explain what is on screen without
 * naming a single orbital or functional (requirement F4).
 *
 * The bonding channel needs two explanations because the engine answers it two
 * different ways, so the text follows what came back rather than what was asked
 * for, and says nothing specific until the first surface arrives.
 */
function explainChannel(request: DensityRequest, mesh: IsoMesh | null): string {
  const shown: DensityChannel | null = mesh?.channel ?? null;
  if (request === 'total') {
    return 'しきい値を下げると分子全体を包む形に、上げると原子核や結合のまわりに残ります。';
  }
  if (shown === 'pi') {
    return '平らな分子なので、面から上下にはみ出している電子だけを表示しています。二重結合や環がある分子で、結合がどこに広がっているかが見えます。';
  }
  if (shown === 'deformation') {
    return '原子がばらばらだったときと比べて、電子が濃くなった場所（青）と薄くなった場所（赤）です。青が結合のできたところにあたります。';
  }
  return '原子が結びついたことで動いた電子だけを表示します。';
}

/**
 * Turns an engine-side geometry rejection into something readable.
 *
 * Only geometries the engine refuses to accept reach here. A calculation that
 * runs but does not converge is not an error and never comes through this path.
 */
function describeEngineError(message: string): string {
  if (message.includes('CoincidentAtoms')) return '原子が重なっています';
  if (message.includes('UnsupportedElement')) return '対応していない元素です';
  if (message.includes('NoElectrons')) return '電子がありません';
  return message;
}
