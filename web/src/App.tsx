import { useCallback, useEffect, useRef, useState } from 'react';
import { MoleculeViewer, type SceneAtom } from './scene/viewer';
import { probeWebGl, type WebGlProbe } from './scene/webgl';
import { DftWorkerClient } from './worker/workerClient';
import { PRESETS, toWorkerArrays } from './molecules/presets';
import { PeriodicPicker } from './components/PeriodicPicker';
import type { ElementInfo, ScfOutcome } from './worker/protocol';
import './App.css';

/**
 * Phase 2: build a molecule by hand, then run a real Kohn-Sham calculation on it.
 *
 * The calculation is started explicitly rather than on every edit: benzene takes
 * seconds, so running it while the user drags an atom would be worse than
 * useless. From phase 5 the geometry optimisation takes over and drives itself.
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

  // Identifies the calculation whose result is still wanted. Cancelling or
  // editing bumps it, so a reply that arrives afterwards is ignored instead of
  // overwriting the state of a newer request.
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);

  const cancelCalculation = useCallback(() => {
    // Replacing the worker is not free, so only do it when something is actually
    // running - every edit comes through here.
    if (!inFlightRef.current) return;
    // A single-threaded WASM calculation cannot be interrupted from outside, so
    // the client terminates the worker and spawns a fresh one.
    inFlightRef.current = false;
    requestRef.current += 1;
    clientRef.current?.cancelAll();
    setComputing(false);
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
    cancelCalculation();
  }, [cancelCalculation]);

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
    viewerRef.current = viewer;
    clientRef.current = client;

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
      viewer?.dispose();
      client.dispose();
      viewerRef.current = null;
      clientRef.current = null;
    };
  }, []);

  // --- viewer synchronisation ---------------------------------------------

  const elementsReady = elements.length > 0;

  useEffect(() => {
    if (elementsReady) viewerRef.current?.setMolecule(atoms);
  }, [atoms, elementsReady]);

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

  // --- engine --------------------------------------------------------------

  const calculate = useCallback(() => {
    const client = clientRef.current;
    if (!client || atoms.length === 0) return;
    const { z, xyz } = toWorkerArrays(atoms);
    const token = ++requestRef.current;
    inFlightRef.current = true;
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
      })
      .catch((e: Error) => {
        if (requestRef.current !== token) return;
        inFlightRef.current = false;
        setComputing(false);
        setError(describeEngineError(e.message));
      });
  }, [atoms]);

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
        <p className="phase">Phase 2 — SCF 一点計算</p>

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

        <dl>
          <dt>原子数</dt>
          <dd>{atoms.length}</dd>
          <dt>状態</dt>
          <dd>
            {error ? (
              <span className="error">{error}</span>
            ) : computing ? (
              '計算中…'
            ) : result === null ? (
              '—'
            ) : result.converged ? (
              '完了'
            ) : (
              // Phase 4 replaces this with the diverging-molecule animation; it
              // is deliberately not phrased as an error.
              '収束しませんでした'
            )}
          </dd>
          <dt>全エネルギー</dt>
          <dd>{result ? `${result.energy.toFixed(6)} Ha` : '—'}</dd>
          <dt>反復</dt>
          <dd>{result ? `${result.iterations} 回` : '—'}</dd>
          <dt>計算時間</dt>
          <dd>{result ? `${(result.elapsedMs / 1000).toFixed(2)} 秒` : '—'}</dd>
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
