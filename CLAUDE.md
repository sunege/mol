# ブラウザ分子シミュレータ

ブラウザ上で本物の DFT を回し、(1) 構造最適化アニメーションと (2) 電子密度等値面を見せるアプリ。
化学の知識がないユーザーが 3D 空間に原子を置くだけで使える。

- **要件定義書**: https://claude.ai/code/artifact/35efc875-a8df-49bc-946b-9e18abba1614
  （Claude Docs。読むときは docs コネクタの `read` を使う。web fetch では読めない）
- **設計計画**: `~/.claude/plans/tidy-munching-sedgewick.md` — フェーズ構成・アーキテクチャ・検証方針の一次情報

## スコープ（v1 で固定）

| 項目 | 値 |
| --- | --- |
| 対象系 | 非周期系（分子）のみ。H₂O・O₂ 程度〜ベンゼン程度 |
| 対象元素 | H–Ar（Z = 1..18）。全電子計算 |
| 基底関数 | **STO-3G 固定**（6-31G* は将来の差し替え候補。データは差し替え可能な形に保つ） |
| 汎関数 | **LDA（Slater 交換 + VWN5 相関）**。PBE は後から足せる構造にする |
| 対象外 | 周期系、重元素・遷移金属、励起状態（TD-DFT）、反応経路探索 |
| 性能目標 | ベンゼンで SCF + 構造最適化が数秒〜十数秒 |

## コマンド

```bash
npm run dev          # Vite 開発サーバ (5173)
npm run build        # tsc -b && vite build → web/dist
npm test             # vitest (web)
npm run build:wasm   # wasm-pack build → web/src/wasm/（生成物はコミットする）
cargo test           # dft-core / dft-wasm
```

参照値・基底データの再生成（PySCF が要る。普段は不要で、基底や汎関数を変えるときだけ）:

```bash
python3 -m venv .venv && .venv/bin/pip install pyscf
.venv/bin/python scripts/gen_reference.py
```

`main()` の全実行は分〜十数分かかる（ベンゼンを grid level 9 で解くため）。
一部だけ要るときは関数を直接呼ぶこと。放置すると孤児プロセスとして残り続ける:

```bash
.venv/bin/python -c "import sys; sys.path.insert(0,'scripts'); import gen_reference as g; g.open_shell_reference()"
```

## 構成

```
crates/dft-core/          純Rust の計算エンジン。wasm 非依存 → cargo test で全部検証できる
  src/basis/              Shell/BasisSet + sto3g_data.rs（生成物）
  src/integrals/          boys.rs, md.rs（McMurchie-Davidson）, onee.rs, eri.rs
  src/grid/               radial.rs, becke.rs, lebedev_data.rs（生成物）
  src/xc/                 lda.rs（Slater + VWN5）+ グリッド上の E_xc / V_xc 組み立て
  src/scf/                mod.rs（RKS/UKS ループ）, diis.rs, guess.rs（SAD）, linalg.rs
  src/driver.rs           電荷とスピン多重度の自動決定（要件 F4）。ラウンド制の探索
  src/density.rs          表示用の直交格子上の ρ(r)（Becke グリッドとは別物）。符号付きも扱う
  src/bonding.rs          「どの電子を描くか」。分子平面の検出、鏡映パリティによる π 判定、差密度
  src/marching.rs         marching cubes。256 ケース表は起動時に導出する（後述）
  tests/data/             PySCF/libxc 由来の参照値 JSON（生成物）。開殻は scf_open_shell.json
crates/dft-wasm/   wasm-bindgen ラッパー。単位変換とシリアライズのみ、物理を書かない
scripts/           gen_reference.py — 上の「生成物」をすべて作る唯一の場所
web/src/worker/    protocol.ts（UI↔Worker の契約）, dft.worker.ts, workerClient.ts
web/src/animation/ framePlayer.ts（キュー + 再生クロック）, divergence.ts（発散演出の生成）
web/src/scene/     viewer.ts（Three.js, 命令的）, bonds.ts, webgl.ts
web/src/components/ PeriodicPicker.tsx, IsoLevelSlider.tsx
web/src/wasm/      npm run build:wasm の生成物。**コミット対象**
```

## 守るべき規約

- **単位**: エンジンは原子単位（Bohr, Hartree）、UI は Å。変換は `crates/dft-wasm` の境界 1 箇所だけ。エンジン内部に Å を持ち込まない。
- **`dft-core` に wasm 依存を入れない。** 全ロジックをホスト上の `cargo test` で検証できる状態を保つ。
- **`web/src/wasm/` はコミットする。** Vercel のビルド環境に Rust ツールチェーンが無いため。CI は PR で生成物の鮮度を検証し、main では自動で再生成してコミットする。
- **π/σ の判定は対称性であって経験則ではない。** 分子平面での鏡映は Kohn-Sham 演算子と
  可換なので、各軌道は厳密にその固有関数になる（ベンゼンで ⟨σ̂⟩ = ±1.000000）。
  判定は基底での反射行列 U を作って `Cᵀ S U C` の対角を見る。U は単項式を展開して
  作っているので任意の角運動量で動く（6-31G* の d 関数でも書き換え不要）。
  **3 原子は必ず平面なので平面性は何も言っていない**。`MIN_ATOMS_FOR_A_PLANE = 4`
  はそのための下限で、水が「π＝面外孤立電子対」として扱われるのを防いでいる。
- **テストの参照値も物理定数テーブルも記憶から書かない。** 一度これで誤った定数を書いてテストが落ちた。次のどちらかにする:
  1. テスト内で独立な経路から導出する（例: 核間反発を「ペア距離を書き下した和」と比較する、Boys 関数を Simpson 積分と照合する）
  2. `scripts/gen_reference.py` で生成して JSON / 生成 .rs としてコミットする
  STO-3G 係数と Lebedev グリッドも同スクリプトの生成物であり、手で編集しない。
  唯一の例外は `xc/lda.rs` の VWN5 フィッティング定数（汎関数の定義そのもの）で、
  これは `tests/reference_xc.rs` が libxc と 1 点ずつ照合して守っている。
- **参照値が合わないとき、先に「どちらが正しいか」を確かめる。** 低密度・完全スピン分極の
  領域では VWN5 の式が桁落ちし、libxc の側が 1e-10 ずれる。50 桁演算で確認済みで、
  `tests/reference_xc.rs` にその許容と理由を書いてある。
- **非収束は例外ではなく戻り値**（要件 F5）。SCF・構造最適化とも最大反復数とタイムアウトを持ち、`failed` を返す。UI はそれを発散アニメーションとして表現し、エラーメッセージを出さない。
  収束しなかったときは**エネルギーも反復数も等値面も出さない**（すべて `—`）。
  最後の反復の密度は「その分子の密度」ではないので描かない。画面で起きることは
  原子が飛び散って戻ってくることだけで、それが答えの全部。
- **DFT パラメータを UI に出さない。** 基底関数・電荷・スピン多重度は自動決定（要件 F4）で、ユーザーには見せない。
  `ScfOutcome` の `multiplicity` / `charge` / `attempts` は**診断用**で、画面に出さない
  （dev ビルドの Worker が `console.debug` に 1 行出すだけ）。P5 が最適化中にスピン状態を
  固定するのにも使う。
- **スピン状態の探索は「両方解いて比べる」しかない。** HOMO-LUMO ギャップで
  三重項を試すかどうかを振り分けたくなるが、**使えない**。実測（`scf::run_*` で直接測定）:
  ベンゼンはギャップ 0.226 Ha で一重項、CH₂ はギャップ 0.160 Ha で**三重項が 0.186 Ha 下**。
  順序はギャップで決まらないし、そもそも一重項が収束しない系ではギャップ自体が無い。
  高速化するなら、三重項を SAD ではなく**収束した一重項の密度から始める**ほう（P6）。
- **Worker の契約は `protocol.ts` が唯一の情報源。** 失敗は例外を越境させず `error` レスポンスで返す。
- **キャンセルは `worker.terminate()` + 再生成**（`workerClient.ts`）。単一スレッド WASM は外から中断できないため。
- **Viewer はメッシュを再利用する。** 毎フレームのジオメトリ生成に戻さない。P5 の最適化アニメーションが同じ経路を毎フレーム叩く。
  等値面だけは頂点数が閾値ごとに変わるので `BufferGeometry` を作り直すが、`Mesh` と
  マテリアルは使い回し、古い geometry は必ず `dispose()` する（GPU バッファは GC されない）。
- **marching cubes の 256 ケース表を書き写さない。** `marching.rs` は定義から導出している
  （面ごとに切断辺を結び、閉ループにし、符号だけから向きを決める）。公開されている表は
  曖昧面の解消方法を固定した「選択」を含んでいて、1 エントリの写し間違いが穴になり、
  エネルギーのテストでは絶対に捕まらない。テストは全 256 ケースの被覆と、球・二球・
  乱数場に対する閉曲面性（有向辺が往復で打ち消し合うこと）と体積・面積で押さえている。
- **等値面メッシュの閉曲面性はループ境界で見る。** ループは扇状に三角形化するので、
  内部対角線は隣のキューブの対角線と一致して 4 枚に共有されることがある。穴ではない。
  「無向辺がちょうど 2 枚」ではなく「有向辺が往復で打ち消し合う」で検査すること。
- **アニメーションはキーフレーム列 + `FramePlayer`。** 発散演出も P5 の最適化ステップも
  `web/src/animation/` の同じ経路を通る。Player は表示レート（rAF）と生成レートを分離し、
  アンカー時刻を 1 フレーム分ずつ進めるので、コールバックが遅れても尺がずれない。
  時計とスケジューラは注入するので、ブラウザ無しでテストできる。
- **`renderer.setSize(w, h)` の第3引数を `false` にしない。** CSS サイズが書かれず、Retina で canvas が 2 倍の大きさになりパネルを覆う（実際に踏んだ）。

## 技術的な補足（要件定義書に対する）

1. **「Hellmann-Feynman 力」だけでは力が求まらない。** 原子核上に中心を持つガウス基底では基底関数自体が原子位置に依存するため、Pulay 項（`-Σ W_μν ∂S_μν/∂R` ほか）を含む完全な解析的勾配が必要。
2. **COOP/COEP によるマルチスレッド化は最終フェーズの任意項目。** `wasm-bindgen-rayon` は nightly + `-Z build-std` 依存。まず単一スレッド + WASM SIMD（stable）で性能目標を狙う。

## フェーズ進捗

| # | 内容 | 状態 |
| --- | --- | --- |
| P0 | 土台（ワークスペース、Worker↔WASM 疎通、CI、Vercel 設定） | 完了 |
| P1 | 原子配置 GUI（周期表ピッカー、配置・移動・削除、結合描画） | 完了 |
| P2 | SCF 一点計算（STO-3G データ、積分、Becke グリッド、LDA、SAD guess、DIIS） | 完了 |
| P3 | 電子密度等値面（ρ(r) グリッド、marching cubes、閾値スライダー、結合に寄与する電子） | 完了 |
| P4 | 自動スピン・電荷決定（UKS、探索の状態機械、level shift）+ 非収束時の発散アニメーション | 完了 |
| **P5** | **解析的勾配 + 構造最適化アニメーション（最大の実装リスク）** | **次はここ** |
| P6 | 性能（SIMD、スクリーニング、必要ならマルチスレッド化） | 未着手 |

各フェーズ終了時点で Vercel にデプロイ可能な状態を保つ。

### P5 への引き継ぎ

- **スピン状態は初期構造で 1 回だけ決める。** `driver::solve` は `System` を作り直さない
  （積分もグリッドも電荷・多重度に依存しないので使い回せる）。最適化ループでは
  **探索を毎ステップ回してはいけない**。設計計画どおり、初期構造で決めた
  `SpinState` を固定して回すこと。`Molecule` の `charge` / `multiplicity` に入っている。
- **勾配は UKS でも要る。** 最適化中に O₂ を扱うなら XC 寄与は α/β 別々。
  `xc::unrestricted` と同じ形でグリッドを回すことになる。
- **Worker のプロトコルは今「1 リクエスト = 1 レスポンス」。** `workerClient.ts` の
  `#send` は最初に id が一致した応答で `#pending` から消して resolve する。
  最適化ステップを逐次流すには**ここを変える必要がある**（Promise ではなく
  コールバック、または async iterator）。`protocol.ts` に `step` を足すだけでは動かない。
- **核間反発の勾配はもうある。** `Molecule::nuclear_repulsion_gradient()` と、その
  有限差分テスト（`molecule.rs`）。P5 の有限差分ハーネスはこのテストと同じ形を
  全項に広げたものになる。設計計画どおり**勾配コードを書く前にハーネスを作る**こと。
- **アニメーションの土台はもうある。** `FramePlayer` はキューを持ち、フレームが
  遅れて届いても表示レートを崩さない（P5 の「計算が遅い/速い」に対応済み）。
  最適化ステップは `player.push(xyz)` を Worker の `step` ごとに呼ぶだけ。
  発散演出（`divergence.ts`）は同じキューに流し込む別の生成器にすぎない。
- **`viewer.setPositions(xyz)` が座標だけの更新経路。** 元素は変えずに動かす。
  結合は毎フレーム引き直すので、離れれば切れる。
- **アニメーション中は viewer の所有権が Player にある。** App は `diverging` を見て
  `setMolecule` を止めている（`useEffect [atoms, elementsReady, diverging]`）。
  P5 で最適化アニメーションを足すときは、同じフラグを一般化すること
  （最適化は「原子の位置が本当に変わる」ので、終わったら `atoms` 側を書き換える点が違う）。

### P3・P4 の実装メモ

- **Worker は `Calculation` ハンドルを保持している。** `dft-wasm::scf()` は
  `Calculation`（`System` + `ScfResult` + チャンネルごとに遅延生成する ρ グリッド）を返し、
  `summary()` がスカラー値、`isosurface(channel, level)` がメッシュを返す。
  `dft.worker.ts` の `current` がそれを持ち、新しい SCF のたびに古いものを `free()` する
  （WASM のメモリは GC されない）。
  P4 で UKS を足したが、等値面側は変わっていない（`ScfResult::density` は α+β の全密度）。
- **`worker.terminate()` は保持中の `Calculation` も道連れにする。** 中止や編集のあと
  等値面を再生成するには SCF からやり直しになる。UI 側は `hasDensityRef` でそれを追跡
  している。発散アニメーション中に等値面を出したいなら、この前提を見直すこと。
- **等値面リクエストは App 側で合流させている**（`wantedRef` + `meshInFlightRef`）。
  Worker は単一スレッドなので、スライダーのイベントを全部キューに積むと数秒遅れる。
- **非収束でも密度は返る**が、**描かないことにした**。`ScfResult` は `converged: false`
  でも形式上は密度を持つけれど、それは「その分子の密度」ではなく「反復が止まらなかった
  最後の 1 枚」なので、飛び散る原子の隣に電子雲を出すと「計算できた」に見えてしまう。
  発散演出だけを出し、数値も等値面も伏せる。
- **表示チャンネルは 2 つある。** UI は `total` か `bonding` を要求し、`bonding` に対して
  **どう答えるかはエンジンが決める**（`bonding::bonding_channel`）。平面分子なら π、
  それ以外は差密度（ρ_分子 − ρ_孤立原子の重ね合わせ）。返ってきた `channel`
  （`total` / `pi` / `deformation`）で UI の説明文と色が変わる。
  π の選択は `ScfResult::channels` を全部なめるので、UKS でも α/β 別々の軌道を見る
  （`DensityChannel::Pi` は `OrbitalRef { channel, index }` の列）。
- **差密度は符号付き。** `density::evaluate` は**負の値をクランプしない**（P3 の最初の版は
  していた）。`marching::extract_side(grid, level, Side)` で正負 2 枚の曲面を切り、
  Worker は 2 組のジオメトリを返す。
- **差密度は原子核の上で鋭く尖る。** CH₄ では炭素核で −2.2 e/Bohr³ に達する（分子と
  孤立原子の 1s カスプの差）。等値面の意味がある範囲はスライダーの下半分で、
  上のほうへ動かすと核まわりの赤い小球だけが残る。これは量の性質であって不具合ではない。

### P4 で分かったこと

- **開殻の参照値は `tests/data/scf_open_shell.json`。** `gen_reference.py` の
  `open_shell_reference()` が UKS（閉殻比較用の 1 件だけ RKS）で生成する。O₂ の三重項と
  一重項、CH₃・OH ラジカル、H/C/N/O/Al/Si 原子。α/β 別の密度行列と軌道エネルギー、
  `<S²>` まで入っているので、ずれたときにどの項が悪いか分かる。
- **PySCF 側も開殻原子は素直に収束しない。** 縮退した p 殻で DIIS が振動するので、
  `unrestricted_payload` は収束しなければ `mf.newton()`（二次収束法）に落とす。
- **`<S²>` は診断として効く。** `ScfResult::spin_squared(&overlap)` が
  `S_z(S_z+1) + n_β − tr(D_α S D_β S)`。三重項のつもりが一重項に落ちていても
  エネルギーはそれらしく見えるが、これは見逃さない。
- **level shift が無いと Al・Si 原子が解けない。** 3s と 3p が近く、占有/非占有が
  反復ごとに入れ替わる。**ダンピングでは直らない**（振動しているのは密度ではなく占有）。
  空軌道を持ち上げれば止まる。入れる前は Al が**カチオンとして**、Si が五重項として
  返ってきていた（どちらも中性基底状態ではない）。`tests/reference_open_shell.rs` の
  `a_level_shift_is_what_the_hard_atoms_need` が「無いと落ちる」ことごと固定している。
- **非収束を作るのは難しい。** 原子を重ねる・詰める程度では探索のどこかで収束する
  （O₂ を 0.4 Å、S 3 個の団子、C 4 個の積み重ね、いずれも収束した）。発散アニメーションを
  手で確認したいときは、Worker で `converged: false` を一時的に強制するのが早い。

### P4 の実測（自動探索のコスト）

閉殻分子は一重項と三重項の両方を解くので、単純に SCF が 2 回走る。
ネイティブ（release、`System::build` + 探索 vs `System::build` + 1 状態）:

| | 1 状態 | 探索 | 倍率 | 三重項の反復数 |
| --- | --- | --- | --- | --- |
| H₂O | 0.41 秒 | 0.53 秒 | ×1.30 | 7 |
| O₂ | 0.15 秒 | 0.28 秒 | ×1.91 | 7（採用） |
| NH₃ | 0.21 秒 | 0.57 秒 | ×2.65 | 10 |
| CH₄ | 0.26 秒 | 1.10 秒 | ×4.21 | **17** |
| ベンゼン | 5.28 秒 | 9.53 秒 | ×1.81 | 11 |

ブラウザ実測ではベンゼンが 16.5 秒 → **24.3 秒**。倍率が分子ごとに違うのは
三重項の収束の速さが違うから（CH₄ の三重項は 17 反復かかる）。
P6 でここを縮めるなら、三重項を**収束した一重項の密度から始める**のが素直
（`ScfOptions` に初期密度を渡す口を足す）。ギャップによる振り分けは上の規約のとおり不可。

### P3 の実測（ブラウザ、release + wasm-opt -O3）

初回の等値面（ρ サンプリング込み）: H₂O 0.12〜0.23 秒 / ベンゼン 1.0〜1.3 秒。
チャンネルごとに格子を 1 枚ずつ持つので、`total` と `bonding` の初回はそれぞれ 1 回かかる。
以降の閾値変更: H₂O 2 ms / ベンゼン 11〜17 ms。設計計画の「数 ms」を満たしている。
チャンネルを切り替えて戻ると、その格子は残っているので 12〜15 ms。
格子は `density::GridSpec::for_molecule`（0.22 Bohr 間隔・パディング 4 Bohr・上限 30 万点）で、
ベンゼンは 80×75×38 = 22.8 万点。ρ の格子積分は電子数に対して H₂O −2.5%、CH₄ +2.8%、
ベンゼン −1.8%（一様格子は核の尖りを解像できない。SCF が Becke グリッドを使う理由そのもので、
表示用としては十分）。初回の 1.2 秒はほぼ全部が ρ のサンプリングで、marching cubes 自体は
その 1/100 以下。P6 で縮めるならブロックごとの基底関数スクリーニング（XC と同じ話）。

### P2 時点の性能（P6 の出発点）

ブラウザ実測（release + wasm-opt -O3、SIMD なし・単一スレッド）:
H₂O 0.6 秒 / CH₄ 0.6 秒 / ベンゼン **16.5 秒**（8 反復）。
ネイティブ内訳ではベンゼンの 4.2 秒のうち ERI が 2.2 秒、SCF 反復が 1.9 秒
（うちほぼ全部が XC のグリッド積分）。P6 で効きそうな順に:
ERI の Boys 関数のテーブル化、XC のブロックごとの基底関数スクリーニング、SIMD。
グリッドは `GridQuality::Medium`（原子あたり 60 動径点）で、PySCF の収束グリッドに対する
誤差は 2e-6〜5e-5 Ha。

## 開発環境の制約

**Claude の作業環境のブラウザは WebGL が使えない**（GPU 無効の Chromium）。3D 表示に関わる変更は、コードとロジックまでしか自動検証できないので、見た目の確認はユーザーに Firefox で依頼すること。WebGL 非依存の部分（パネル UI、ワーカー経由の計算結果）は Browser ツールで検証できる。
