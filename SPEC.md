# Kart Racer — v1 仕様（CPU 戦版）

ブラウザで遊べるカートレースゲーム。スマホと PC の両方に対応する。
マリオカート風の遊び心地にするが、キャラ・名前・ロゴ・音・アイテム名は全部オリジナル（任天堂の資産を使わない）。

## 技術
- Vite + TypeScript + three（npm）。物理ライブラリは使わず自前の簡易物理。
- GitHub Pages で公開する。`vite.config.ts` の `base` は `/kart-racer/`。
- `.github/workflows/deploy.yml` で main への push 時に build → Pages へ deploy（actions/deploy-pages）。
- 外部アセット（画像・モデル・音声ファイル）は使わない。ジオメトリは手続き生成、音は WebAudio で合成。

## 対人戦を後から足すための設計制約（必須）
- **シミュレーションと描画を分離**: `src/sim/` は three に依存しない純粋なロジック（位置・速度・向き・ラップ・アイテム状態）。`src/render/` が sim の状態を読んで描画する。
- **固定タイムステップ**（60Hz）で sim を進め、描画は補間。
- **入力は `InputFrame` 型に正規化**（`steer: -1..1, throttle: 0..1, brake: boolean, drift: boolean, useItem: boolean`）。プレイヤー（キーボード／タッチ）、CPU AI、将来のネットワーク相手、すべてが各 tick で `InputFrame` を出す同じインターフェース。
- sim 内の乱数は seed 付き PRNG（アイテム抽選など）。`Math.random` を sim で使わない。
- レース状態は JSON にシリアライズ可能に保つ。

## ゲーム内容
- コース 1 つ: 起伏とカーブのある周回コース（スプライン基準、幅のある路面、外はスピードが落ちる芝、壁/ガードレール）。スタート/ゴールライン、チェックポイントで逆走・ショートカット防止。
- カート 6 台（プレイヤー 1 + CPU 5）、3 周。スタート前に 3・2・1 カウントダウン。
- 操作感: アクセル／ブレーキ／ステア、**ドリフト**（ドリフト中に一定時間で火花の色が変わり、離すとミニターボ 2 段階）、壁に当たると減速、カート同士の押し合い。
- アイテムボックス（コース上に複数列、取ると数秒後に復活）。アイテムは 3 種:
  - ダッシュ（一時加速）
  - トラップ（後ろに置く、踏むとスピン）
  - 弾（前方に直進して当たるとスピン、壁で跳ね返り数回で消滅）
  - 順位が低いほどダッシュが出やすい。
- CPU: コースのレーシングラインを追従、適度なばらつき、アイテム使用、ラバーバンド弱め。
- HUD: 順位、ラップ数（n/3）、ラップタイム／合計タイム、所持アイテム、ミニマップ。
- 画面: タイトル → レース → リザルト（順位とタイム、リトライ）。ベストタイムを localStorage に保存（try/catch で囲む）。
- 三人称の追従カメラ（ドリフト時に少し振る）。
- サウンド: エンジン音（速度でピッチ変化）、ドリフト、アイテム取得、ヒット、カウントダウン。ミュートボタン。

## 入力
- PC: 矢印キー / WASD でステア・アクセル・ブレーキ、Space でドリフト（ジャンプ）、Shift または E でアイテム。ゲームパッド（Gamepad API）も対応できれば尚良し。
- スマホ: 横画面推奨（縦画面向けの「横にしてね」表示は v3 で削除済み）。左に仮想スティック（ステア）とその上の自動アクセル切替、右にアクセル・ブレーキ・ドリフト・アイテムボタン。マルチタッチ対応、ピンチズーム・スクロール・長押しメニューを抑止。
- 画面サイズに応じて HUD とボタンを拡縮。devicePixelRatio は上限 2 程度に制限。

## 性能
- 中級スマホで 60fps 目安。影は 1 枚の directional、ポリゴン数は控えめ。ドローコールを意識してインスタンシング等を使う。

## 見た目
- ポップなローポリ。明るい空（グラデーション）、木や岩などの装飾、カートは色違い 6 色、各カートに簡単なドライバー（球と円柱）。

## 品質
- `npm run build` が警告なしで通ること。TypeScript strict。
- `src/sim/` にユニットテスト（vitest）: ラップ計測、チェックポイント、アイテム抽選の決定性（同じ seed で同じ結果）。
- README に遊び方と開発コマンド。

## v2（8 台・オンライン・アイテム拡張）
v1 の設計制約（sim と描画の分離、固定 60Hz、`InputFrame`、seed 付き PRNG、JSON 化可能な状態）はそのまま維持する。設計の詳細は `.omc/plans/multiplayer.md`。

### 8 台
- 1 レース最大 8 台。1 人用はプレイヤー 1 + CPU 7。オンラインは人間最大 8、空いた枠は CPU。
- 順位表・リザルトは 8 行、アイテム抽選も 8 位まで。

### オンライン
- **ホスト権威**: 権威ある状態を確定するのはホストの sim（`stepRace`）。ゲストは `InputFrame` をホストへ送り、自車の表示用に同じ sim で予測するが、結果は常にホストのスナップショットで照合し直す。
- **予測**: ゲストも全カートの入力で `stepRace` を回す。描画に予測結果を使うのは自車だけで、ホストの状態で照合して補正する。他のカートは補間で描く。
- **補間**: 他のカートはスナップショットを約 100ms 遅らせて補間する。
- **スナップショット**: 20Hz（3 tick に 1 回）、バイナリ固定レイアウト、毎回フル（差分圧縮なし）。unreliable / unordered の `RTCDataChannel`。ルーム管理などの制御メッセージは PeerJS の reliable チャネル（JSON）。raw の unreliable チャネルが使えないときは、再送ありの接続（`reliable:false`、unordered）か、既存の reliable チャネルに切り替える。
- **Transport の抽象化**: セッションは `Transport` インターフェースだけに依存する。実装は `PeerJsTransport`（本番）と `MockTransport`（テスト）。
- 接続は P2P。シグナリングは公開 PeerJS ブローカー。

### アイテム（14 種）
ソニックダッシュ / ポップトラップ / リコシェボルト / ハウンドボルト / スカイコメット / トリプルダッシュ / ブレイズダッシュ / シャインオーラ / スパークストーム / インクスプラッシュ / ダミーボックス / ポップボム / ロケットライド / オービットガード。効果は README の一覧を参照。

- **順位別の抽選**: `src/sim/itemTable.ts` の重みテーブル（1〜8 位）から seed 付き PRNG で 1 回引く。重みは確率ではなく、行の合計は 100 とは限らない。上位は設置・基本系（ポップトラップ、ダミーボックスなど）、下位は強力な加速・無敵系（ブレイズダッシュ、シャインオーラ、ロケットライドなど）が出やすい。
- **防御**: トラップ・ボルト・ダミーボックス・ポップボムは、ボタンを押している間は後方に構えて盾になり、離すと展開する。ダッシュ系・オーラ・ストーム・インクは押した瞬間に発動する。
- **ルーレット**: ボックスを取ると `effects.rouletteTime` が `ROULETTE_TIME`（1.4 秒、`src/sim/items.ts`）になり、毎 tick 減る。0 より大きい間はアイテムを使えない（`holding` も 0 に戻る）。開始から `ROULETTE_STOP_DELAY`（0.3 秒）たった後（判定は `rouletteTime <= ROULETTE_TIME - ROULETTE_STOP_DELAY + 1e-9`）にボタンを押すと 0 になって止まる（早止め）。開始から 0.3 秒未満の押下は早止めにならない。どちらの押下も `previousItem` に記録されるので、押しっぱなしのまま止まっても、いったん離すまでアイテムは使われない。スパークストームで奪われると `rouletteTime` も 0 に戻る。CPU も同じ規則に従う（`itemAi.ts` は回転中は使わない）。

### プロトコルの版数とレイアウトの指紋
- `src/net/protocol.ts` の `PROTOCOL_VERSION`が版数。ルームの ID 接頭辞 `ROOM_PREFIX`（`pcircuit-v<版数>-`）にも入るため、版数が違うクライアント同士は同じルームに入れない。
- `LAYOUT_FINGERPRINT` は、スナップショットのバイナリレイアウト（`SNAPSHOT_LAYOUT`。列挙の順序とフィールドを含む）の FNV-1a32 ハッシュで、現在の版数に固定している。
- **運用**: スナップショットのレイアウトを変えたら `PROTOCOL_VERSION` を上げ、`src/net/protocol.ts` の `LAYOUT_FINGERPRINT` を更新する。版数を固定しているテストも両方更新する: `src/sim/items.test.ts` の `PROTOCOL_VERSION` の assert と、`src/net/snapshotCodec.test.ts` の指紋（版数ごとの固定値）。更新し忘れるとこれらのテスト（`npm test`）が失敗して検知する。

### プロトコル v7: スナップショットの byte 7
カートごとの効果フィールド（8 バイト、`KART_EFFECT_LAYOUT`）の byte 7 を分割する。bit 0〜1 が `orbitCount`（0〜3）、bit 2〜6 が `rouletteTime`（scale 20、0.05 秒刻みの bucket、上限 31 = 1.55 秒）、bit 7 は予約で 0 固定（立っていればデコーダが拒否する）。値は `(bucket << 2) | orbitCount`。効果バイト列の長さは v6 から増えない。v6 では byte 7 全体が `orbitCount` で、`rouletteTime` は存在しなかった（v7 で追加）。

### 制約
- 通信は PeerJS 既定の公開 STUN/TURN サーバを利用する（無償の公開サービスなので可用性は保証されない）。それでもつながらない環境がある（同じ Wi-Fi か別の回線で試す）。
- ホストは画面を閉じたり、アプリを切り替えたりしない。ホストの sim が止まると全員が止まる。iOS でホストが画面を離れて通信が止まると、ICE が `disconnected` の状態が 8 秒続いた時点、またはレース中にホストからのスナップショットが 5 秒止まった時点（ホスト喪失）で切断される。
- ホスト移譲、観戦、途中参加は v2 では扱わない。

## v3（コース 4 本）
v1・v2 の設計制約はそのまま維持する。設計の詳細は `.omc/plans/courses.md`。実装と食い違う箇所は実装を正とする。

### コース
| ID | 表示名 | 長さ（概算） | 路面特性 |
| --- | --- | --- | --- |
| `meadow` | MEADOW LOOP | 652 m | なし |
| `canyon` | SUNSCAR CANYON | 665 m | `jump` ×2 |
| `snowpeak` | FROSTBITE PEAK | 623 m | `ice` ×3 |
| `neon` | NEON NIGHTLINE | 658 m | `boost` ×1（トンネル入口） |

- 定義は `src/sim/tracks/*.ts`、登録と `getTrack(id)` は `src/sim/tracks/index.ts`（`TRACK_IDS`）。ID の型は `src/sim/types.ts` の `TrackId`。
- コース選択: 1 人用はタイトル（`src/ui/GameUI.ts`）。オンラインはホストがロビー（`src/ui/LobbyUI.ts`）で選び、ゲストは読み取り専用で見る。選択は `course` メッセージ（`{ type: 'course', trackId }`）でゲストへ送り、`race_start` と `welcome` も `trackId` を持つ。許可する ID は `src/net/protocol.ts` の `PROTOCOL_TRACK_IDS`。
- ベスト: `src/storage.ts` がコース別に保存する（キー `pocket-circuit.best.v2`、`KNOWN_TRACK_IDS` 以外は無視）。v1 のキー `pocket-circuit.best.v1` の単一記録は、v2 が無いときに MEADOW として移行する。

### TrackDef の項目
`src/sim/types.ts` の `TrackDef`。

| 項目 | 内容 |
| --- | --- |
| `id` / `name` | コース ID / 表示名 |
| `controlPoints` / `scale` / `samplesPerSegment` / `spline` | 閉じたスプラインの制御点と取り方（`spline` は `'uniform'` か `'centripetal'`、省略可） |
| `roadHalfWidth` / `wallHalfWidth` | 路面の半幅 / 壁までの半幅 |
| `checkpointCount` | チェックポイント数（全コース 12） |
| `boxRows` / `boxLanes` | アイテムボックスの列位置（弧長比率）とレーンのオフセット |
| `racingLine` | CPU が追うレーシングライン（距離とオフセットの組。空も可） |
| `surfaces` | 路面区間 `SurfaceZone[]` |
| `themeId` | 描画テーマ（`src/render/course/`） |

### 路面特性
`src/sim/surfaces.ts` と `src/sim/race.ts`。区間は弧長（`from`〜`to`）と、任意のオフセット範囲（`offsetMin` / `offsetMax`）で表す。路面は 2D のまま扱い、新しい状態は持たない（`airTime` 以外）。

- `ice`: 区間内にいる間だけ効く連続修飾。旋回率 ×0.55、ステアの追従を遅くする（係数 12 → 6）、加速 22 → 15、惰性の減速 5.5 → 1.8、ブレーキ 42 → 18。
- `boost`: `from` を前向きに跨いだ tick に 0.5 秒のブースト（`giveBoost`）。区間内に留まっている間は再発火しない。次の周や、押し戻されてから前向きに入り直したときは再び発火する。
- `jump`: `from` を前向きに、速度 10 以上で跨いだ tick に `airTime` を `JUMP_DURATION`（0.8 秒）にする。滞空中は操舵と加減速を受けず、向きと速度を保つ。高さは最大 `JUMP_HEIGHT`（2）の放物線。ドリフト状態は解除される。壁との衝突は地上と同じ。後ろ向きに跨いでも発火しない。
- `airTime` はカートの状態として JSON とスナップショットに含まれる（`/100` で量子化）。

### アイテムボックスは 12 個固定
スナップショットは `SNAPSHOT_BOX_COUNT = 12`（`src/net/snapshotCodec.ts`）の固定長なので、全コースでボックスは 12 個（`boxRows` 4 × `boxLanes` 3）。列の位置だけコースごとに変える。エンティティの上限は `MAX_SNAPSHOT_ENTITIES`（27）。

### COURSE_FINGERPRINT と版数の運用
- `COURSE_FINGERPRINT`（`src/sim/tracks/index.ts`）は、全コースの `TrackDef` を JSON にして FNV-1a32 でハッシュした値。`Hello.course` に載せて送り、ホストが自分の値と比べる。違うクライアントは参加できない。
- 現在の `PROTOCOL_VERSION` は 8。`LAYOUT_FINGERPRINT` は v7 から変わらず `f7b2a1f2`（v6 は `53ab24b2`）。`COURSE_FINGERPRINT` は v6 から変わらず、v7・v8 のコースの pin は v6 と同じ値。
- **運用**: コースデータ（`src/sim/tracks/*.ts` など `TrackDef` に入る値）を変えたら `PROTOCOL_VERSION` を上げる。そのうえで `src/net/snapshotCodec.test.ts` の 2 つの pin（版数ごとの固定値）の両方に新しい版数を追加する。コースの pin には新しい `COURSE_FINGERPRINT` を、レイアウトの pin には `LAYOUT_FINGERPRINT` を入れる（レイアウトを変えていなければ前の版と同じ値）。さらに `src/sim/items.test.ts` の `PROTOCOL_VERSION` の assert も更新する。例外は、まだ公開していない版数のままコースを作っている間だけで、その間は同じ版数の pin の値を書き換えてよい（v6 はこの方法で 4 コースを作った）。v7 はルーレットでレイアウトを変えたため、2 つの pin のうちレイアウトの pin に `LAYOUT_FINGERPRINT` の新しい値を、コースの pin に前の版と同じ値を追加した。pin テストは指紋の変化を検知するが、版数の上げ忘れまでは検知しない。公開済みの版数の pin を書き換えないこと。

## v5: ハンドリング・アシスト・壁・カメラ・プロトコル v8
`PROTOCOL_VERSION` は 8（`src/net/protocol.ts:7`）。`ROOM_PREFIX` は `pcircuit-v8-` になり、v7 以前のクライアントとは同じルームに入れない。スナップショットのレイアウトは変わらないので、`LAYOUT_FINGERPRINT` は `f7b2a1f2` のまま（`src/net/protocol.ts`）。

### 旋回（`src/sim/race.ts:189-193`）
- `turnRate = max(1.72, 2.1 - max(0, speed - 15) * 0.025) * min(1, speed / 6) * (onIce ? 0.5 : 1)`。6 m/s で最大の旋回速度に達し（v4 までは 12 m/s）、15 m/s を超えると 1 m/s につき 0.025 ずつ下がる（下限 1.72）。氷上は 0.5 倍（v4 までは 0.55 倍）。
- ドリフト中（`driftDirection !== 0`）の `turnRate` は通常時と同じ式（v4 までのドリフト専用の 1.95 は廃止）。ヨーは `steering = driftDirection * 0.75 + steer * 0.6`。通常時は `steering = steer`。`heading += steering * turnRate * FIXED_DT`。
- ドリフトのヨーが `driftDirection * 0.75` を持つので、ステアが 0 でもドリフトは曲がり続ける。`steer` が -1 のときでも、`driftDirection = 1` なら `0.75 - 0.6 = 0.15` で、向きは反転しない。
- スリップ角 `slip = driftDirection * min(0.23, driftTime * 0.35)`（`race.ts:196`）は v4 から変わらない。

### ハンドルアシスト（`src/input/assist.ts`）
- 自分の入力にだけ効く（`applySteerAssist`。予測とネットワークは補正後のフレームを使う）。`Controls` の `steerAssist` が真のときだけ強さ 1 で適用する（`src/input/Controls.ts:177`）。初期値は、設定がなければタッチ端末が ON、それ以外が OFF（`Controls.ts:127`）。
- 補正量の上限は 0.35（`assist.ts:25`、`clamp(angle * 1.6, -0.35, 0.35)`）。
- 先読み距離 `lookAhead = 10 + max(0, speed) * 0.3` m。壁際は `wallWeight = clamp(2 - (roadHalfWidth - |lateralOffset|), 0, 3)`。
- 入力の大きさ `|steer|` による減衰: `intent = (1 - 0.65 * clamp(|steer|, 0, 1)) * strongInput`。`strongInput = 1 - 0.5 * clamp((|steer| - 0.6) / 0.2, 0, 1)` で、入力 0.6 から 0.8 にかけて 1 から 0.5 へ連続的に下がる（`assist.ts:28-29`）。ドリフト中は 0.35 倍（`assist.ts:30`）。
- 逆向き（補正の向きとステア入力が逆）の上限は `cap = |steer| + |補正| * max(0, 1 - |steer| / 0.05)`（`assist.ts:35`）。つまり |入力| 0〜0.05 で連続的にかかり、|入力| が 0.05 以上なら補正が入力を打ち消して逆転することはない。
- 無効になる条件: `wrongWay`、後退（`speed < 0`）、スピン中、空中、ホップ中、ドリフト開始前の `drift` 押下、進行方向との差が 90°（π/2）以上。

### ステア感度（`src/input/Controls.ts:25-32`）
- タッチのステアにだけ効く（`touchSteerCurve`）。`sign(x) * n^gamma`。`n` はデッドゾーン `STEER_DEADZONE`（0.04）を除いて 0〜1 に戻した値。`gamma = 1 + (5 - level) * 1.2 / 4`。レベル 1 が gamma 2.2、レベル 5 が gamma 1.0（線形）。
- レベルは 1〜5 の整数で、`SENSITIVITY_DEFAULT` は 3（`src/storage.ts:7-9`）。`localStorage` のキーは `pocket-circuit.steer-sensitivity.v1`、アシストは `pocket-circuit.steer-assist.v1`（保存がなければ端末の既定に従う）。UI は `#sens-title` / `#sens-pause`、`#assist-title` / `#assist-pause`。

### 壁（`collideWall`、`src/sim/race.ts:92-127`）
- 壁にめり込んだ分だけ押し戻し、そのたびに再射影する（最大 4 回。曲がった区間で最も近い線分が変わっても、めり込みを残さない）。
- 速度の損失は壁との入射角で決まる。角度 `angle = atan2(outward, tangent)`、`blend = clamp((angle - π/9) / (2π/9), 0, 1)`、`speed *= 1 + (tangent - 1) * blend`。入射角 20°（π/9）以下では減速せず、60°（π/9 + 2π/9 = π/3）以上で従来どおりの接線成分ぶんの減速になり、その間は連続的につなぐ。

### カメラの先読み（`src/render/cameraLookAhead.ts`）
- `LOOK_AHEAD_DISTANCE = 22` m 先のコース接線との角度（`trackTurn`）に 6 m/rad（`LOOK_AHEAD_GAIN`）を掛けた分だけ、注視点をカーブの内側へずらす。上限は `LOOK_AHEAD_MAX = 3.5` m。
- `alignment`（車の向きとコース接線の内積）が 0.3 以下なら 0、0.3 から 0.7 にかけて 0 から 1 へ増える（`fade = min(1, (alignment - 0.3) / 0.4)`）。逆走・横向きでは効かない。
- `prefers-reduced-motion: reduce` のときは常に 0（`lookAheadOffset` の `reducedMotion`）。`GameRenderer` が起動時に一度だけ読む。

### E2E（`e2e/handling.spec.ts`）
アシスト ON・無操作の 8 秒で壁に張り付かないこと、感度スライダーがリロード後も残ること、reduced-motion でカメラの先読みが 0 になること（通常時は 0 より大きいことも確認）を検証する。
