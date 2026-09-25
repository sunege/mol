# ブラウザ分子シミュレータ

ブラウザ上で本物の DFT（Rust → WebAssembly）を回し、化学を知らない人が原子を置くだけで
(1) 安定な形へ緩和するアニメーションと (2) 電子密度の等値面を見られるアプリ。
**v1（P0〜P7）・v2（P8〜P10）・v3（V3-1〜V3-9）・v4（V4-1〜V4-10）・v5（V5-1〜V5-11）・
v6（V6-1〜V6-11）完了、Vercel にデプロイ済み。**
v3〜v6 と同じく、板（`docs/vN/README.md`）とチケットに分け、1 チケット = 1 セッションで進める。

**このファイルは毎回読み込まれるので、規約と現状だけを短く置く。** 各ファイルの先頭コメントが
設計と理由を書いているので、細部はそこを読む。経緯・実測・却下した案・数字の出どころは
[docs/dev-notes.md](docs/dev-notes.md)（自動では読まれない。触る領域の節だけ読む）。

- v6 のチケット（完了）: [docs/v6/README.md](docs/v6/README.md)（板）。
  **なぜこの形か**だけ: [docs/plan-v6.md](docs/plan-v6.md)
- v5 のチケット（完了）: [docs/v5/README.md](docs/v5/README.md)（板）。
  **なぜこの形か**だけ: [docs/plan-v5.md](docs/plan-v5.md)
- v4 のチケット: [docs/v4/README.md](docs/v4/README.md)（板）。
  **なぜこの形か**だけ: [docs/plan-v4.md](docs/plan-v4.md)
- v3 のチケット: [docs/v3/README.md](docs/v3/README.md)（板）。
  **なぜこの形か**だけ: [docs/plan-v3.md](docs/plan-v3.md)
- v2 の計画・決定: [docs/plan-v2.md](docs/plan-v2.md)
- 要件定義書: https://claude.ai/code/artifact/35efc875-a8df-49bc-946b-9e18abba1614
  （Claude Docs。docs コネクタの `read` で読む。web fetch では読めない）
- v1 の設計計画: `~/.claude/plans/tidy-munching-sedgewick.md`

## スコープ

非周期系（分子）のみ、H–Ar の全電子、H₂O〜ベンゼン規模。基底 **STO-3G**、汎関数
**LDA（Slater + VWN5）**。対象外: 周期系・重元素・TD-DFT・反応経路。
性能目標「ベンゼンの SCF + 構造最適化が数秒〜十数秒」→ ブラウザで約 15 秒。

## コマンド

```bash
npm run dev          # Vite (5173)。launch.json: mol-dev / mol-preview (4173, web/dist)
npm run build        # tsc -b && vite build → web/dist
npm test             # vitest (web)。engine.test.ts はコミット済みの .wasm を実際に呼ぶ
npm run lint --workspace web
npm run build:wasm   # scripts/build-wasm.sh → web/src/wasm/（コミットする）
cargo test --workspace
cargo run --release --example profile -- benzene --optimize   # ネイティブの内訳
```

- **時間の比較は Node で取る**（`--target nodejs` の release を小さなスクリプトから呼ぶ）。
  Browser ペインは非表示だと間引かれ、この機械（2 物理コア）は同じバイナリでも **±30% ぶれる**
  ので複数回の最小値で判断する。**WASM の高速化は WASM のプロファイルで決める**（内訳は
  ネイティブとまるで違う）。手順は dev-notes「コマンドの詳細」。
- 参照値の再生成（`scripts/gen_reference.py`、PySCF）は基底・汎関数を変えるときだけ。丸ごと
  回すと SCF の JSON が収束ノイズ（< 1e-10）だけ揺れるので、**意図して変えたファイル以外は
  `git checkout` で戻す**（揺れる顔ぶれは dev-notes「V3-2 の実装メモ」）。

## 構成

`crates/dft-core/` 純 Rust のエンジン（**wasm 非依存**。`cargo test` で全部検証できる）/
`crates/dft-wasm/` wasm-bindgen ラッパー（**単位変換とシリアライズだけ。物理を書かない**）/
`scripts/gen_reference.py` **生成物をすべて作る唯一の場所** / `web/src/worker/protocol.ts`
**Worker の契約 ＝ 唯一の情報源** / `web/src/search/` 探索プールと候補 / `web/src/records/` 記録 /
`web/src/scene/viewer.ts` Three.js（命令的）/ `web/src/wasm/` 生成物（**コミットする**）

## 守るべき規約

### エンジン
- **単位**: エンジンは原子単位（Bohr, Hartree）、UI は Å。変換は `dft-wasm` の境界だけ。
- **`dft-core` に wasm 依存も時計も入れない。** 予算・進捗はクロージャで受ける。
- **参照値・物理定数を記憶から書かない。** テスト内で独立な経路から導出するか
  `gen_reference.py` の生成物にする（STO-3G・6-31G\*・Lebedev・`tests/data/`・`units.json` も
  生成物で手編集しない）。例外は `xc/lda.rs` の VWN5 定数。合わないときは先にどちらが正しいかを確かめる。
- **基底は `System` が覚えている**（`System::kind`、`BasisKind::{Sto3g, B631Gs}`）。`System` から
  別の `System` を組む箇所（SAD の原子・最適化の毎歩）は必ず `system.kind` を引き継ぐ。
- **勾配は HF 項 + Pulay 項**で、SCF 収束時にしか成り立たない。書き換えたら
  `integrals/deriv.rs` の**項ごとの**有限差分と並進不変性を先に見る。
- **XC のグリッド重み微分は省略**＝解析勾配は「グリッド固定のエネルギー」の厳密な微分。検証は
  `System::build_with_grid`。最適化は Fine（`opt::OPTIMIZER_GRID`）、一点は Medium。
- **`nalgebra` の `SymmetricEigen` は使わない**（固有値と固有ベクトルの対応が黙って壊れる）。
  `scf/linalg.rs` の Jacobi。検査は `A V = V Λ` と `V L Vᵀ = A` の両方。
- **スピン探索は一重項と三重項を両方解いて比べる**（ギャップでの振り分けは不可）。探索は
  Medium、勝った状態だけ Fine で解き直す（`driver::solve_then_refine`）。
- **性能の前提を崩さない**（どれも壊すと答えは同じまま遅くなる。理由は dev-notes）:
  `DensityPair` / `BasisSet::groups()` / グリッド点の 128 点ブロック / **証明できる上界でだけ**
  落とすスクリーニング / `BasisOnGrid` は SCF 1 回ごとに作って捨てる / XC の行列積は `kernels.rs`。
- **π/σ 判定は鏡映の対称性**（`Cᵀ S U C` の対角）で経験則ではない。3 原子は必ず平面なので
  `MIN_ATOMS_FOR_A_PLANE = 4`。
- **marching cubes の表を書き写さない**（`marching.rs` が定義から導出）。閉曲面性は
  「有向辺が往復で打ち消し合う」で検査する（「無向辺が 2 枚」ではない）。

### 画面に出すもの（要件 F4 / F5）
- **DFT パラメータを出さない**: 基底・電荷・多重度・試した状態・試行回数。`ScfOutcome` の
  `multiplicity` / `charge` / `attempts` は診断用（dev の `console.debug` だけ）。進捗の段階名も
  「何に時間を使っているか」だけ。
- **非収束は例外ではなく戻り値。「解けなかった」と「間に合わなかった」を区別する**:
  SCF 非収束 → 発散アニメーションだけ、数値・等値面は全部 `—`。時間切れ・回数上限
  （`interrupted` / `maxSteps`）→ そこまでの構造を残し、数値・等値面を出し、理由を表示する。
  判定は `hasUsableStructure()` だけ。UI の `solved`（数値を出してよい）と `settled`（「完了」と
  言ってよい）は別物。
- **電子密度のボタンは 3 つ**（`components/density.ts`）。**エンジンが選ぶのは「結合に寄与する
  電子」のときだけ**（平面分子なら π、それ以外は符号付きの差密度）で、UI は返ってきた `channel` で
  説明文と色を変える。「原子から動いた電子」（差密度）と「すべての電子」は名指しで、来たものが
  そのまま返る。**π のボタンは `ScfOutcome.hasPi` のときだけ出す**（F4 の対象外＝平面かどうかは
  画面を見れば分かる幾何）。`hasPi` は**画面の分子のもの**で、計算のたびに消えないよう `result`
  からは読まない（消えると選択も `'total'` に戻ってしまう）。

### Worker
- **契約は `protocol.ts` が唯一の情報源。** 失敗は `error` で返し例外を越境させない。終端かは
  `isTerminal()`。進捗の段階名は `dft-wasm` の `mod stage` と `progressFromEngine()` の 2 箇所に
  あり、ずれても落ちずカードが止まるだけなので `engine.test.ts` が実物の `.wasm` で照合する。
- **段（`ModelLevel = 'shape' | 'measure'`）は識別子だけが境界を越える**（基底名は越えない）。写すのは
  `dft-wasm` の `basis_for` だけで、省略＝`'shape'` もそこ 1 か所、**知らない名前はエラー**。段が違う結果は比べない。
- **キャンセルは `terminate()` + 再生成。** 保持中の `Calculation`（密度）も消えるので等値面は
  SCF からやり直し（`hasDensityRef`）。等値面の要求は App で合流させる（`wantedRef`）。
  **「中止」ボタンだけは `stopRelaxations()`** で形を残す（分離されたページでは共有の停止フラグで
  一歩の後に止め、数値・記録・等値面も残る。`reason` は `'interrupted'` のまま）。編集・プリセット・
  記録の `cancelCalculation()` は形を残さない。`canStopInPlace()` は `EngineProblem` にしない。
- **起動時に SIMD を判定**し、非対応なら Worker を作らず案内（`engineSupport.ts`）。初期化失敗も
  `EngineUnavailableError`。下限は Chrome/Edge 96・Firefox 114・Safari 16.4。
- **前面 1 本 + 探索のプール。** 大きさは `hardwareConcurrency` そのものではなく `poolSize`
  （`min(MAX_CONCURRENT, max(1, floor(値/2) − 1))`）。**決め手は処理量ではなく前面の応答**
  （裏で 2 本回すと前面が 2.5 倍遅い）。**WASM の線形メモリは縮まない**ので Worker はバッチの
  間だけ使い回し、キューが尽きたら捨てる（ベンゼンで 1 本 139 MiB）。**候補は `atoms`・
  `FramePlayer`・前面の Worker を触らない。** **段は `SEARCH_LEVEL`（`'shape'`）固定**で、プールの
  要求も候補の記録もそこから取る（プールは段を受け取らず、前面の `level` を読まない）。
- **1 候補の予算は `budgetMs`**（10 分）。step コールバックから**例外を投げて**止める＝
  `reason: 'interrupted'` と**そこまでの構造**が返る（`terminate()` と違って構造が残る）。
  前面は送らない。`dft-wasm` の `on_step` の**戻り値は読まれない**。

### UI
- **緩和の前に、平らで手で作った構造だけ揺らす**（`perturb.ts` 0.05 Å、`needsNudge(xyz,
  handBuilt)`）。クリックは全原子をカメラ平面に置くので、そのまま最適化すると平面の鞍点で
  「収束」する（平面 CH₄ は正四面体より 834 kJ/mol 上）。**`handBuilt` は App が持つ出どころ**で、
  プリセット・記録・候補・**緩和から出てきた構造**では偽（「プリセットでない」ではない）。
  揺らすとベンゼンが 3 歩 → 17 歩になり、「形を探す → 形を測る」が 176 秒 → 372 秒になる。
  **探索の候補は別の振幅**（`candidates.ts` 0.2 Å）。
- **編集 / 観測モード。** ポインタとキーの解釈は `gestures.ts` だけ（観測モードは構造を変える
  動作を返さない）。計算の開始時に観測モードへ、発散・エラー・中止なら開始前のモードへ戻す
  （計算中にユーザーが選んだモードは戻さない）。計測は原子の並びが変わる操作で消す。
  **選んだ原子にワールド XYZ の矢印**（編集モードだけ、viewer の `#handles`）。矢印のドラッグは軸の上だけ
  （`axisDrag.ts`）、原子のドラッグは画面の面内（V6-10）。
- **パネルのタブ＝モード**（v5）: 「計算」＝編集、「観察」＝観測（`components/Tabs.tsx`）。選ばれた
  タブは `mode` そのもので、タブ用の状態を持たない（押すと `chooseMode`、描くのは 1 枚だけ）。
  例外は 720px 以下の「記録」タブだけ（App の `narrowRecords`、`panelTabs.ts`）。状態・全エネルギーと、
  **計算中だけ止める 2 枠**は `StatusHeader`。**走らせる 2 つは計算タブの「次の計算」の下**
  （表は `actions.ts`）。
- **ボタンは 4 つの型だけ**（`components/controls.tsx`: `Segmented`・`Choices`・`ActionGrid`・
  `IconButton`、見た目は `.btn` の 1 クラス、アイコンは `icons.tsx` のインライン SVG）。**使えないときは
  消さずに無効**（規約で「出さない」もの ＝ π の選択肢・2 原子の「近づけてみる」は縦に積む場所に）。
  **DFT を回すボタンは `RunButton`**（緑 + ▶。止めるボタンは素の `.btn`）で、ほかに緑は使わない。
- **記録は左の欄のツリー**（`RecordExplorer`、分子 › 段 › 記録、同じ谷は代表の下に畳む、探索の候補も
  「形を探す」の先頭に入る。木は `records/tree.ts`、開閉は `localStorage` の `mol.explorer` で
  **押したノードだけ**覚える。**谷の開閉の鍵は谷の最古の記録**、候補の時計は欄の中だけ `useNow`）。
  **分子の順は最初の記録の新しい順で、選んでも動かない**（`tree.ts` が決め、App は並べ替えない。
  画面の分子は行の `current` で示す）。**狭い画面では記録タブの中**で、欄は 1 か所にだけ描く（`foldable={!narrow}`）。
- **近づけてみるは画面の 2 原子だけ**（組の選択肢は無い。`scanPairFor`）。マーカーは編集として
  原子を置き、**止まって 400 ms で一点計算**、見ていた軌道は `carryPick`（添字ではなく対称性と順位）で
  選び直す。はしごは `orbitalsOpen || scanOpen`（1 つの値）で取り、選んだ段を捨てるのは分子軌道を
  閉じたときだけ。
- **操作の説明と「全体表示」は 3D の上**（下端の帯 `viewportHint`、`pointer-events: none`、WebGL が
  動くときだけ／右下の `IconButton`）。パネルには置かない。
- **段の選択（`level`）は次の計算のもの**（文言は `components/level.ts`）。App は client に**いつも
  明示して渡し**、計算中は固める。**画面の数値の段は別の `resultLevel`**（状態の行に出す）。
  記録の等値面は選択ではなく**記録の段**で解く（`levelOfRecord`）。
- **記録**（`hasUsableStructure()` で終わるたびに 1 件）。**比べてよい組は Hill 式 + 電荷 +
  `engineModel(level)`**（電荷は `driver` が選ぶので内部の比較キーに使い、**画面には出さない**）。
  `engineModel` の文字列は基底・汎関数・最適化グリッドを変えたら書き換える。**記録の段は `model` から
  引く**（`levelOfModel`、フィールドは無い）ので、変えた古い文字列は段ごと残す（知らない `model` の
  ファイルは拒否）。群の見出しの段は `levelLabel`。**同じ谷は 1 kJ/mol 以内**。
  時間切れ・回数上限は「途中」で順位にも谷にも入れない。**開いたら数値は記録のもの**（等値面の
  ための一点計算で上書きしない。グリッドが違う）。ファイルは形を変えたら `version` を上げ、
  **1 件でも駄目なら全部拒否**。保存は `RecordStore` 越しで、**開けないブラウザでは「残りません」と
  案内して動かす**（失敗にしない）。
- **計測値は viewer が描いている位置から出す**（補間フレームは React に届かない。パネルは
  `LiveMeasurement` を購読）。ラベルは `CSS2DRenderer` の層で、z-index は進捗カードより下。
- **アニメーションはキーフレーム列 + `FramePlayer`**（発散も最適化の step も同じキュー。時計と
  スケジューラは注入してブラウザ無しでテストする）。**アニメーション中は viewer の所有権が
  `FramePlayer`** で、キューが空でも `producerDoneRef` が立つまで終わりではない。**緩和後の構造は
  即 `setAtoms`**（背景タブでは rAF が走らない）。発散は絵なので `atoms` を触らない。
- Viewer はメッシュとマテリアルを再利用し、古い geometry は必ず `dispose()`。
  `renderer.setSize(w, h)` の第 3 引数を `false` にしない（Retina で canvas がパネルを覆う）。

### ビルド・CI・デプロイ
- **`web/src/wasm/` はコミットする**（Vercel に Rust が無い）。作るのは `npm run build:wasm` だけ。
  rustflags を `RUSTFLAGS` で渡さない（`.cargo/config.toml` の `+simd128` が黙って消える）。
- **`cargo fmt` を掛けない**（リポジトリは rustfmt で整えておらず、触っていないファイルにも差分が
  出る）。触った行だけ手で 100 桁に収める。
- **Rust を書き戻すときに `mv` や `cp -p` を使わない**（mtime が戻って cargo が再ビルドを飛ばし、
  古い `.wasm` ができる）。疑わしいときは定数がバイナリに入っているかを直接見る（dev-notes）。
- **出荷されるのは CI（Linux）のビルド。** Mac のビルドは機能同一だがバイトが一致しない。CI は
  作り直して違えばコミットする → **push したら `git pull`**。**コメントだけの Rust の変更でも
  生成物は変わる**（doc は `.d.ts`/`.js` に写り、行が増えるとパニック位置の行番号が動く）。
  Rust 1.98.1 と wasm-pack 0.15.0 は揃えて上げる。
- **ページは cross-origin isolated**（COOP `same-origin` + COEP `require-corp`、`vercel.json` と
  `vite.config.ts`）。**cross-origin の資源（Web フォント・CDN・解析）を足すと読めなくなる。**
- **Vercel の Root Directory はリポジトリ直下（空）**、設定は直下の `vercel.json`。正しい
  ビルドログには `> mol@0.1.0 build` が出る。

## 状態と今後

- **v1・v2 完了**、いずれも Firefox 確認済み。v2 で足したのは観測モード・安定構造の記録・
  並列探索（パネルの「いろいろな形を試す」。v2 では「形をさがす」）。
- **v3 は「目的に合わせて段を選ぶ」2 段**（2026-09-21 決定）: **「形を探す」**（STO-3G/LDA、
  今のまま、既定）と **「形を測る」**（6-31G\*/LDA）。コード上は `ModelLevel = 'shape' | 'measure'`。
  **段は計算ごとに選ぶ**／**探索は「形を探す」に固定**（メモリ）／**ベンゼンも「形を測る」可**
  （実測 176 秒。1 歩 17 秒 ＝ 中止の待ち、Worker は 420〜625 MiB。dev-notes「v3 の実測」）。
  **「精度 低/中/高」とは呼ばない**（実測で上が常に良いわけではない）。
  B3LYP の一点計算は**保留**。実測は dev-notes「v3-0 の実測」、理由は plan-v3.md。
  **現状のまま使う間の注意書きは `isomerCaveats`（段ごと。ツリーにある段だけ出す: 「形を探す」は
  異性体の順が逆に出うる、「形を測る」は順は合うが差が小さく出うる）。**
  **V3-9 で Firefox と講義 PC の確認まで済み**（2026-09-23。角度は 3 環境で一致、手直し無し）。
- そのほかの候補（dev-notes「P6 以降に残したもの」）: XC グリッド重み微分、マルチスレッド化
  （nightly 依存）。**WebGPU は採らないと決めた**。**予算（`OPTIMIZE_BUDGET_SECONDS` 1800 秒と
  候補の 10 分）は V3-8 で実測して据え置き。** 「形を測る」のための候補 2 つは v3 の板。
- **講義で使う PC**（Windows 11 / i5-1235U / Chrome）**は V3-9 で実測済み**で、どれも開発機より
  速い（ベンゼンを測って 95 秒、Worker 643 MiB、`poolSize` 3）。**`MAX_CONCURRENT` は 3 のまま。**
- **v4 は「分子軌道を見せる」**（2026-09-23 計画、**V4-1〜V4-10 完了**）: 軌道の絵と位相・結合性/反結合性と節・
  準位のはしご・二原子分子の距離スキャン。**既定の画面は v3 のまま**で、パネルに**既定で閉じた
  「分子軌道」の節**が 1 つ増える。**F4 は「既定の画面に出さない」に読み替え**、節の中でも
  基底・汎関数・電荷・多重度は出さない。**軌道エネルギーの数値も出さない**（LDA の絶対値は桁が
  違う）。**軌道は「形を探す」の結果だけ**／**縮退は組として扱う**（しきい値 1e-4 Ha）／
  **位相の符号は絶対値最大の係数を正に固定**／**開殻（O₂）も扱い、上向きと下向きは 2 列に
  分けて畳まない**（α と β の対応は添字ではなく重なり `⟨α_i|S|β_j⟩`。**多重度が読めるのは
  この節だけで、それは教える中身**）／**二原子分子の σ/π は縮退で分ける**（1 枚の鏡映面では
  割れる）。理由は plan-v4.md、実測は dev-notes「v4-0 の実測」。
  **エンジン側は `dft-core/src/orbital.rs`**（一覧・縮退の組・符号・重なり占有数・面の上の振幅）。
  **軌道の格子は `density::evaluate_orbital`（線形）で取る**: rank-1 の `c cᵀ` を `evaluate` に
  流すと ψ² になって位相が消える。**符号を決めるのは `orbital::signed_column` と、向きを
  渡されたときの `orbital::oriented`（縮退の組を方向 `d` の p 関数に原子ごとに合わせて回す）**
  （`ScfResult` は書き換えない）。**原子の軌道は自由原子の係数を分子の基底の区画に埋める**
  （`atomic_column`。列の順は `atomic_levels` の並び）。
  **境界は `orbitals()` と 4 つめの要求 `'orbital'`**（V4-3。密度のボタンではない）。**段の
  `first` はスピンの組の中での軌道の添字で、`levels` 配列の添字は `partner` だけ**。軌道の格子は
  **最後の 1 本だけ**を `(分子/原子, 添字, スピン, 向き)` の鍵で持ち、**`spin` 省略＝`'both'` は開殻ではエラー**。
  **`atom` を付けると自由原子の軌道（`orbital` は `atomLevels` の並び）、`along` は縮退の組を回す向き**（V6-6）。
  **節は `components/OrbitalPanel.tsx` と `orbital.ts`**（V4-4。既定で閉じた `<details>`）。
  **描くのは常に 1 つだけ**で、`channel` は状態ではなく `orbitalPick` からの導出、密度のボタンは
  `'orbital'` を取らない型（`DensitySurface`）。**軌道の一覧は節が開いている間、計算 1 回につき
  1 度だけ取り直す**（`hasDensityRef` と並走する世代カウンタ `density`。しきい値では取り直さない）。
  **性格は `orbitalCharacter` の 1 往復**（V4-5）で、一覧と同じく**軌道を変えたときだけ**取りに
  行く。**どの 2 原子が結合かは UI の `findBonds`**（エンジンは原子 × 原子の行列を返すだけ）。
  **重なり占有数も振幅も数値は出さず符号と大小の言葉だけ**で、**節を数えるのは平面の π だけ**
  （`orbital.ts` の `describeBonds` / `countNodes` / `describeLobes`）。
  **はしごは `components/ladder.ts`（純粋）＋ `OrbitalLadder.tsx`（SVG）**（V4-6。節の中の一覧を
  置き換えた）。**内殻は「下から見て、隣との差が上の全部の幅より大きい最初のところ」で切る**
  （しきい値ではない。畳むのは**占有された段だけ**、**上に 2 段以上残る**とき ＝ H₂ が結合性軌道を
  畳まないための歯止め。**開殻は両スピンを混ぜて 1 回だけ切る**）。**高さは energy に比例させ、
  近すぎる段だけ局所的に押し広げる**（大きな開きは潰さない。一様に混ぜると交換分裂が消える）。
  **`partner` は「返ってきた配列」の添字**なので段は `spin:first` の鍵で引く。**SVG に書く文字は
  すべて `ladder.ts` が組み立てる**ので、「数値が出ていないこと」は `ladder.test.ts` が絵を歩いて見る。
  **距離スキャンは `dft-core/src/scan.rs`**（V4-7。二原子だけ）。**スピン状態はいちばん短い距離で
  1 回だけ選んで固定**（各点で `driver` に選ばせると伸ばした H₂ で三重項が勝って図が飛ぶ）、
  **各点は自分の原子密度から解く**（逆向きに歩いても同じ曲線）、**線をつなぐのは `count`
  ＝ 対称種**（二原子に鏡映のパリティは取れないので `ScanLevel` に `parity` は無い。同種の
  二原子は反転の `inversion` も鍵に入れる ＝ σg と σu は交差してよい）。
  境界は `scan()` / `atomLevels()` と `scanPoint`（中間）・`scanDone`（終端、中身なし）で、
  **点の上限 `MAX_SCAN_POINTS` は 60、Worker が拒否する**。**スキャンは保持中の `Calculation` を
  触らない**ので等値面は生き残る。**収束しない点も届く**（曲線の穴。HF は 1.89 Å から先で落ちる）。
  **図は `components/scan.ts`（純粋）。距離スキャンは `DistanceScan.tsx`、相関図は
  `CorrelationDiagram.tsx` で二原子の分子軌道の節のはしごの代わり**（V4-8・V6-4。どちらも
  **原子がちょうど 2 個のときだけ**。相関図の分子の線は `picks` で軌道を選ぶ）。
  **縮退した組は向きで選ぶ**（`Along`、**押したときの画面で固める**＝ App の `orbitalDirection`。しきい値・
  回転・マーカーでは向きを変えず、押し直すと決め直す。原子の線は `atom` 付きの pick、V6-8）。**文字はすべて `scan.ts` が組み立てる**ので
  「数字が横軸の距離だけ」は `scan.test.ts` が絵を歩いて見る。**線は `count`（対称種）ごとに
  「下から n 番目」で辿り**、**縦のスケールは収束した点だけで決めて非収束は線の穴**にする。
  **谷を名指しするのは `MIN_WELL`（記録の 1 kJ/mol）より深く、かつ最低点が左端でないとき**
  （He₂ は落ちる）。**占有はマーカーのところ**＝見ている距離のもので、**開殻は上向きが左・
  下向きが右**（実線／破線と揃える）。**相関図は「数えて」結ぶ**（原子は基底関数の数だけ
  配れるので、下から `占有割合 × count` を足して k を跨いだ段が k 番目の原子準位から来た段。
  割合は `orbitalCharacter` の**行の和 ÷ 全体の和**）。**マーカーを動かすのは編集と同じ扱い**
  （`invalidateResult()`、`handBuilt` は偽）で、**止まって 400 ms で `calculate(placed)`**、
  選んでいた軌道は `carryPick`（添字ではなく種類と順位）で選び直す（V5-11。**スキャンは画面の
  2 原子だけ**で組の選択肢は無い）。**「やめる」は `cancelAll()`**（点は残るが等値面は解き直し）。
  **値段は V4-9 で実測**（Node。dev-notes「V4-9 の実測」）: 軌道の切り替えはベンゼンで 0.46 秒
  （しきい値だけなら 14 ms）、`orbitals()` / `orbitalCharacter()` は 1 ms 未満、スキャンはプリセット
  27 点で 0.6〜2.4 秒。**メモリの山は v3 のまま**（軌道・密度 3 種・スキャンを足しても増えない）ので
  **軌道の格子は 1 本のまま**。軌道のしきい値 0.015〜0.1・`rangeAround` 0.7〜1.8 倍・`LINK_FLOOR`
  0.18 の根拠は各定数のコメント。**伸ばした二原子の割れは `DEGENERACY_TOLERANCE` では直らない**（範囲で避ける）。
  **V4-10 で Firefox と講義 PC の確認まで済み**（2026-09-24）。性格の言葉は**教科書の 3 語**（結合性・反結合性・
  非結合性、`bondClause`）。原子軌道の名前（1s/2s/2p）は**本数で読む**。**σ/π の \* は同種の二原子なら
  反転の対称性（σg・πu が結合性）、異種なら重なり占有数**で、図 2 枚と言葉が同じ `verdictBySymmetry` /
  `diatomicName` を通る（N₂ の 3σg は重なり占有数では −0.063）。
- **v5 は「パネルの並べ方」だけ**（2026-09-24、V5-1〜V5-11 完了、Firefox と講義 PC で確認済み）:
  パネルを「計算」「観察」の 2 タブ（＝モード）に分け、状態と主ボタンを上に固定、記録を左の欄の
  ツリーへ。エンジン・Worker の契約・`.wasm` は触っていない。1366×768 で H₂O の観察タブは
  スクロールなし（v5 の前はパネル 2,168px の最下部に状態）。規約は上の「UI」、理由は plan-v5.md、
  実測は dev-notes「v5-0 の実測」「v5 の実測」、各チケットの細部は dev-notes の「V5-n の実装メモ」。
- **v6 は「使っていて気になった細部 5 点」**（2026-09-25〜26、V6-1〜V6-11 完了、Firefox と講義 PC で確認済み）:
  走らせるボタンを計算タブへ、二原子は相関図だけ（原子の線も押せて、縮退の組は押したときの画面の向きで
  選ぶ）、記録ツリーの並びの固定と「…」から消す、段ごとの注意書き、座標軸のハンドル。**「…」のリストは
  `position: fixed`**（`menuPlacement.ts`。ツリーの箱に切り取られない）。細部は dev-notes の「V6-n の実装メモ」。
- **記録の置き場所**: 経緯・実測・却下した案は dev-notes の「フェーズの記録」に足し、この
  CLAUDE.md には規約と現状だけを 1〜2 行で足す。

## 開発環境の制約

- **Claude の作業ブラウザは WebGL が使えない**（GPU 無効の Chromium）。3D の見た目とクリック操作は
  ユーザーに Firefox で確認を依頼する。パネル・Worker・IndexedDB は Browser ツールで検証できる。
- HMR ではマウント時の effect が再実行されない（再マウントの手口は dev-notes「P7 の実装メモ」）。
