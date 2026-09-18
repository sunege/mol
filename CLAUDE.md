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

## 構成

```
crates/dft-core/          純Rust の計算エンジン。wasm 非依存 → cargo test で全部検証できる
  src/basis/              Shell/BasisSet + sto3g_data.rs（生成物）
  src/integrals/          boys.rs, md.rs（McMurchie-Davidson）, onee.rs, eri.rs
  src/grid/               radial.rs, becke.rs, lebedev_data.rs（生成物）
  src/xc/                 lda.rs（Slater + VWN5）+ グリッド上の E_xc / V_xc 組み立て
  src/scf/                mod.rs（RKS ループ）, diis.rs, guess.rs（SAD）, linalg.rs
  tests/data/             PySCF/libxc 由来の参照値 JSON（生成物）
crates/dft-wasm/   wasm-bindgen ラッパー。単位変換とシリアライズのみ、物理を書かない
scripts/           gen_reference.py — 上の「生成物」をすべて作る唯一の場所
web/src/worker/    protocol.ts（UI↔Worker の契約）, dft.worker.ts, workerClient.ts
web/src/scene/     viewer.ts（Three.js, 命令的）, bonds.ts, webgl.ts
web/src/wasm/      npm run build:wasm の生成物。**コミット対象**
```

## 守るべき規約

- **単位**: エンジンは原子単位（Bohr, Hartree）、UI は Å。変換は `crates/dft-wasm` の境界 1 箇所だけ。エンジン内部に Å を持ち込まない。
- **`dft-core` に wasm 依存を入れない。** 全ロジックをホスト上の `cargo test` で検証できる状態を保つ。
- **`web/src/wasm/` はコミットする。** Vercel のビルド環境に Rust ツールチェーンが無いため。CI は PR で生成物の鮮度を検証し、main では自動で再生成してコミットする。
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
- **DFT パラメータを UI に出さない。** 基底関数・電荷・スピン多重度は自動決定（要件 F4）で、ユーザーには見せない。
- **Worker の契約は `protocol.ts` が唯一の情報源。** 失敗は例外を越境させず `error` レスポンスで返す。
- **キャンセルは `worker.terminate()` + 再生成**（`workerClient.ts`）。単一スレッド WASM は外から中断できないため。
- **Viewer はメッシュを再利用する。** 毎フレームのジオメトリ生成に戻さない。P5 の最適化アニメーションが同じ経路を毎フレーム叩く。
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
| **P3** | **電子密度等値面（ρ(r) グリッド、marching cubes、閾値スライダー）** | **次はここ** |
| P4 | 自動スピン・電荷決定 + 非収束時の発散アニメーション | 未着手 |
| P5 | 解析的勾配 + 構造最適化アニメーション（最大の実装リスク） | 未着手 |
| P6 | 性能（SIMD、スクリーニング、必要ならマルチスレッド化） | 未着手 |

各フェーズ終了時点で Vercel にデプロイ可能な状態を保つ。

### P3 への引き継ぎ

設計計画に書いていない、P2 の実装を踏まえた注意点:

- **収束後の状態を Worker 側に保持する仕組みがまだない。** 現在の `dft-wasm::scf()` は
  スカラー値だけを返して `System` と密度行列を捨てている。閾値スライダーの往復を数 ms に
  するには、収束した `System` + 密度行列を保持する `#[wasm_bindgen]` 構造体（ハンドル）を
  作り、`isosurface(isoLevel)` はそれに対して marching cubes だけを回す形にする。
  `protocol.ts` の想定（`isosurface` → `mesh`）はその前提で書いてある。
- **ρ(r) の評価は `xc/mod.rs` のブロック処理をそのまま流用できる。** 基底関数値の行列を
  作って `D * Phi` を取る形で、`BasisSet::evaluate_into` が既にホットパス用に
  （Cartesian べきをキャッシュして）整えてある。等値面用のグリッドは直交格子なので
  Becke 分割は不要。
- **3D 表示の見た目は自動検証できない。** 等値面が出たら Firefox で確認してもらう。
  メッシュの頂点数・体積・面積のような数値はテストで押さえられる。

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
