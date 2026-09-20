# ブラウザ分子シミュレータ

ブラウザ上で本物の DFT（Rust → WebAssembly）を回し、化学を知らない人が原子を置くだけで
(1) 安定な形へ緩和するアニメーションと (2) 電子密度の等値面を見られるアプリ。
**v1（P0〜P7）完了・Vercel にデプロイ済み（2026-09-19）。**

- 要件定義書: https://claude.ai/code/artifact/35efc875-a8df-49bc-946b-9e18abba1614
  （Claude Docs。docs コネクタの `read` で読む。web fetch では読めない）
- 設計計画: `~/.claude/plans/tidy-munching-sedgewick.md`
- **経緯・実測・却下した案: [docs/dev-notes.md](docs/dev-notes.md)**。自動では読み込まれない。
  触る領域の節だけ読むこと。下の規約の「なぜ」と数字はすべてそこにある。
- **v2 の計画と進捗: [docs/plan-v2.md](docs/plan-v2.md)**（講義向け: P8 観測モード → P9 記録 →
  P10 並列探索）。v2 の作業はこのファイルの「進捗」の最初の未完了タスクから始める。

## スコープ（v1 で固定）

非周期系（分子）のみ、H–Ar の全電子計算、H₂O〜ベンゼン規模。基底は **STO-3G 固定**
（6-31G* は差し替え候補。積分・勾配・π 判定は d 関数でもそのまま動く）。汎関数は
**LDA（Slater + VWN5）**（PBE は後から足せる構造）。対象外: 周期系・重元素・TD-DFT・反応経路。
性能目標「ベンゼンの SCF + 構造最適化が数秒〜十数秒」→ 現状ブラウザで約 15 秒。
STO-3G が幾何に与えるずれの実測は dev-notes「基底と汎関数が構造に与える差」。

## コマンド

```bash
npm run dev          # Vite 開発サーバ (5173)。launch.json: mol-dev / mol-preview (4173, web/dist)
npm run build        # tsc -b && vite build → web/dist
npm test             # vitest (web)。engine.test.ts はコミット済みの .wasm を実際に呼ぶ
npm run build:wasm   # scripts/build-wasm.sh → web/src/wasm/（コミットする）
cargo test           # dft-core / dft-wasm
cargo run --release --example profile -- benzene --optimize   # ネイティブの内訳
```

- **時間の比較は Node で取る**（`wasm-pack build crates/dft-wasm --release --target nodejs --out-dir <scratch>`
  を小さなスクリプトから呼ぶ）。Browser ペインは非表示だとワーカーが間引かれ 1.2〜2.6 倍遅い。
  このマシン（i5-5287U、2 コア）は同じバイナリでも ±30% ぶれるので、複数回の最小値で判断する。
- **WASM の高速化は WASM のプロファイルで決める**（`--profiling` ビルド + `node --cpu-prof`。手順は
  dev-notes「コマンドの詳細」）。内訳はネイティブとまるで違う。
- 参照値の再生成は基底・汎関数を変えるときだけ: `.venv/bin/python scripts/gen_reference.py`
  （PySCF。全体は十数分かかるので、要る関数だけを直接呼ぶ。放置すると孤児プロセスが残る）。

## 構成

```
crates/dft-core/   純 Rust のエンジン（wasm 非依存、cargo test で全部検証できる）
  basis/ integrals/（MD 法、deriv.rs = 全積分の中心微分）grid/（Becke + Lebedev）xc/（LDA、
  blocks.rs = スクリーニングと基底値キャッシュ、kernels.rs = 小さな行列積）scf/（RKS/UKS、DIIS、
  SAD、linalg.rs = Jacobi）gradient/（Pulay 含む。finite_difference.rs は検証ハーネス）
  opt/（BFGS + trust radius）driver.rs（電荷・スピンの自動探索）density.rs（表示用の ρ 格子）
  bonding.rs（π 判定・差密度）marching.rs（marching cubes）tests/data/（参照値 JSON、生成物）
crates/dft-wasm/   wasm-bindgen ラッパー。単位変換とシリアライズだけ（物理を書かない）
scripts/           gen_reference.py（生成物をすべて作る唯一の場所）、build-wasm.sh
web/src/worker/    protocol.ts（Worker の契約）dft.worker.ts workerClient.ts engineSupport.ts
web/src/animation/ framePlayer.ts（キュー + 再生クロック）divergence.ts（発散演出）
web/src/scene/     viewer.ts（Three.js、命令的）  web/src/components/  progress.ts ほか
web/src/wasm/      build:wasm の生成物（コミットする）
```

## 守るべき規約

### エンジン
- **単位**: エンジンは原子単位（Bohr, Hartree）、UI は Å。変換は `dft-wasm` の境界だけ。
- **`dft-core` に wasm 依存も時計も入れない。** 予算・進捗はクロージャで受ける
  （`driver` の `keep_going`、`opt::relax` の `on_step` / `on_stage`）。
- **参照値・物理定数を記憶から書かない。** テスト内で独立な経路から導出するか、`gen_reference.py`
  の生成物にする（STO-3G・Lebedev・`tests/data/` も生成物で手編集しない）。例外は `xc/lda.rs` の
  VWN5 定数（libxc と照合済み）。合わないときは先にどちらが正しいかを確かめる。
- **勾配は HF 項 + Pulay 項**（`W` = エネルギー重み付き密度行列）で、SCF 収束時にしか成り立たない。
  書き換えたら `integrals/deriv.rs` の項ごとの有限差分と並進不変性を先に見る（4 中心とも明示的に微分）。
- **XC のグリッド重み微分は省略**している＝解析勾配は「グリッド固定のエネルギー」の厳密な微分。
  検証は `System::build_with_grid` で。最適化は Fine（`opt::OPTIMIZER_GRID`）、一点は Medium。
- **`nalgebra` の `SymmetricEigen` は使わない**（固有値と固有ベクトルの対応が黙って壊れる）。
  `scf/linalg.rs` の Jacobi。検査は `A V = V Λ` と `V L Vᵀ = A` の両方。
- **スピン探索は一重項と三重項を両方解いて比べる**（HOMO-LUMO ギャップでの振り分けは不可。
  三重項を一重項の密度から始める・level shift はどちらも遅い）。探索は Medium、勝った状態だけ
  Fine で解き直す（`driver::solve_then_refine`）。
- **性能の前提を崩さない**: ERI 微分は密度を先に Hermite 係数へ畳み込む（`DensityPair`。素朴版と
  1e-12 で照合）/ シェルは群で回す（`BasisSet::groups()`）/ グリッド点は再帰二分割で 128 点ブロック
  に並べる（並びを崩すと答えは同じまま遅くなる）/ スクリーニングは**証明できる上界**でだけ落とす
  （`xc::blocks::SCREENING` 1e-14、ERI 原始対 1e-22。微分と非微分で同じ原始対を残す）/
  `BasisOnGrid` は SCF 1 回ごとに作って捨てる（`System` に持たせない）/ XC の行列積は
  `kernels.rs`（matrixmultiply は WASM で遅い）。
- **π/σ 判定は鏡映の対称性**（`Cᵀ S U C` の対角）で経験則ではない。3 原子は必ず平面なので
  `MIN_ATOMS_FOR_A_PLANE = 4`。
- **marching cubes の表を書き写さない**（`marching.rs` が定義から導出）。閉曲面性は「無向辺が
  2 枚」ではなく「有向辺が往復で打ち消し合う」で検査する。

### 画面に出すもの（要件 F4 / F5）
- **DFT パラメータを出さない**: 基底・電荷・多重度・試した状態・試行回数。`ScfOutcome` の
  `multiplicity` / `charge` / `attempts` は診断用（dev ビルドの `console.debug` だけ）。進捗の段階名も
  「何に時間を使っているか」だけ（`preparing` / `searching` / `forces` / `solving`）。
- **非収束は例外ではなく戻り値。「解けなかった」と「間に合わなかった」を区別する**:
  SCF 非収束（`converged: false`、`ScfFailed`）→ 発散アニメーションだけ、数値・等値面は全部 `—`。
  時間切れ・回数上限（`interrupted` / `maxSteps`）→ そこまでの構造を残し、数値・等値面を出し、
  理由を表示する。判定は `protocol.ts` の `hasUsableStructure()` だけ。UI の `solved`（数値を出して
  よい）と `settled`（「完了」と言ってよい）は別物。
- 「結合に寄与する電子」はエンジンが選ぶ（平面分子なら π、それ以外は差密度。差密度は符号付きで
  2 面）。UI は返ってきた `channel` で説明文と色を変える。

### Worker と UI
- **Worker の契約は `protocol.ts` が唯一の情報源。** 失敗は `error` レスポンスで返し、例外を越境
  させない。終端かどうかは `isTerminal()`（`step` と `progress` は非終端で `onPartial` に流れる）。
- 進捗の段階名は `dft-wasm` の `mod stage` と `progressFromEngine()` の 2 箇所にある。ずれても落ちず
  カードが止まるだけなので、`engine.test.ts` がコミット済みの `.wasm` で照合している。
- **キャンセルは `worker.terminate()` + 再生成。** 保持中の `Calculation`（密度）も消えるので、
  等値面は SCF からやり直し（`hasDensityRef`）。等値面の要求は App で合流させる（`wantedRef`）。
- **起動時に SIMD を判定**し、非対応なら Worker を作らず案内（`engineSupport.ts`）。Worker の
  初期化失敗も `unavailable` → `EngineUnavailableError`。下限は Chrome/Edge 96・Firefox 114・Safari 16.4。
- **編集 / 観測モード。** ポインタとキーの解釈は `scene/gestures.ts` だけ（観測モードは構造を
  変える動作を返さない。テストで固定）。計算の開始時に観測モードへ、発散・エラー・中止で終わったら
  開始前のモードへ戻す（計算中にユーザーが選んだモードは戻さない）。計測は原子の並びが変わる操作で消し、
  ドラッグ・緩和では残す。
- **計測値は viewer が描いている位置から出す**（補間フレームは React に届かない）。パネルは
  `LiveMeasurement` を購読する。ラベルは `CSS2DRenderer` の層（`pointer-events: none`、z-index は
  進捗カードより下）。
- **アニメーションはキーフレーム列 + `FramePlayer`。** 発散演出も最適化の step も同じキューを
  通り、表示レートと生成レートを分ける。時計とスケジューラは注入してブラウザ無しでテストする。
- **アニメーション中は viewer の所有権が `FramePlayer`**（App の `animation`）。キューが空でも
  `producerDoneRef` が立つまで終わりではない。**緩和後の構造は即 `setAtoms`**（背景タブでは rAF が
  走らない）。発散は絵なので `atoms` を触らない。
- Viewer はメッシュとマテリアルを再利用し、等値面の古い geometry は必ず `dispose()`。
  `renderer.setSize(w, h)` の第 3 引数を `false` にしない（Retina で canvas がパネルを覆う）。

### ビルド・CI・デプロイ
- **`web/src/wasm/` はコミットする**（Vercel に Rust が無い）。作るのは `npm run build:wasm` だけ。
  rustflags を `RUSTFLAGS` で渡さない（`.cargo/config.toml` の `+simd128` が黙って消える。`--config` で足す）。
- **Rust を書き戻すときに `mv` や `cp -p` を使わない**（mtime が戻って cargo が再ビルドを飛ばし、古い
  `.wasm` ができる）。怪しいときは定数がバイナリに入っているかを直接見る:
  `python3 -c "import struct,pathlib; w=pathlib.Path('web/src/wasm/dft_wasm_bg.wasm').read_bytes(); print(w.count(struct.pack('<d', 1800000.0)))"`
  （1800 秒 = `OPTIMIZE_BUDGET_SECONDS`）。
- **出荷されるのは CI（Linux）のビルド。** Mac のビルドは機能同一だがデータ領域の並びが違い、
  バイトは一致しない。CI は main でも PR でも作り直し、違えばそのブランチにコミットする
  → **push したら `git pull`**。Rust 1.98.1（`rust-toolchain.toml`）と wasm-pack 0.15.0（CI）は揃えて上げる。
- **Vercel の Root Directory はリポジトリ直下（空）。** 設定は直下の `vercel.json`
  （`web/dist`、`.wasm` の Content-Type、`/assets` のキャッシュ）。正しいビルドログには
  `> mol@0.1.0 build` が出る。Vercel のビルドはログインなしで手元で再現できる（dev-notes）。

## 状態と今後

- P0〜P7 完了、Vercel デプロイ済み。Firefox での手動 E2E の結果は未記録（P8 の確認で一緒に行う）。
- **v2 着手（2026-09-20）。** P8（観測モード）完了（Firefox 確認済み）。**次は P9-1。**
  WebGPU は採らないと決めた（理由は plan-v2.md）。
- 拡張候補（詳細は dev-notes「P6 以降に残したもの」）: XC グリッド重み微分を実装して最適化を
  Medium に戻す（ベンゼン最適化の 1〜2 割）、マルチスレッド化（COOP/COEP + rayon、nightly 依存）、
  `OPTIMIZE_BUDGET_SECONDS`（1800 秒）の見直し。
- **STO-3G の幾何は教科書と数度ずれる**（水 96.7° / 実験 104.5°）。エンジンの誤りではなく最小基底の
  ためで、6-31G* にすればほぼ合う。**v2 では差し替えない**（2026-09-20 ユーザー判断、v3 の筆頭候補）。
  実測は dev-notes「基底と汎関数が構造に与える差」、タスク案は plan-v2.md「基底の差し替え」。
- **記録の置き場所**: 作業の経緯・実測・却下した案は `docs/dev-notes.md` の「フェーズの記録」に
  足し、この CLAUDE.md には守るべき規約と状態だけを 1〜2 行で足す（毎回読み込まれるため）。

## 開発環境の制約

- **Claude の作業ブラウザは WebGL が使えない**（GPU 無効の Chromium）。3D の見た目はユーザーに
  Firefox で確認を依頼する。パネル・Worker 経由の計算結果は Browser ツールで検証できる。
- HMR（Fast Refresh）ではマウント時の effect が再実行されない。別条件で App を再マウントして
  確かめる方法は dev-notes「P7 の実装メモ」。
