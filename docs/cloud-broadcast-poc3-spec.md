# PoC-3 仕様書 — 負荷計測（同時発話 N・インスタンスサイズ・コスト上限）

## 0. この文書について

`cloud-broadcast-poc-plan.md` の **PoC-3** を、そのまま実装・実行・判定できる粒度に落とした実装仕様。

- **目的**: **H3 = 想定同時発話数 N_target の Opus デコード + ミックス + 1080p 静止画 H.264 + AAC エンコードが、CF Containers の対象インスタンスに収まる**ことを実測で確定し、副産物として**月額コスト上限 n** を算出する（会社要件「上限を言い切れる」spec §9.3）。
- **位置づけ**: 基盤（PoC-0）・入出力（PoC-1）・ミックス（PoC-2）確定後の最終 PoC。不合格でも分岐はエンコード設定調整 → インスタンス変更 → 基盤再考の順で、設計のやり直しにはならない。
- **前提**: PoC-2 合格済み。合成負荷の注入口として `Mixer.pushUser`（poc2-spec §5.1 のインターフェース）を使う。
- **検証しないこと**: 「要求稼働時間を超える常駐耐久」。検証単位は**配信 1 回分（30 分）**であり、常時稼働の耐久試験はワークロード（月数回 × 30 分、spec §9.1）に対応する検証ではないため行わない。

---

## 1. 検証仮説と判定基準

- **H3**: N_target 人の同時発話相当の負荷で、**音の欠落なく** 10 分以上送出を維持できる。

| 指標 | 合格 | 補足 |
|---|---|---|
| ミキサ underruns / gap 異常 | 0（負荷起因の欠落なし） | **主判定**。音が欠けないことが本質 |
| FFmpeg フレームドロップ | 0 | `-progress` の `drop_frames` |
| CPU 使用率（コンテナ全体） | 定常で vCPU 上限の 80% 未満 | 参考値（バーストで超えても欠落ゼロなら合格） |
| メモリ RSS | インスタンス上限の 80% 未満 | 参考値 |

- **N_target（想定同時発話数）は本 PoC 開始前にユーザーが確定する**（現行運用の実績値。未確定のまま実施しない — 合格の定義が定まらないため）。
- 計測は N を段階的に上げて**曲線**を取る（N = 1, 2, 3, 5, 8, N_target…）。合否は N_target の行で判定し、余裕（何人まで持つか）も記録する。

---

## 2. スコープ

- **In**: 合成負荷による N 段階の CPU/メモリ/欠落計測、少人数実 VC との突き合わせによる合成負荷の妥当性確認、インスタンスサイズの確定、月額コスト上限 n の算出。
- **Out**: エンコード品質のチューニング（fps/ビットレートの既定は spec §5.2。変更は不合格時の分岐でのみ行う）、オートスケール・多重配信。

---

## 3. アーキテクチャ

```
[HTTP] /loadtest?n=N&durationSec=600
          │
          ▼
  合成負荷ジェネレータ ──(録音済みOpusフレーム列を20ms間隔×N並列)──► Opusデコード ──► Mixer.pushUser
                                                                              │
  （実VC受信は使わない。ただし §6-4 で少人数実測と突き合わせ）      BGM ──► Mixer ──► FFmpeg ──► RTMPS
          │
          ▼
  計測: CPU(自プロセス+ffmpeg子プロセス) / RSS / mixer.stats() / ffmpeg -progress
```

- 負荷の実体は「**受信と同じ経路のデコード + ミックス + エンコード**」。トランスポート（UDP 受信そのもの）の負荷は音声ビットレート程度で支配的でないため、合成で代替する。
- 送出先は実 YouTube（RTMPS の実負荷込みで測る）。

---

## 4. リポジトリ構成（`poc-udp-spike/` への追加）

```
poc-udp-spike/container/
├── loadgen.mjs         # 録音済みOpusフレーム列を N 並列で 20ms 間隔リプレイ → decode → pushUser
├── metrics.mjs         # CPU/RSS サンプラ（1 秒間隔、自分 + ffmpeg 子プロセス）
├── assets/sample.opus  # 発話サンプル（数十秒、人の声。無音を含まないもの）
└── index.mjs           # 変更: /loadtest 追加
```

---

## 5. 実装仕様

### 5.1 合成負荷 `loadgen.mjs`

- `assets/sample.opus` を Opus **フレーム列（20ms 単位）**に事前分解してメモリへ持つ
- user ごとに開始オフセットをずらしてループ再生し、`20ms` ごとに 1 フレームを **`prism.opus.Decoder`（実受信と同一構成）→ `Mixer.pushUser`** に流す（= 「常時全員発話し続ける」最悪ケースを模す）
- タイマは PoC-2 のフレーマと同じ「経過時間から出すべきフレーム数を算出」方式（タイマ遅延で負荷が薄まるのを防ぐ）

### 5.2 計測 `metrics.mjs`

- 1 秒ごとに記録: `process.cpuUsage()` 差分、ffmpeg 子プロセスの CPU（`/proc/<pid>/stat` の utime+stime 差分）、`process.memoryUsage().rss` + ffmpeg の RSS（`/proc/<pid>/status`）
- コンテナの vCPU 上限に対する使用率へ換算して集計（p50 / p95 / max）
- `mixer.stats()`（underruns / gapFrames / clockDriftMs）と ffmpeg `-progress`（`fps` / `drop_frames` / `speed`）を同じ時系列に併記

### 5.3 `/loadtest` レスポンス

```json
{
  "n": 5, "durationSec": 600, "instanceType": "<wrangler.jsonc の値>",
  "cpu": { "p50": 0.42, "p95": 0.61, "max": 0.74 },
  "rssMaxMiB": 512,
  "mixer": { "underruns": 0, "clockDriftMsMax": 18 },
  "ffmpeg": { "dropFrames": 0, "speedMin": "1.0x" }
}
```

---

## 6. 実行手順

```bash
# 0. 対象インスタンスの確定:
#    CF Containers の現行 instance_type 一覧（vCPU/メモリ/ディスク）を公式ドキュメントで確認し、
#    wrangler.jsonc に明示する。knowledge 記録（beta 時点 0.5 vCPU / 4GiB）は古い可能性があるため
#    必ず現行値で上書き確認する。
npx wrangler deploy

# 1. N を段階的に上げて計測（各 10 分。YouTube 配信枠は使い回し）
for n in 1 2 3 5 8; do
  curl -m 700 "https://poc-udp-spike.<subdomain>.workers.dev/loadtest?n=$n&durationSec=600"
done

# 2. N_target で本判定（10 分 × 2 回。再現性確認）
curl -m 700 ".../loadtest?n=<N_target>&durationSec=600"

# 3. 合成負荷の妥当性確認: 実 VC に 2〜3 人入り PoC-2 の /mixtest を 10 分実行、
#    同時刻の CPU を /loadtest?n=2〜3 の結果と比較する。乖離が大きい（目安 ±20% 超）なら
#    合成方法（フレームサイズ・デコーダ構成）を見直して再計測する。

# 4. 30 分完走: 合格した N_target 構成で durationSec=1800 を 1 回（配信 1 回分の実証）
```

---

## 7. 判定と分岐

| 結果 | 意味 | 次アクション |
|---|---|---|
| N_target で合格 | 基盤・構成が最終確定 | §8 でコスト上限 n を算出し **PoC 完了 → 本実装へ**（構成スキーマ・制御プレーン） |
| CPU 飽和で欠落（エンコードが支配的） | 静止画エンコードが重い | エンコード設定を下げて再計測: fps 15→10、`-preset ultrafast`、解像度 1080p→720p の順（spec §5.2 の既定を更新し、画質影響を記録） |
| 設定を下げても不合格 | インスタンスが小さい | 上位の instance_type があれば変更して再計測（コストへ反映）。なければ次へ |
| インスタンス変更でも不合格 | CF Containers の性能上限 | **Fly.io（保険）で同一コンテナ・同一 /loadtest を実行**し、マシンサイズとコストを比較して基盤を再判断（mvp-spec §9 の比較表を発動） |

CPU 曲線から支配項を切り分ける: N を増やしても CPU がほぼ増えない → エンコード支配（設定調整が効く）。N に比例して増える → デコード/ミックス支配（人数側の制約。N の上限として記録）。

---

## 8. 結果記録様式

### 8.1 負荷曲線

| N | instance_type | CPU p50/p95/max | RSS max | underruns | drop_frames | 判定 |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 5 | | | | | | |
| 8 | | | | | | |
| **N_target =** | | | | | | **合否** |

実 VC 突き合わせ（§6-3）: 実測 N=___ の CPU ___ vs 合成 N=___ の CPU ___（乖離 ___%）

### 8.2 コスト上限 n の算出（会社要件・spec §9.3）

- 確定インスタンス: `instance_type = ___`（vCPU ___ / メモリ ___）
- 月間稼働: 配信 ___ 回 × (30 分 + provisioning 実測 ___ 分) = ___ 時間/月
- 単価: **現行の Cloudflare Containers 料金ページの値を算出時に参照**（vCPU 秒・GiB 秒・egress。記憶や過去調査の値を使わない）
- **月額上限 n = ___ 円**（+ Workers Paid 基本料）。`mvp-spec.md` §9.2 の「別途要算出」をこの値で置き換える

---

## 9. リスク・注意点

- **N_target 未確定のまま走らせない**。合格の定義が決まらず「なんとなく大丈夫そう」で終わる（crisp な合否の原則、poc-plan §0）。
- **「常時全員発話」は最悪ケースの意図的な過大評価**。実運用は発話が交代するため実 CPU はこれより低い。合格判定が保守的になる分には安全側なので、この模擬でよい。
- **`instance_type` / 料金は変動領域**: knowledge の記録（beta 時点 0.5 vCPU / 4GiB）とこの仕様書の値をそのまま信じず、実施時に現行公式ドキュメントで確認する。
- **測定系のオーバーヘッド**: metrics サンプリングは 1 秒間隔に留める（それ自体が CPU を食う測定の汚染を避ける）。
- **`sleepAfter`**: 10 分 × 複数回の間に寝ないよう PoC-1/2 と同様に一時的へ引き上げ、終了後戻す。
- **YouTube 側レート**: 同一配信枠への接続断・再接続を短時間に繰り返すと ingest 側で弾かれることがある。N 段階の間は FFmpeg を張り直すため、試行間に 1〜2 分空ける。

---

## 10. 完了の定義（Definition of Done）

- [ ] N_target をユーザーが確定した。
- [ ] 対象 instance_type を現行ドキュメントで確認し `wrangler.jsonc` に明示した。
- [ ] §8.1 の負荷曲線（合成）と実 VC 突き合わせを記録した。
- [ ] N_target での合否が確定し、§7 の分岐のどれに進むかが決まった。
- [ ] §8.2 の月額上限 n を現行料金で算出し、`mvp-spec.md` §9.2 の「別途要算出」を更新した。
- [ ] 結果を `cloud-broadcast-poc-plan.md`（PoC-3 実施結果）へ反映した。
