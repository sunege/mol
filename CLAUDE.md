# ブラウザ分子シミュレータ

ブラウザ上で本物の DFT（Rust → WebAssembly）を回し、化学を知らない人が原子を置くだけで
(1) 安定な形へ緩和するアニメーションと (2) 電子密度の等値面を見られるアプリ。
**v1（P0〜P7）・v2（P8〜P10）・v3（V3-1〜V3-9）完了、Vercel にデプロイ済み。**
**次にやるのは v4（分子軌道を見せる）。着手は [docs/v4/README.md](docs/v4/README.md)（板）から。
1 チケット = 1 セッションで、板とチケット 1 枚だけ読めば着手できる。**

**このファイルは毎回読み込まれるので、規約と現状だけを短く置く。** 各ファイルの先頭コメントが
設計と理由を書いているので、細部はそこを読む。経緯・実測・却下した案・数字の出どころは
[docs/dev-notes.md](docs/dev-notes.md)（自動では読まれない。触る領域の節だけ読む）。

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
  **現状のまま使う間の注意書きは `ISOMER_CAVEAT`。**
  **V3-9 で Firefox と講義 PC の確認まで済み**（2026-09-23。角度は 3 環境で一致、手直し無し）。
- そのほかの候補（dev-notes「P6 以降に残したもの」）: XC グリッド重み微分、マルチスレッド化
  （nightly 依存）。**WebGPU は採らないと決めた**。**予算（`OPTIMIZE_BUDGET_SECONDS` 1800 秒と
  候補の 10 分）は V3-8 で実測して据え置き。** 「形を測る」のための候補 2 つは v3 の板。
- **講義で使う PC**（Windows 11 / i5-1235U / Chrome）**は V3-9 で実測済み**で、どれも開発機より
  速い（ベンゼンを測って 95 秒、Worker 643 MiB、`poolSize` 3）。**`MAX_CONCURRENT` は 3 のまま。**
- **v4 は「分子軌道を見せる」**（2026-09-23 計画、V4-1 完了）: 軌道の絵と位相・結合性/反結合性と節・
  準位のはしご・二原子分子の距離スキャン。**既定の画面は v3 のまま**で、パネルに**既定で閉じた
  「分子軌道」の節**が 1 つ増える。**F4 は「既定の画面に出さない」に読み替え**、節の中でも
  基底・汎関数・電荷・多重度は出さない。**軌道エネルギーの数値も出さない**（LDA の絶対値は桁が
  違う）。**軌道は「形を探す」の結果だけ**／**縮退は組として扱う**（しきい値 1e-4 Ha）／
  **位相の符号は絶対値最大の係数を正に固定**／**開殻（O₂）も扱い、上向きと下向きは 2 列に
  分けて畳まない**（α と β の対応は添字ではなく重なり `⟨α_i|S|β_j⟩`。**多重度が読めるのは
  この節だけで、それは教える中身**）／**二原子分子の σ/π は縮退で分ける**（1 枚の鏡映面では
  割れる）。理由は plan-v4.md、実測は dev-notes「v4-0 の実測」。
- **記録の置き場所**: 経緯・実測・却下した案は dev-notes の「フェーズの記録」に足し、この
  CLAUDE.md には規約と現状だけを 1〜2 行で足す。

## 開発環境の制約

- **Claude の作業ブラウザは WebGL が使えない**（GPU 無効の Chromium）。3D の見た目とクリック操作は
  ユーザーに Firefox で確認を依頼する。パネル・Worker・IndexedDB は Browser ツールで検証できる。
- HMR ではマウント時の effect が再実行されない（再マウントの手口は dev-notes「P7 の実装メモ」）。
