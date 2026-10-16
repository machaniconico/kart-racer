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
- 現在の `PROTOCOL_VERSION` は 9（`src/net/protocol.ts:7`）。`LAYOUT_FINGERPRINT` は v7 から変わらず `f7b2a1f2`（v6 は `53ab24b2`）。`COURSE_FINGERPRINT` は v6〜v8 が同じ値（1575332991）で、v9 で変わり 1138653990（`src/net/snapshotCodec.test.ts:563`）。
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

## v6: コース複雑化 M1（プロトコル v9）
`PROTOCOL_VERSION` は 9（`src/net/protocol.ts:7`）、`ROOM_PREFIX` は `pcircuit-v9-`。`LAYOUT_FINGERPRINT` は `f7b2a1f2` のまま（スナップショットのレイアウトは変えていない。`protocol.ts:12`）。変わったのはコースデータなので `COURSE_FINGERPRINT` の pin が 1138653990 になった。

### データ形式（`src/sim/types.ts`）
| 項目 | 型・意味 |
| --- | --- |
| `TrackDef.widthKeys?` | `{ distance, roadHalfWidth, wallHalfWidth }` の列。周回距離（m）で昇順。区間は線形補間し、最後と最初の対も 1 区間（継ぎ目）として扱う。無ければ定義の `roadHalfWidth` / `wallHalfWidth` を使う（`widthAt`、`corridor.ts`）。`types.ts:91-95` |
| `TrackDef.barriers?` | 帯（路上の障害物）の列。`{ from, to, center, halfWidth, taper?, motion?, scenery? }`。`taper` の既定は 4 m。`scenery` は `pillar` / `rock` / `building` / `block`。`types.ts:97-112` |
| `TrackDef.layoutVersion?` | コースの配置の版数。無ければ 1。ベストタイムの有効判定に使う（後述）。`types.ts:143` |
| `SurfaceZone.kind` | `ice` / `boost` / `jump` に加え `dirt` / `pit` / `spin` が増えた（`types.ts:120`）。 |

- `dirt` は `from`〜`to`（周回距離）と、任意の `offsetMin` / `offsetMax`（無ければ `±roadHalfWidth(d)`）で範囲を決める（`src/sim/surfaces.ts:13-16`）。氷が重なれば氷が優先（`surfaces.ts:23-27`）。
- `pit` / `spin` は型と描画の色（`src/render/course/buildCourse.ts:119`）だけで、M1 のシミュレーションには効果がない（予約）。

### 不変条件と検証規則（`validateTrackDef`、`src/sim/corridor.ts`）
- 横勾配: `widthKeys` の隣り合うキーで、`roadHalfWidth` と `wallHalfWidth` の差は区間長 × 0.35 以下（継ぎ目も含む。`corridor.ts:154-156`）。
- テーパー: `taper` は 2 m 以上、`halfWidth > 0` かつ `halfWidth / taper ≤ 0.5`。`scenery` が `rock` / `building` の島は `taper` 8 m 以上（`corridor.ts:173-178`）。
- 曲率半径: 中心線の曲率半径は `wallHalfWidth(d) + 2.5` 以上（継ぎ目も含む）。`validateTrackDef` ではなく `src/sim/tracks/tracks.test.ts:116-125` が検査する。
- 通行幅: どの距離でも、帯を除いた空き区間のうち 1 つは幅 `2R + 0.6` 以上（`R = KART_RADIUS = 0.95`、つまり 2.5 m。`corridor.ts:6-7,214-215`）。検査点は 0.5 m 刻みに、キー・帯の端・レーシングラインの点を足したもの（`corridor.ts:212-217`）。
- レーシングライン、スタート格子の 8 枠、アイテムボックスの列は、帯の除外領域の外にあること（`assertFree`）。ゲートは帯の鼻から 10 m を超えて離すこと（`corridor.ts:219-226`）。
- 押し出しの上限（70 m/s、1 tick）: 横 0.59 m、縦 1.17 m（`src/sim/walls.test.ts:246-268, 299-300`。縦は 70 / 60 ≒ 1.17 m の 1 tick 分の移動で、`race.ts:149` の注記）。

### 衝突の仕様（`collideCorridor`、`src/sim/race.ts:97-209`）
- 外壁（`collideWall`）を先に処理し、そのあと帯を処理する。帯は半円の鼻と、テーパー部の除外幅 `half(d) + R` で表す（`corridor.ts:48-65`）。
- **正面当たり**: 前 tick の位置からの直線を二分探索して、帯に入った点（入口）を求める。高速で鼻（奥行き R = 0.95 m）を飛び越えても、正面の当たりとして扱い、入口の法線で押し出す（`race.ts:104-127`）。押し出しは 1 tick の移動量を超えない（`race.ts:146-157`）。
- **横寄せ**: 帯に入っていない状態から横にずれて入った場合は、利用できる空き区間のうち最も近いものへ横に寄せる（最大 4 回。`race.ts:160-182`）。
- **入射角の応答**: 外壁と同じで、入射角 20° 以下は減速なし、60° 以上で接線成分ぶんの減速、その間は連続（`race.ts:204-207`）。
- **向き**: 入射角が 80°（`4π/9`）を超える帯の当たりでは、向きを変えない。垂直に近い細い接線へ向けると、横向きになり、次のレール接触で後ろ向きに反転するため（`race.ts:206-208`）。外壁は従来どおり向きを変える。
- **hit イベント**（`race.ts:195-202`）:
  - 条件は `speed * inward > 4`、かつ `hitCooldown === 0`（クールダウン 0.7 秒）。
  - 例外: 帯への当たりで、入射角 60°（`π/3`）以上、かつ速度が 6 m/s 超なら、クールダウン中でも hit を出す。外壁に沿って走って鼻へ当たったとき、無音で止まるのを避けるため。速度 6 m/s の下限は、正面で止まったあとの小さな押しが連続して hit を出さないようにするためで、クールダウンに従う。
  - `value`: 帯の hit は `value: 1`。**外壁の hit は `value` を持たない**（設計では `value: 0` だったが、v8 までの golden（イベントの JSON）を変えないため、従来どおり `value` なしにした）。受け取る側は `value` が無い場合を 0 と読む。
- 既知の限界（M2 以降）: hit の出し方は速度だけで決まり、「同じ鼻への再接触」と「新しい正面衝突」を区別できない。ブースト中に 40 m/s で当たると hit が 2 tick 続けて出ることがあり、外壁のクールダウン中に 6 m/s 以下で新たに帯へ正面から当たっても hit は出ない。効果音・演出と統計にだけ影響し、物理（速度・位置・貫通）には影響しない。直すには「最後に当たった帯」の状態をスナップショットへ足す必要がある。

### ダート（`src/sim/race.ts:293-319`）
- 路面は `surfaceAt`（`surfaces.ts:23-27`）が `ice` > `dirt` > `road` の順で返す。
- 速度の上限は 20 m/s。ブースト中は例外で 26 m/s（草地と同じ構造。草地はブーストなしで 14 m/s、ブースト中は 26 m/s。`race.ts:304-306`）。上限は常に守られる。
- 加速は 16（通常 22、氷 15、草 13。`race.ts:311`）。上限に達していると加速 0（上限で全開にしても行き過ぎない。`race.ts:310`）。
- 旋回は × 0.85（氷は × 0.5。`race.ts:319`）。
- CPU は前方がダートだと、速度が 21 m/s を超えるときにブレーキを使う（`src/sim/ai.ts:23,44`）。

### 周回判定（`src/sim/laps.ts:28-38`）
ゲートの判定幅は固定値ではなく、ゲートの距離での `widthAt(track, distance).wallHalfWidth`。狭路の中にゲートがあっても、通過判定の幅は壁の位置と一致する。ゲートは帯の鼻から 10 m を超えて離す（検証規則）。

### 弾の帯反射（`src/sim/items.ts:398-480`）
- 帯のあるコース（`barriers.length > 0`）だけが新しい処理を通る。帯のないコースは従来のレールの計算のまま（`items.ts:403`）。
- 弾が帯の中に入ったら、帯の縁の法線に沿って外へ出し（`barrierEscape + 0.05`）、`bolt` は法線で鏡映する。壁も同様（`items.ts:429-457`）。
- `bounces` は、実際に鏡映したときだけ数える。すでに離れる向きの `bolt` が補正で動いても、4 回の上限を使わない（`items.ts:427-433`）。4 回に達した `bolt` は消える（`items.ts:480`）。
- どうしても自由な区間へ出せない弾は、寿命を 0 にして消す（`items.ts:474-478`）。

### CPU とアシストの帯対応
- **CPU**（`src/sim/ai.ts:38-42`）: 帯があるコースでは、先読み位置の空き区間の幅が `2 * (KART_RADIUS + 1)`（3.9 m）より狭く、かつ目標との誤差が 0.3 を超えると `narrowAhead` としてブレーキを使う。
- **アシスト**（`src/input/assist.ts`）: 補正量の上限は従来どおり 0.35（`assist.ts:174`）。帯が 3 つの先読み（`HORIZON = 3`）以内にあるときだけ新しい処理を通る。目標は経路の通過可能性で選ぶ。
  - 候補はカートの自分の線（世界座標でまっすぐ）に、一定の横加速度 `c * AUTHORITY / speed`（`AUTHORITY = 0.4`、`c` は `PATH_FAMILY` の 9 通り: 0, ±0.25, ±0.5, ±0.75, ±1）を足した 9 本の経路（`assist.ts:10-16`）。通過可能は、全ての帯と壁の限界から `PATH_MARGIN = 0.3` m 離れていること。
  - ① 自分の線が通れるなら補正しない（まっすぐ前を向く。`assist.ts:109-112`）。② 自分の線が壁にだけ当たり、カートがまだ壁際にいないなら、現在の横位置を保つ（従来の接線追従。`HOLD_REACH = 3`。`assist.ts:114-128`）。③ それ以外は、通れる経路のうち |c| が最小のものを選ぶ（ステア側を優先。`assist.ts:130-138`）。
  - 介入しない条件: 通れる経路が 1 本もないときは `aim: null` で、フレームをそのまま通す（`assist.ts:134`）。
  - 柱の区間では中央に寄せず、自分の線を保つ。壁は経路の選択では見ない（壁を避ける経路を優先すると、OFF より悪くなったため。`assist.ts:130-131`）。
  - 既知の限界: カーブに帯が 2〜3 本密集する配置や、斜めに進入する配置では、ON が OFF より帯に当たることがある（別シードのファズで 0.3%、8/2400、帯が密集した配置で 17/3200、帯 1 本では 0。許容は 1%）。いったん補正して `aim: null` に切り替わると、変わった軌跡のせいで接触が増える例もある。カートの動きの予測を正確にすれば改善できる。帯のある区間で 1 フレーム約 66µs。

### 描画と性能の基準値
M1-04 の実装前に測った値（Chromium、1280×720、DPR 1、デスクトップの影あり、`createRace(127, { trackId })`、停止した 8 台、`GameRenderer.update` を 10 回描画して全フレームが同じ値。`renderer.info.render` の値で影を含む。`src/render/course/buildCourse.test.ts:12-22`）。

| コース | drawCalls | triangles | meshes（`buildCourse` のみ） |
| --- | --- | --- | --- |
| MEADOW | 123 | 41530 | 29 |
| CANYON | 128 | 46784 | 33 |
| SNOWPEAK | 125 | 41810 | 33 |
| NEON | 125 | 66080 | 30 |

- 予算（`e2e/courses.spec.ts:40-43`）: drawCalls は基準値 + 20 以下、かつ 200 以下。triangles は基準値 + 15000 以下。`meshes` は基準値 + 2 以下（`buildCourse.test.ts:457`）。
- 実機計測の手順: `npx playwright test -c e2e/vite.e2e.config.ts e2e/courses.spec.ts`（コースを選んで開始し、8 台が停止している間に完成した WebGL のフレームを 5 回サンプリングして、上の予算で検査する。結果はテストの添付 `draw-calls` に JSON で残る）。M1 の実装後の値は、この添付で確認する（この節には実装前の基準値だけを固定する）。
- 幅キーがあるとコース全周にサンプルが入り、neon は約 +12.7k 三角形になる（幅が変わる区間だけに絞る余地がある。M1-04 のレビューの記録）。

### ベストタイム v3（`src/storage.ts`）
- `localStorage` のキーは `pocket-circuit.best.v3`。値は `{ [コース ID]: { time, layout } }`。`layout` は `TrackDef.layoutVersion ?? 1`（`storage.ts:1-3,20,88-103`）。
- `loadBest(trackId, layout)` は、保存された `layout` が引数と一致するときだけ時間を返す。一致しないコースのベストはリセットされ（`null`）、表示されない（`storage.ts:89-95`）。古いレイアウトの記録は上書きされるまで残るが、読まれない。
- v3 が無いときは、v2（v1 から移行したもの）を `layout: 1` として一度だけ取り込む（`storage.ts:76-85`）。
- 呼び出し側は `getTrack(course).def.layoutVersion ?? 1` を必ず渡す（`src/main.ts:76,204,215,223,226`）。

### CANYON の新レイアウト（`src/sim/tracks/canyon.ts`、`layoutVersion: 2`）
- **狭路**: 距離 190〜270 m。`widthKeys` は 190 m で道幅 7.2 / 壁 10.5、210 m〜250 m で 4.0 / 7.3、270 m で 7.2 / 10.5 に戻る。入口と出口に 20 m の傾斜（横勾配は 3.2 / 20 = 0.16 で 0.35 以下）（`canyon.ts:21-26`）。
- **ダート**: 500〜550 m の 50 m（`{ kind: 'dirt', from: 500, to: 550 }`、`canyon.ts:45`）。
- **柱 2 本**（中央 `center: 0`、`halfWidth: 1.2`、`taper: 4`、`scenery: 'pillar'`。`canyon.ts:28-31`）: 136〜152 m と 361〜377 m。最初の 100 m、アイテム列、ジャンプの着地、ゲートを避けて置いた。柱 1 は、アイテム列から 8 m 以上離すために 136〜152 m にした。
- レーシングライン: 柱 1 では左（−4.5）を保ち、柱 2 のために 320〜340 m で早めに左へ寄せる（`canyon.ts:36-41`）。
- **CPU のラップ**（`src/sim/handling.test.ts:110-125`。CPU 8 台、シード [1, 42, 98765]、各 3 周、72 周の平均。darwin-arm64）:

| レイアウト / プロトコル | 平均ラップ（秒） | 外壁ヒット | 帯ヒット | 帯の予算 |
| --- | --- | --- | --- | --- |
| 1 / v7（旧） | 18.825925925925926 | 0 | 0 | 0 |
| 2 / v9（新） | 21.48611111111111 | 0 | 0（シードごとの合計は [0, 0, 0]） | 2 |

  - 基準値の表（`BASELINE`）は、コースのデータを変える story だけが書き換えてよい。ラップ比の上限は 1.05（`handling.test.ts:184`）。他の 3 コース（meadow 18.5097、snowpeak 18.0572、neon 18.2486）は v7 の値のまま。
  - 柱 1 は 2 回目の修正で 136〜152 m に移し、狭路も 20 m 後ろへずらした（アシスト走行での接触を減らすため）。

### プロトコル v9 と pin の運用
- マイルストーン（コース複雑化の M1 など）の先頭で `PROTOCOL_VERSION` を一度上げ、そのマイルストーンの間は同じ版数の pin を書き換えてよい（未公開の版数。上の「COURSE_FINGERPRINT と版数の運用」の例外）。v9 は M1 で 4 コース分のデータを変え、コース pin は 1138653990、レイアウト pin は `f7b2a1f2`（`snapshotCodec.test.ts:537,563`）。
- `src/sim/items.test.ts` の `PROTOCOL_VERSION` の assert も 9 に更新する。公開したあとの版数の pin は書き換えない。

## v6: コース複雑化 M2（分岐・落とし穴、プロトコル v10）
M1 の帯・幅キーに、周回の途中で道が 2 本に分かれる「島」（分岐）と、ジャンプで越える落とし穴（`pit`）を足した。内側は短いが、ブーストを踏んでジャンプしないと穴に落ちる近道。外側は舗装で安全だが遠回り。

### データ形式（`src/sim/types.ts`）
| 項目 | 型・意味 |
| --- | --- |
| `TrackDef.splits?` | `SplitSection` の列。`{ name?, from, to, lanes }`。`lanes` は `{ offsetMin, offsetMax, risk: 0 \| 1 }` の列で、`risk: 1` が近道（落とし穴のある側）、`0` が安全側。`types.ts:113-118` |
| `SurfaceZone.kind: 'pit'` | `from`〜`to` と任意の `offsetMin` / `offsetMax` で範囲を決める。M1 では予約だったが、M2 で効果が付いた（後述）。 |
| `SurfaceZone.kind: 'jump'` | 任意の `offsetMin` / `offsetMax` で横範囲を絞れる（無ければ `from` での路面幅。`corridor.ts` の `zoneOffsets`）。 |
| `SurfaceZone.kind: 'dirt'` / `'boost'` | 同じく `offsetMin` / `offsetMax` で片側レーンだけに置ける。 |

### `islandSplit`（`src/sim/tracks/features.ts`）
島 1 つ分の `widthKeys`・`barriers`・`splits` をまとめて返すヘルパ。`from`, `to`, `islandHalf`, `laneWidth`, `scenery`（`rock` / `building`）, `taper`, `risky`（`inner` / `outer`）, `bend` を受ける。
- 島の帯は `from + R` 〜 `to - R`（`R = KART_RADIUS`）、`center: 0`、`taper = max(8, 2 * islandHalf, 指定値)`。
- 各レーンは `innerEdge = islandHalf + R` から `wide = innerEdge + laneWidth` まで。`laneWidth` は島の胴体部の自由幅で、テーパー部ではレーンが広がる。
- 幅キーは 4 個: `from - 20`（進入幅 `max(3.6, wide - 7)`）、`from` と `to`（`wide`）、`to + 20`（進入幅）。20 m のランプで横勾配 0.35 を超えないよう、島が広いほど進入幅も広げる。
- 入力が不正なら `RangeError`: 有限でない値、`from < 20`、`islandHalf <= 0`、`laneWidth < 2R + 1.6`（3.5 m 未満）、鼻とテーパーが `to - from` に収まらない。
- 手書きのコースでも島の起点は `split.from` に帯の鼻先を合わせる必要がある（幅 0 の除外が区間を割ることに依存する）ので、`islandSplit` を使うこと。

### 落とし穴（`pit`、`src/sim/race.ts:392-408`）
- **発火条件は 2 つ**（地上のときだけ。`airTime > 0` の間は判定しない）:
  1. 前 tick が地上で、今 tick に pit の入口を前向きに跨いだ（`crossedZone`）。
  2. 前 tick が空中で、今 tick に pit の内側へ着地した（`insideZone`）。
- 「pit の中にいる間ずっと」は発火しない。穴で止まったカートが再び罰を受けないため。ジャンプで越えれば `to` の先に着地して発火しない。
- **罰**: `speed = min(speed, 3)`、`spinTime = 1.0`、`hit` イベント `value: 2`。pit のあるコースだけがこの処理を通る。
- `value: 2` 専用の演出は作っていない（後回し）。受け取る側は `hit` として扱う。
- 罰は全コース共通で、強さを変えたいときは別 story とする（`spinTime` 1.6〜2.0 s の案あり）。

### CPU のレーン選択（`src/sim/itemAi.ts` の `splitLane`）
- 分岐の手前 35 m（`LANE_APPROACH`）から、選んだレーンの中心へ寄せる。島の鼻を跨がないよう、自分のいる側から寄せる。
- 近道を選ぶ式: `(id + lap + floor(aiPhase * 3 / 2π)) % 3 === 0`。期待値は約 33%（受け入れ基準 25〜45%）。当初案の `(id + lap) % 3 === 0 || sin(aiPhase + lap) > 0.6` は期待 53%（実測 61%）で基準を超えたため変更した。
- **順位を使わない**: 周回中に順位が入れ替わるため、順位でレーンを決めると、分岐に近づく間にレーンが反転する。状態も増やさず、`id`・`lap`・`aiPhase` から決定的に決まる。
- 分岐区間がスタートラインを跨ぐと途中で `lap` が変わり、レーンが入れ替わりうる。CANYON は該当しない。跨ぐ配置は作らない（M5 / M6 で検証規則に追加する）。

### 検証規則（`src/sim/corridor.ts`）
`validateTrackDef`（形式の検証）と `validateCoursePlayability`（登録 4 コースだけの配置規則）に分かれる。後者は `validateTrackDef` から呼ばれず、`tracks.test.ts` と `corridor.test.ts` の `validateAll`（両方を呼ぶ）が登録コースに対して検査する。
- **検証点の修正**: 通行幅の検査点は、0.5 m 刻みに、キー・帯の端・レーシングラインに加え、帯の端点とレーン幅の交点を足す。サンプルの間にある谷を見逃さないため（M1 の既知の限界の解消）。pit は、幅キーが道の縁を線形に変える区間で、鼻のミンコフスキー和の極値（`s = R·m/√(1+m²)`）も検査点に足す。
- **スタート格子**: 8 枠それぞれから 100 m 先までに、帯の除外領域がないこと（`validateCoursePlayability`）。
- **アイテム列**: ボックス列は帯の除外領域から 8 m 以上離すこと（同上。M1 の「帯の外」から 8 m の余裕に強化）。
- **jump**: 踏切の 10 m 手前から 40 m 先までに、横方向に重なる帯の鼻がないこと（同上）。
- **分岐**（`splits`）:
  - 2 レーン以上、各レーンの幅は `2R + 0.6 + 1.0`（4.5 m）以上。
  - 区間内のどの点でも、自由区間の数がレーン数と一致し、各レーンが別々の自由区間に収まる。
  - `split.from` の手前 35 m は自由区間が 1 つ（分岐の合流・進入が一本道）。
  - 島（`rock` / `building`）の帯は、1 つの分岐区間に完全に含まれること。
- **pit**:
  - `jump.from` の 4〜12 m 先に pit の入口があり、pit の横範囲全体を、その jump の横範囲が覆うこと。
  - クリア速度 `(pit.from - jump.from + pit の長さ) / 0.8` が 15〜26 m/s（飛行 0.8 s で越える速度）。
  - 帯の除外領域と重ならないこと、チェックポイントのゲートを含まないこと。
- 既知の限界: 島の曲率（外側半幅が曲率半径を超えると内側レーンが自己交差する）は未検査。`laneWidth ± 0.1` は胴体部のみ。M5 / M6 のコース設計時に追加する。

### アシスト（`src/input/assist.ts`）のファズ基準
`assist.island.test.ts`。シナリオごとに 500 件、固定シード 3 組（`0x1514d` / `0x1514f` / `0x2050e`）。ON が OFF より帯に当たる悪化の件数を数える。

| シナリオ | 基準 | 実測（500 件） |
| --- | --- | --- |
| 島 1 つ・直線 | 悪化 0 | 0 |
| 島 1 つ・カーブ | 悪化 0 | 0 |
| 帯が密集 | 3% 以下 | 2 / 500 |
| 鼻への進入（正面当たり） | 0 | 100 / 100 が回避 |

- 別シード 3 組（各 1600）の確認では、島カーブで 2/800 が悪化（全体 2/6400、約 0.03%）。いずれも steer −0.3・36 m/s・半径 40 m の、物理的に回り切れない条件。直線と鼻は全シードで 0、密集は全シードで 3% 以内。
- 鼻への進入は、レーン幅 6〜9 m・split 手前 40〜55 m が前提。レーン幅 4.5 m 前後では助走路が 3.6 m に狭まり、`from + 10` で鼻の内縁に 0.03〜0.4 m 届かない例が約 0.2%（正面当たりは 0）。レーン幅 6 m 未満の島を作るときは再検証する。
- `assistPassage` の省略可能な第 5 引数 `throttle`（既定 0）で、島の近くでは自分の線の予測にステア曲率と全開加速を含める。
- 時間予算: 800 件 / シナリオだと計 39〜44 秒かかったため 500 件に減らし、`assist.island.test.ts` に分けて並列に走らせる。

### CANYON の新レイアウト（`src/sim/tracks/canyon.ts`、`layoutVersion: 3`）
- **島**: 468〜543 m（75 m）。`islandSplit({ from: 468, to: 543, islandHalf: 6, laneWidth: 9, … })`。外側レーンは舗装、内側レーンが近道（`risk: 1`）。
- 内側レーンの配置（`split.from` からの相対）:

| 要素 | 範囲 | 備考 |
| --- | --- | --- |
| dirt | +32〜+50 | 内側のみ。踏切までダートを延ばした（路面で再加速すると踏切が速すぎるため） |
| boost | +42〜+46 | ダートの上。無ブースト踏切 20 m/s、ブースト 26 m/s |
| jump | +50〜+54 | 内側のみ |
| pit | +56〜+70.8 | jump の 6 m 先。クリア速度 (6 + 14.8) / 0.8 = 26 m/s で、ブーストが要る |

- **得失**（CPU 無しの計測、`corridor.test.ts` / `tracks.test.ts` / `handling.test.ts`）: 内側レーンの成功は外側より 0.450 s 速い（許容 0.4〜2.0 s）。pit に落ちると外側より 1.566 s 遅い。
  - 落下時の遅れの基準は、当初「2.5 s 以上」だったが「1.5 s 以上」に緩和した。pit の罰（speed ≤ 3、spinTime 1.0 s、0 → 32 m/s を約 19.9 m/s² で再加速）では、成功時比で最大約 2.0〜2.3 s しか失わず、成功の短縮 0.4 s を足した 2.9 s に届かない。罰は全コース共通なので変えていない。
  - 両側とも余裕は約 0.05 s。sim や配置を変えると割れうるので、M5 で CANYON を作り直すときに再調整する。
- 狭路・ダート・柱は M1 のまま（柱 2 本、狭路 190〜270 m）。M1 のダート 500〜550 m は島の内側ダートに置き換わった。
- アシストの無入力周回（`assist.test.ts`）: 全開 36.6 m/s・無入力で、レーン壁と出口ランプに 1 スロットあたり 1〜2 回触れる（443〜573 m）。島・柱・pit には触れない。テストは「帯ヒット 0、pit 落下 0、split ±40 m の外で壁ヒット 0、窓内の壁ヒット 2 以下」。E2E（M1-06）も同じ「split ±40 m で壁ヒット 2 以下」に合わせた。

### BASELINE（`src/sim/handling.test.ts:112-136`）
CPU 8 台、シード [1, 42, 98765]、各 3 周、72 周の平均。darwin-arm64。ラップ比の上限は 1.05（変更なし）。

| レイアウト / プロトコル | 平均ラップ（秒） | 外壁ヒット | 帯ヒット | pit 落下 |
| --- | --- | --- | --- | --- |
| 1 / v7（M1 の前） | 18.825925925925926 | 0 | 0 | - |
| 2 / v9（M1） | 21.48611111111111 | 0 | 0 | - |
| 3 / v10（M2） | 20.094907407407405 | 0 | 1（上限 4） | 0 / 24（近道を選んだ通過） |

- 帯ヒット 1 件は、シード 98765 の 135 m で、アイテムのスピンが柱 1 に当たったもので、島ではない。
- 近道は 24 通過、安全側は 48 通過（8 台すべてが両方のレーンを走った）。
- 他の 3 コースは v7 の値のまま。`BASELINE` は、コースのデータを変える story だけが書き換えてよい。

### 描画のメッシュ予算（`buildCourse.test.ts:480,566-570`）
- 基準値は M1 の表（MEADOW 29 / CANYON 33 / SNOWPEAK 33 / NEON 30）のまま。メッシュ数の上限は「基準 + 2」。島のあるコース（`rock` / `building` の帯を持つ）は**「基準 + 2 + 5」**。
- CANYON は島の内側のブーストパッドに貼るデカールが 1 つ増えるため、実測は **40** メッシュ（基準 33 + 2 + 5 に 1 を足した値）。
- この 5 は島 1 つ前提。分岐が 2 つ以上、または `rock` と `building` が混在すると +7 になる。M5 / M6 で予算を再定義する。
- 既知の限界: 看板は景物のない split だけのコースでは出ない（早期 return）。pit 上のデカールが穴に浮く、穴の縁に側壁がない、島の先細り部の景物が細い針状になる、ミニマップの継ぎ目と分岐入口の線切れ。

### プロトコル v10 と pin
- `PROTOCOL_VERSION` は 10、`ROOM_PREFIX` は `pcircuit-v10-`。`LAYOUT_FINGERPRINT` は `f7b2a1f2` のまま（スナップショットのレイアウトは変えていない）。
- `COURSE_FINGERPRINT` の pin は **574910572**（`snapshotCodec.test.ts:565`）。v9 の 1138653990 からの変更は CANYON のデータ（島・dirt・boost・jump・pit・`layoutVersion: 3`）による。
- 運用は M1 と同じ。M2 の間は v10 の pin を書き換えてよい（未公開の版数）。`items.test.ts` の `PROTOCOL_VERSION` の assert も 10 に更新する。公開したあとの版数の pin は書き換えない。

## v6 M2.5（全コースの横幅 +30%、プロトコル v11）
ユーザーから「コースをもっと広くしたい。30%」と依頼があり、4 コースの横方向の寸法を 1.3 倍にした。同じカートにとっての余裕を増やすのが目的で、コースの長さと形は変えない。定数は `src/sim/tracks/widths.ts`（`WIDTH_SCALE = 1.3`）。値はリテラルで、積を実行時に計算しない（プラットフォーム間でコースのデータを一致させるため）。

### 広げるもの・広げないもの
| 区分 | 項目 | 旧 → 新 | 理由 |
| --- | --- | --- | --- |
| 広げる | 路面の半幅 `BASE_ROAD_HALF_WIDTH` | 7.2 → 9.36 | 依頼の本体 |
| 広げる | 壁の半幅 `BASE_WALL_HALF_WIDTH` | 10.5 → 13.65 | 路面と壁の差（3.3 → 4.29 m）も 1.3 倍に保つ |
| 広げる | CANYON の狭路（road / wall） | 4.0 / 7.3 → 5.2 / 9.49 | 「道幅が約半分」の比を保つ。`MIN_PASSAGE` 2.55 m を上回る |
| 広げる | 島のレーン幅 `laneWidth` | 9 → 11.7 | 路面が広がったので、島の外側の壁も追従させる |
| 広げる | ボックス列 `boxLanes` | ±4.1 → ±5.33 | 路面に対する位置を保つ |
| 広げる | CPU のレーシングライン | 例 CANYON −4.5 → −5.85 | 路面に対する位置を保つ |
| 広げない | カートの半径 `KART_RADIUS`（0.95） | 変更なし | 広げる目的は、同じカートに余裕を作ること |
| 広げない | 柱（`halfWidth 1.2` / `taper 4`）、`islandHalf` 6 | 変更なし | 障害物の大きさはカートとの比で決まる。広い路面に同じ柱を置くと、横を抜ける幅が増える（依頼と同じ向き） |
| 広げない | スタート格子（±2 m、4.5 m 間隔） | 変更なし | カート同士の間隔で、幅と関係がない |
| 広げない | CPU のふらつき `sin(...)*2.5` | 変更なし | 全コース共通の sim 定数。変えると AI の差分が増える。広い路面での散らばりは後回し（`.omc/followups.md`） |
| 広げない | コース沿いの距離（全長、`from` / `to`、ゾーン、帯の位置） | 変更なし | 横方向の寸法だけを変える。島を広げると外壁が 20.45 m になり、進入ランプの傾き上限（20 m で 7 m）すれすれになる |

- 島の外側の壁の半幅は `islandHalf + R + laneWidth = 6.95 + 11.7 = 18.65` m。進入の壁（13.65 m）との差は 5.0 m で、ランプの傾き上限に収まる。
- 描画の外周（壁 + 6、+ 8、+ 22 のスカート、縁石）、`clamp`、ミニマップは、`widthAt` からの相対値か外接矩形なので、コードを変えずに追従する。
- `LAYOUT_FINGERPRINT` はスナップショットのバイト配置の指紋なので、幅を変えても変わらない。

### カーブの修正（`tracks.test.ts` の規則: 曲率半径 ≥ `wallHalfWidth(d) + 2.5`）
壁が 13.65 m になり、要求半径は 13.0 m から **16.15 m** に上がった。実測で MEADOW（15.68 m（d≈196）と 16.07 m（d≈242））と SNOWPEAK（13.52 m と 14.74 m）が不足した。NEON は 18.56 m で通る。CANYON の実測は 35.14 m（計画書の「≥ 40」は誤り）で通る。規則の +2.5 は緩めていない。`scale` も触らない（全長と BASELINE がまとめて動くため）。

| コース | 制御点（旧 → 新） | 最小半径 | 余裕（16.15 m 比） |
| --- | --- | --- | --- |
| MEADOW | `[75, 4.5, -27]` → `[76, 4.5, -27]`、`[82, 1.5, -70]` → `[82, 1.5, -71]` | 16.58 m | 0.43 m |
| SNOWPEAK | `[62, 7, -25]` → `[68, 7, -25]`、`[70, 6, -70]` → `[70, 6, -71]` | 17.22 m | 1.07 m |
| NEON | 変更なし | 18.56 m | 2.41 m |

- MEADOW の余裕 0.43 m は小さい。M5 で MEADOW を触るときに曲率を再確認する。
- 全長はほぼ変わらない（BASELINE 比 meadow 1.0015、snowpeak 0.9935、neon 1.0106）。
- 壁ヒット（BASELINE）は meadow 3 → 0、snowpeak 0 → 0、neon 1 → 0。

### CANYON の島の再調整（`layoutVersion: 4`）
- レーン幅 11.7 m にすると内側レーンの中心が島から遠くなり、弧長が伸びて、M2 の余裕 0.05 s が割れる。島は 468〜543 m のまま（±5 m ずらすと `validateTrackDef` が通らない）。内側のダートを +32 から **+26〜+50** に延ばして調整した。ブーストは +42〜+46、jump は +50〜+54、pit は +56〜+70.8 のまま。
- 実測（CPU 無し、`corridor.test.ts` / `tracks.test.ts` / `handling.test.ts`）:

| 項目 | M2（旧） | M2.5（新） | しきい値 | 余裕 |
| --- | --- | --- | --- | --- |
| 近道の得（外側より速い） | 0.450 s | **0.483 s** | 0.4〜2.0 s | 0.083 s |
| 落下（外側より遅い） | 1.566 s | **1.583 s** | 1.5 s 以上 | 0.083 s |
| 得 + 落下 `P` | 2.016 s | 2.067 s | - | - |

- ブースト踏切 26.43 m/s で +74.0 に着地（pit 端 +70.8 を 3.2 m 越える）。無ブースト 20.39 m/s は +69.6（pit の中）に落ちる。
- **余裕を両側 0.10 s にできなかった理由**: 両側 0.10 s には、得 ≥ 0.50 s かつ落下 ≥ 1.60 s、つまり `P ≥ 2.10 s` が要る。`P` は pit のペナルティ（全コース共通で変えない）と島の長さで決まり、ダートの長さを動かしても得と落下の間で配分が入れ替わるだけで合計が増えない。実測の上限は 2.067 s だった。しきい値は M2 のまま、目標を「両側 0.05 s 以上」に下げ、実測の 0.083 s で満たした。M5 の作り直しで再調整する。
- 狭路・柱・ダート開始位置の他の値は M1 のまま。`tracks.test.ts` の旧寸法固定（7.2 / 10.5）は基準定数の参照に変えた。

### アシスト（`src/input/assist.ts`）の修正とファズ
- **原因**: 回避経路の到達可能性を、現在の速度で一定として見積もっていた。全開で 15 → 32 m/s に加速する間に、途中で到達不能になり、アシストが手放す（「掴んで離す」）。
- **修正**: 自線の予測に 1 m ごとの速度（`stepSpeed`）を持たせ、split が予測範囲にあるときだけ、回避経路の横補正（AUTHORITY / speed）を予測速度で縮める。split のない範囲は HEAD とビット一致（約 11.4 万フレームで確認）。CPU 時間は HEAD 比 5〜15% 増。
- ファズの範囲を島のレーン幅 6〜12 m に広げた（`assist.island.test.ts`、500 件 / シナリオ、固定シード 3 組）:

| シナリオ | 基準 | 実測（500 件） |
| --- | --- | --- |
| 島 1 つ・直線 | 悪化 0 | 0（帯 30/163） |
| 島 1 つ・カーブ | 悪化 ≤ 1 | 0（M2 の 2 件は解消。帯 62/150） |
| 帯が密集 | 3% 以下 | 1 / 500 |
| 鼻への進入（正面当たり） | 0 | 100 / 100 が回避 |

- カーブの基準は「悪化 0」から「≤ 1/500」に変えた（修正前は i=77、島半幅 5.10、開始 −8.22、steer +0.3 を島側に保持するケースで 1 件悪化）。この「外寄り開始＋島側ステア保持」の改善は M3 に回す。
- 「レーン幅 6 m 未満の島」の再検証は M5 / M6 に残す。

### layoutVersion とベストタイム
- `layoutVersion`: meadow / snowpeak / neon は 1 → **2**、canyon は 3 → **4**。
- ベストタイムのキーは `pocket-circuit.best.v3` のまま、形も `{ time, layout }` のまま。`loadBest` は `record.layout === layout` のときだけ値を返すので、古い記録は**自動で無視される**（移行コードなし）。次に新しい記録が出たときに上書きされる。

### BASELINE（`src/sim/handling.test.ts`）
CPU 8 台、シード [1, 42, 98765]、各 3 周、72 周の平均。darwin-arm64。ラップ比の上限 1.05 は変更なし。

| コース | 旧（版） | 旧 平均ラップ（秒） | 新（v11）平均ラップ（秒） | 外壁ヒット 旧 → 新 | 帯ヒット 旧 → 新 |
| --- | --- | --- | --- | --- | --- |
| meadow | v7 | 18.50972222222222 | 18.537268518518516 | 3 → 0 | 0 → 0 |
| canyon | v10（layout 3） | 20.094907407407405 | 19.67476851851852 | 0 → 0 | 1 → 0 |
| snowpeak | v7 | 18.057175925925925 | 17.939814814814813 | 0 → 0 | 0 → 0 |
| neon | v7 | 18.24861111111111 | 18.441435185185185 | 1 → 0 | 0 → 0 |

- canyon の新/旧は 0.979。近道 24 / 72 通過、安全側 48、pit 落下 0 は変わらない。帯ヒット上限 4 も変えない。

### E2E と描画の基準（M1-04 → M2.5）
Chromium 1280x720、DPR 1、seed 127、停止 10 フレーム。`e2e/courses.spec.ts` と `src/render/course/buildCourse.test.ts` の `RENDER_BASELINE`。

| コース | drawCalls 旧 → 新 | triangles 旧 → 新 | meshes 旧 → 新 |
| --- | --- | --- | --- |
| MEADOW | 123 → 123 | 41530 → 41530 | 29 → 29 |
| CANYON | 128 → 129 | 46784 → 54564 | 33 → 40 |
| SNOWPEAK | 125 → 125 | 41810 → 41952 | 33 → 31 |
| NEON | 125 → 125 | 66080 → 62748 | 30 → 30 |

- 予算の式（基準 + 20 かつ 200 以下、triangles は基準 + 15000、meshes は基準 + 2（島あり + 5））は変えない。
- CANYON の meshes 40 は M2 と同じ（島 +5 と boost デカール 1 を含む）。
- 描画のレールと物理壁は同じ `widthAt(d).wallHalfWidth` で一致する。近道テストの初期横位置 12.8 が壁の許容 12.70 を 0.10 m 超えていたため、スクリーンショットで食い込んで見えた（後回し: `.omc/followups.md`）。

### プロトコル v11 と pin
- `PROTOCOL_VERSION` は 11、`ROOM_PREFIX` は `pcircuit-v11-`。v10 と v11 は部屋が分かれるので、混在しない。
- `LAYOUT_FINGERPRINT` は **`f7b2a1f2` のまま**（`snapshotCodec.test.ts:539`、`11: 'f7b2a1f2'` を追記）。
- `COURSE_FINGERPRINT` の pin は `pinned[11] = 1042567012`（`snapshotCodec.test.ts:567`）。v10 以前の行は書き換えていない。`items.test.ts` の `PROTOCOL_VERSION` の assert も 11。
- **MEADOW の golden**（`surfaces.test.ts`、10 seed × 2 列）: darwin-arm64 列は MEADOW を変えた story が取り直した。linux-x64 列は一旦 `'pending-ci'`（テストは完走だけを検査してハッシュをログに出す）にし、CI のログの `MEADOW final hash (linux-x64) seed N: …` の 10 個を別 commit で置き換える（M2.5-05）。8024037 の CI（run 38098401104）のログから置き換え済みで、`'pending-ci'` は 0 個。
- **後続のプロトコル番号が 1 つずれる**: M3 → v12、M4 → v13、M4.5 → v14、M5 → v15。上の見出しの番号は書き換えず、この節を正とする。
- M5 / M6 の新コースは `widths.ts` の定数を基準にする（狭路は基準 × 0.55 前後で `MIN_PASSAGE` 2.55 m 以上、島のレーンは 11.7 m 前後）。

## v6 M3（動く障害物・回転床、プロトコル v12）
NEON NIGHTLINE に、動く帯（sweep / gate）2 本と回転床 1 つを足した。時刻はレース開始後の `racingTicks × FIXED_DT`（秒）で、カウントダウン中は 0。時刻だけで位置が決まるので、RaceState にバイトを足さない。

### sweep / gate の式（`src/sim/corridor.ts`）
- sweep（横中心が動く）: `center(t) = center + amplitude × sin(2π t / period + phase)`。
- gate（半幅が開閉する。cos 形）: `halfWidth(t) = halfWidth − (halfWidth − minWidth) × (1 − cos(2π t / period + phase)) / 2`。`t = 0`・`phase = 0` では `halfWidth` に一致し、静的な帯と同じ形になる（sin 形だと t = 0 で閉じ側に偏るので cos 形にした）。
- 縁速度の上限 **6 m/s**: sweep は `2π × amplitude / period`、gate は `π × (halfWidth − minWidth) / period`。根拠は、カートの最高速（約 30 m/s）に対して帯の縁が十分遅く、CPU の回避（先読み）とアシストが帯に追従できること。`validateTrackDef` が超過を `RangeError` で拒否する。
- 他車は 100 ms の補間で描画されるため、動く帯に対して見かけの食い込みが出る。NEON の sweep で **≤ 0.42 m**。当たり判定は sim の値で行い、描画だけの見た目の差。

### 回転床（spin）
- 形は円盤（直径 `to − from`、`offsetMin` / `offsetMax` が直径に一致）。中心は区間の中央と横オフセットの中央。
- 円盤の上にいる間（地上のみ。`airTime === 0`）、`heading += rate × FIXED_DT`（spinTime 中も回る）。位置は並進させない。
- `|rate| ≤ 1.5` rad/s、直径 ≤ 30 m、曲率半径 200 m 以上の直線にだけ置ける。帯の排他領域とも重ならない。

### validateTrackDef の時刻サンプリング
動く帯どうしの干渉と通路幅は、各帯の `period / 32` 刻みの時刻でサンプリングして検査する（既存の位置サンプリングに時刻軸を足す）。帯どうしの周期が大きく違うとサンプル数が増える。

### NEON の仕掛け（`layoutVersion: 3`）
| 仕掛け | 位置（d） | 値 |
| --- | --- | --- |
| sweep（柱） | 176〜208 | center −2、halfWidth 1.2、taper 4、amplitude 4.0、period 6 s、phase 0（縁速度 4.19 m/s） |
| gate（ブロック） | 340〜370 | center 0、halfWidth 3.6、taper 8、minWidth 1.2、period 5 s、phase 0（縁速度 1.51 m/s） |
| spin（回転床） | 558〜570 | offset ±6、rate 1.0 rad/s |

- `racingLine` は sweep と gate の手前で迂回する（176〜240 は +6.8、340〜400 は +5.2）。CPU の平均ラップは 18.44 s → **18.31 s**。
- 動く帯コースでのアシスト: 周あたり壁ヒット 1〜2、帯ヒット 0。
- ゲストの位置補正は最大約 0.0005 m（RTT 80±20 ms、`netMotion.test.ts`）。

### 基準の更新
| 項目 | 旧 → 新 |
| --- | --- |
| BASELINE neon（`handling.test.ts`） | v11（18.441 s）→ **v12（18.309 s）**。壁ヒット 0 → 0、帯ヒット 0 → 3（上限 4）。CANYON の帯ヒットは 4 で上限 4 と同値（余裕なし） |
| E2E NEON（Chromium 1280x720、seed 127） | 125 draw / 62,748 tris → **126 draw / 62,812 tris** |
| `layoutVersion` neon | 2 → **3**（他コースは M2.5 のまま） |

ベストタイムは NEON だけが `layout` の不一致で自動的に無視される（リセットされる）。他 3 コースは引き継がれる。

### プロトコル v12 と pin
- `PROTOCOL_VERSION` は 12。v11 と v12 は部屋が分かれる。**対戦は両者とも新ページが必要**。
- `LAYOUT_FINGERPRINT` は **`f7b2a1f2` のまま**（RaceState のバイト配置は不変、`12: 'f7b2a1f2'` を追記）。`COURSE_FINGERPRINT` の pin は `pinned[12] = 313875369`。v11 以前の行は書き換えない。
- MEADOW の sim 経路は変わらないので、`surfaces.test.ts` の golden（darwin / linux 両列）は c345bd5 の値のまま。値の行に差分は無い。
- **後続のプロトコル番号**: M4 → v13、M4.5 → v14、M5 → v15（M2.5 節の表記を正とする）。

### pending-ci ガード（`surfaces.test.ts:43`）を撤去しない判断
M4-01 が MEADOW golden を取り直し、linux 列を再び `'pending-ci'` にする運用でこのガードを使うため。代わりに「close 時に `'pending-ci'` の値が 0 個」を M4 以降の close story の受け入れに引き継ぐ。

## v6 M4（高低差: 勾配・バンク・立体交差の基盤、プロトコル v13）
sim に勾配とバンクの物理、立体交差を壊さない判定、`validateTrackDef` の高低差規則、バンクと高架デッキの描画を足した。公開コースで立体交差を使うのは M5 で、M4 の時点では SNOWPEAK の起伏とバンクだけが見える。RaceState にバイトは足さない（`kart.y` は以前から float で送られている）。

### 坂の式（`src/sim/race.ts` の `advanceKart`）
- `g = slopeAt(track, d) × (sin(heading) × tx + cos(heading) × tz)`（`tx` / `tz` は中心線の接線。上りで正）。`g = 0` では下の係数も重力項も実行せず、平坦コース（NEON）と勾配 0 の合成コースは M4 前とビット一致する。
- `maxSpeed *= clamp(1 − 0.5 g, 0.80, 1.15)`（boost の乗算の後、草・土の上限の前）。
- 加速度が 0 でないとき `acceleration *= clamp(1 − 0.8 g, 0.5, 1.3)`。
- 重力項は惰性（スロットル 0）かブレーキ中だけ: `speed = min(maxSpeed, max(0, speed − 9.8 × 0.6 × g × FIXED_DT))`。下りの惰性で `maxSpeed` を超えない。
- **静止摩擦**: `|speed| < 0.5 m/s` で、無スロットルまたはブレーキ中は重力項を掛けない。スタートの並びやブレーキ停止で坂を這い出さないための条件（M4-01 で仕様に足した）。
- 定常速度（全開）は、`maxSpeed` 超過の緩和（`speed > maxSpeed` で `maxSpeed` へ寄せる処理）込みで、勾配 0.3 の直線で平坦の **上り 0.83539×、下り 1.16461×**。計画の 1.05〜1.15 は使わず、`elevation.test.ts` は 0.80〜0.90 / 1.10〜1.20 を検査する。

### `slopeAt` が区分定数である理由
`slopeAt(track, d)` は d を含むサンプル区間の `(b.y − a.y) / (b.distance − a.distance)`（継ぎ目は最後のサンプルから先頭へ）。`sampleTrack` の y の線形補間と整合し、`TrackSample` にフィールドを足さずに済む。`tracks.test.ts` が `fnv1a32(track.samples)` で MEADOW の全サンプルを pin しているので、`TrackSample` を変えると golden が全て動く。範囲内の distance では `wrapDistance` を通さない（`(d + length) % length` が、ちょうどサンプルの距離を前の区間に丸めうるため）。

### バンク（`rollAt` / `surfaceHeightAt`）
- `rollAt` は `def.bankKeys` の線形補間（`widthKeys` と同じく継ぎ目で wrap。キー無しは 0）。roll > 0 で +offset 側が高い。
- `surfaceHeightAt(track, d, offset) = sampleTrack(d).y + sin(roll) × offset`。カートは射影の直後に `roll ≠ 0` のときだけ `y += sin(roll) × lateralOffset` を足す。描画は同じ関数を使い、式を複製しない。
- 旋回係数: 舵が低い側（`−sign(roll)` 側）へ向くとき `turnRate × (1 + 0.3 × |roll| / 0.35)`。高い側では等倍。`roll = 0` では乗算しない。

### 立体交差の判定（`track.ts` / `laps.ts` / `items.ts`）
- **同レベル閾値 `LEVEL_GAP = 6.0`**（計画は 4.0）。同じデッキで XZ 距離 r 以内の 2 体の最大 Δy は `r × sin(0.35) + 0.30 r + ジャンプ 2.0` で、最大の判定半径は爆発の 4.5 m なので **4.9 m**。4.0 では同デッキの爆発を取りこぼす。カート同士の衝突、爆発、ボックス、周回盾、トラップ、ターゲティング（45 m）、弾に `sameLevel` を要求する。所有者から離れたかどうかの判定（owner-cleared）だけは距離の測定なので入れない。
- **交差点の高低差 ≥ 12**（計画は 9）。別デッキの最小 Δy は `12 − 13.65 × sin(0.10) − 0.10 × 4.5 × 2 − 2.0 = 7.7 m`（交差 ±20 m を勾配 ≤ 0.10・roll ≤ 0.10 に制限した場合）で、6.0 を上回る。
- **デッキ対の路面高度差 ≥ 8.0** = `LEVEL_GAP + JUMP_HEIGHT`（6.0 + 2.0）。デッキ内のサンプルとデッキ外のサンプル（弧長差 > 31.8 m）の対で、XZ ≤ **31.8 m**（= 2 × 最大壁半幅 13.65 + 爆発半径 4.5）なら必須。交差点だけの検査では足りない: **45° で交わると重なりは交差点から約 33 m まで広がる**（critic の反証）。90° でも勾配・バンク・ジャンプを足すと余裕は 4.5 m。
- `projectToTrack(track, x, z, previousDistance?, yHint?)`: ±20 m の窓が使えない**全域探索のときだけ** `yHint`（路面高さ。ジャンプの放物線を含めない）を使い、両端が `LEVEL_GAP` 超離れたセグメントを飛ばす。候補が 0 なら飛ばさずに再探索する。窓の経路は変えないので通常走行はビット一致。既存 4 コースの全域探索は、路面高さを与えても結果が変わらない（`crossing.test.ts`）。
- 周回ゲートは XZ の判定に加え、**弧長 ±40 m** 以内のときだけ通過とする。別デッキがゲートの XZ を踏んでも `nextCheckpoint` は進まない。

### validateTrackDef の高低差規則（`corridor.ts`、すべて `RangeError`）
| 規則 | 値 |
| --- | --- |
| 全サンプル区間の `|slopeAt|` | ≤ 0.30 |
| `bankKeys` | distance は [0, length] で狭義単調増加、`|roll|` ≤ 0.35、隣接キー間と継ぎ目の twist ≤ 0.02 rad/m、0 と length の両方にキーがあれば roll が一致 |
| `decks` | from / to が [0, length]、区間どうしが重ならない |
| デッキ対の高度差 | XZ ≤ 31.8 m のデッキ内 × デッキ外（弧長差 > 31.8 m）のサンプル対で ≥ 8.0 |
| 中心線の自己交差 | 隣接以外の全区間対で検出。交差点の中心線 |Δy| ≥ 12、交差角 ≥ 45° |
| 交差 ±20 m | 両デッキとも `|slopeAt|` ≤ 0.10 かつ `|rollAt|` ≤ 0.10（40 m 内のサンプルと bankKey も検査） |
| ゲート | 交差から弧長 25 m 以内に置けない |
| 上側の通過点 | `decks` のいずれかの区間に含まれる |
| ジャンプ台 | 着地勾配 ≥ 踏切勾配 − 0.05 |

- **ジャンプの規則を計画から変えた理由**: 計画の「上り→平坦」は使わない。CANYON の 3 つのジャンプは踏切が下り（−0.084 / −0.069 / −0.018）で、`canyon.test.ts` が下りを要求する。踏切勾配は `slopeAt(to)`、着地勾配は (to, to + 40 m] の `slopeAt` の最小値。
- 交差・`bankKeys`・`decks` の無いコースは追加の計算を踏まない（4 コースの検証結果は不変）。自己交差の検出は x でソートした掃引で、交差のないコースは全対を走査しない。

### 描画（`buildCourse.ts` / `kartRoll.ts`）
- 路面リボン・縁石・レール・ポスト・景物の y は `surfaceHeightAt`。roll = 0 のコースは今の値とビット一致（`buildCourse.test.ts` の MEADOW 外観回帰が不変）。
- `decks` の区間は地面リボン（土手）を出さず、路面を別メッシュ（側板と裏面つき、厚さ 0.6 m、影を落とす・受ける）にし、支柱を `InstancedMesh` 1 つで立てる（間隔 ≤ 20 m、下端は下側路面か −1.35 m の低い方）。下側路面の XZ 範囲には景物を置かない。
- カートは `kartRotationZ` でバンクに合わせて傾く（`body.rotation.z` の舵の傾きとは別）。`GameRenderer.getCameraPosition()` を足した（E2E が使う）。

### SNOWPEAK v3（`layoutVersion: 3`）
| 項目 | 値 |
| --- | --- |
| 高低差 | **19.43 m**（旧 約 6.3 m） |
| 最大勾配 | **0.2011**（下限 0.20 に 0.0011 の差。上限 0.30 には余裕） |
| バンク | 30–85 m の最初の氷のスイーパー、roll **−0.3**（50〜65 m が最大。入口 30→50 と出口 65→85 は 20 m の傾斜で twist 0.015 rad/m） |
| スタート | 最終進入は平坦（グリッドが這い出さない） |

ベストタイムは SNOWPEAK だけが `layout` の不一致でリセットされる（他 3 コースは引き継がれる）。

### 基準の更新
| 項目 | 旧 → 新 |
| --- | --- |
| BASELINE meadow（`handling.test.ts`） | v11（18.5373 s）→ **v13（18.8544 s）**（M4-01、×1.017） |
| BASELINE canyon | v11（19.6748 s）→ **v13（19.7634 s）**（M4-01、×1.005。bandHits は上限 4 のまま、実測 0） |
| BASELINE snowpeak | v11（17.9398 s）→ M4-01 の 17.8699 s（×0.996）→ **M4-05 の 17.7273 s**（×0.992、壁ヒット 0、帯ヒット 0）。M4-05 の比は M4-01 の値を基準に 0.95〜1.10 を検査する |
| BASELINE neon | 変更なし（平坦でビット一致） |
| `guestSession.test.ts` の非ローカル誤差上限（RTT 120 ms / 損失 10%） | 0.5 m → **0.55 m**。実測最大 0.5425 m。**原因は `interpolation.ts` の外挿が y を進めないこと**（x / z は heading × speed で進むが高さが遅れる。MEADOW の勾配 最大 0.139 上でスナップショットが欠けると出る）。勾配物理を無効にした同条件では 0.3855。ゲストのローカル予測（≤ 0.1）は通っており、非決定性ではない。外挿で y も進めたら 0.5 に戻す（M4.5） |
| E2E SNOWPEAK（Chromium） | カメラの最低クリアランス **2.962 m**、最大ロール **0.3 rad**（バンクの roll に一致） |

### プロトコル v13 と pin
- `PROTOCOL_VERSION` は 13、`ROOM_PREFIX` は `pcircuit-v13-`。v12 と v13 は部屋が分かれる。**対戦は両者とも新ページが必要**。
- `LAYOUT_FINGERPRINT` は **`f7b2a1f2` のまま**（`13: 'f7b2a1f2'` を追記）。`COURSE_FINGERPRINT` の pin は `pinned[13] = 2812341565`（SNOWPEAK のデータを変えた M4-05 で更新。v12 の 313875369 から変わった）。v12 以前の行は書き換えない。
- MEADOW の golden（`surfaces.test.ts`）は M4-01 で darwin-arm64 列を取り直した。linux-x64 列は一旦 `'pending-ci'` にし、公開 commit の CI ログ（`MEADOW final hash (linux-x64)`）から別 commit で置き換える（運用は M2.5-05 と同じ。close 時に `'pending-ci'` が 0 個であること）。`surfaces.test.ts:43` のガードは M5 以降も同じ運用のため撤去しない。
- **後続のプロトコル番号**: M4.5 → v14、M5 → v15。

### M5 に送ったもの
- **ミニマップの交差描画**: 立体交差でどちらのデッキか区別して描く処理は M4 では入れない（M4 は立体交差を持つ公開コースが無い）。
- **立体交差の公開コース**: M4 は基盤（物理・判定・検証・描画・fixture）だけで、立体交差を使う公開コースは M5。同レベル閾値 6.0 の再検討は、ジャンプ高の実測後に行う。

## v6 M4.5（周回数設定・アイテムボックス 24・プロトコル v14）
周回数を 1〜3 から選べるようにし、アイテムボックスを 12 個から 24 個に増やした。M1-02 の hit 区別（最後に当たった帯）を RaceState に足したので、レイアウトが初めて変わった（M3 の「0 B」の前提は M4.5 で外れた）。

### 周回数（`src/sim/laps.ts`）
- `RaceOptions.laps` と `RaceState.laps`。有効な値は整数 1〜3（`isLapCount`、`LAP_CHOICES = [1, 2, 3]`、`DEFAULT_LAPS = MAX_LAPS = 3`）。`TOTAL_LAPS` は廃止し、完走の判定は `kart.lap === state.laps`。
- **選ぶのはホストだけ**。ソロはタイトル画面のセレクタ、オンラインはロビー（ホストのみ操作、ゲストは読み取り専用）。`HostSession.setLaps(n)` はロビー中かつ `isLapCount(n)` のときだけ受け付け、`course` で配信する。
- `welcome` / `course` / `race_start` に `laps`（整数 1〜3）を足した。パーサは範囲外を拒否する。**ゲストの無視規則**: ロビーで受けた `race_start` の `laps` が、直前の `welcome` / `course` で受けた値と違えば無視する（警告を出す）。コースの不一致と同じ扱いで、ゲストは自分で `laps` を決めない。
- 結果画面とレース中の表示は選んだ周回数（「N LAPS」）を出す。

### ベストタイム（storage v4）
- キーは `pocket-circuit.best.v4`、形は `{ [trackId]: { [laps]: { time, layout } } }`。周回数ごとに別の記録を持つ（1 周の記録が 3 周の記録を上書きしない）。
- v3 は v4 が無い最初の1回だけ **laps 3 として取り込む**。v3 の `layout` 不一致の規則（`layoutVersion` が違えばリセット）は v4 でも同じ。

### スナップショットのバイト
| 項目 | 値 |
| --- | --- |
| ヘッダ | **29 B**（byte 28 = `laps`。旧 28 B） |
| カート | **59 B**（offset 58 = `lastBand + 1`。旧 58 B） |
| エンティティ | 25 B（不変） |
| 箱 | **24 個**（旧 12） |
| `BASE_BYTES` | **525 B** |
| 27 体（`MAX_SNAPSHOT_ENTITIES`） | **1200 B ちょうど**（予算の余裕 0 B） |
| 2 体 | **575 B** |

**注意**: 予算の余裕が 0 B なので、M5 以降でカートにバイトを足すなら `MAX_SNAPSHOT_ENTITIES` を 26 に下げる。`lastBand` は `-1`（なし）を 0 に符号化する。補間（`interpolation.ts`）は離散値として `lastBand` をそのまま写す。

### hit の区別（M1-02、`src/sim/race.ts`）
- `KartState.lastBand`: 最後に当たった帯の `track.def.barriers` の添字（`-1` = なし）。
- **同じ帯への再接触は、その帯の span（半径で広げた端を含む、継ぎ目をまたぐ区間も `exclusionAt` が扱う）を出るまで hit を 1 回だけにする**。同じ帯に当たっている間は速度が高くても再報告せず、レールの cooldown 0.7 s だけ維持する。span を出たら `-1` に戻り、次の接触は新しい hit になる。
- 内向き速度がほぼ 0 の接触でも cooldown を更新するので、その間のレール hit が抑制されうる（仕様どおり）。

### 箱 24 個（8 列 × 3 レーン）
`buildTrack` は `boxRows.length === 8` かつ `boxLanes.length === 3` を要求する（満たさなければ `RangeError`）。**元の4列は fraction を保ったまま**、間に 4 列を足した（`layoutVersion` は上げない。走行面も帯も変えず、ベストタイムの互換を保つため）。

| コース | `boxRows`（fraction） |
| --- | --- |
| MEADOW | 0.02, 0.12, 0.24, 0.36, 0.47, 0.58, 0.695, 0.81 |
| CANYON | 0.04, 0.19, 0.29, 0.4, 0.52, 0.69, 0.84, 0.9 |
| SNOWPEAK | 0.03, 0.16, 0.29, 0.42, 0.515, 0.61, 0.74, 0.87 |
| NEON | 0.02, 0.12, 0.20, 0.36, 0.43, 0.58, 0.695, 0.81 |

NEON は当初の追加列（約 158 / 309 m）が動く帯の進入に入り帯ヒット 5 になったため、約 132 / 283 m（0.20 / 0.43）に動かした。`handling.test.ts` の pillarTrack は 0.24 の列が 3 本目の柱に入るので 0.30 に置く。

### プロトコル v14 と pin
- `PROTOCOL_VERSION` は 14、`ROOM_PREFIX` は `pcircuit-v14-`。**対戦は両者とも新ページが必要**。
- `LAYOUT_FINGERPRINT` は **`aa03c454`**（`14: 'aa03c454'`）。**v14 で初めて変わった**（v6 の `f7b2a1f2` 以来）。理由は、カートの `lastBand`、ヘッダの `laps`、箱 24 個。`headerBytes` と `boxCount` を指紋の入力に含めたので、バイト数だけが変わる変更も指紋に出る。
- `COURSE_FINGERPRINT` の pin は `pinned[14] = 4027931737`（`boxRows` を変えた M4.5-03 で確定）。v13 以前の行は書き換えない。
- **後続のプロトコル番号**: M5 → v15。

### golden を 2 回取り直した
`surfaces.test.ts` の MEADOW golden（darwin-arm64 列）は 2 回取り直した。1 回目は M4.5-00（JSON の形、`laps` / `lastBand` が状態に入った）、2 回目は M4.5-03（箱 24 個で CPU のアイテム取得と使用が変わった）。linux-x64 列は `'pending-ci'` のままで、公開 commit の CI ログ（`MEADOW final hash (linux-x64)`）からコーディネーターが pin する（この story の範囲外）。`surfaces.test.ts:43` のガードは撤去しない。

### 基準の更新
| 項目 | 旧 → 新 |
| --- | --- |
| BASELINE meadow（`handling.test.ts`） | v13（18.8544 s）→ **v14（19.1056 s）**（×1.0133）。bandHits 0 |
| BASELINE canyon | v13（19.7634 s）→ **v14（20.3940 s）**（×1.0319）。bandHits **4 → 1** |
| BASELINE snowpeak | v13（17.7273 s）→ **v14（18.9225 s）**（×1.0674）。bandHits 0 |
| BASELINE neon | v12（18.3088 s）→ **v14（19.1676 s）**（×1.0469）。bandHits **3 → 2** |

計測は darwin-arm64、CPU 8 台 × seed [1, 42, 98765] × 3 周（コースごと 72 周）。壁ヒットは全コースで 0。

### アシスト（`src/input/assist.ts`）
舵を保持しているときは、島の実形状で経路を選ぶ（外寄り開始＋島側ステア保持で島へ引き込まれるケース、カーブのファズ i=77）。i=77 の固定テストは M4.5-04 の時点で既に 0/500 で、修正の効果を示すのは dense の i=153。

### 落下音（M4.5-07）
落とし穴の hit（value 2）は、帯・レールの hit とは別の専用の落下音を鳴らす（`itemSounds.ts`）。画面演出は M5。

### E2E がビルド成果物で動く（M4.5-06）
- `npm run e2e` は `vite build --mode e2e` のあと `vite preview --config e2e/vite.e2e.config.ts --port 4174 --strictPort` で動く。**本番 mode のビルド**で検証し、開発サーバー専用ではなくなった。
- デバッグフックは `VITE_KART_DEBUG` で有効にする（mode e2e のビルドだけ。`__kartDebug`）。`e2e/*.spec.ts` は `tsconfig.e2e.json` で型検査する（`npm run typecheck`）。`courseGroup` は公開 getter。gate のスクショは開と閉の 2 枚。
- 24 件すべて通過した。**並行して build が走り `dist` が上書きされると 7 件が落ちる**ので、静かな作業ツリーで流す。

### M5 に送ったもの
島の寸法（半幅 6、レーン幅 9）と pit のクリア速度 22 の見直し、落下ペナルティ `spinTime` 1.6〜2.0 s、hit value 2 の画面演出。実測と理由は `.omc/followups.md` の「v6 M4.5 後回し一覧」。

## v6 M5（4 コースを約 2.3 km に作り直し・プロトコル v15）
4 コースをすべて 2.26〜2.29 km で作り直した（旧 MEADOW は 651.39 m）。各コースにゲート 24 個とアイテムボックス 8 列（24 個）を置く。通信の版は v15 に上がった。数値はコードと `git log d782ec1~1..HEAD` のコミットメッセージから取った。計測は darwin-arm64。

### プロトコル v15 と pin
- `PROTOCOL_VERSION` は 15、`ROOM_PREFIX` は `pcircuit-v15-`（`src/net/protocol.ts`）。**対戦は両者とも新ページが必要**。
- `LAYOUT_FINGERPRINT` は **`aa03c454` のまま**（`snapshotCodec.test.ts` に `15: 'aa03c454'`）。スナップショットのバイトは変えていない（`MAX_SNAPSHOT_ENTITIES` の余裕 0 B も v14 のまま）。
- `COURSE_FINGERPRINT` の pin は `pinned[15] = 642527371`（M5-05 で確定。4 コースの定義がすべて変わったため。`snapshotCodec.test.ts`）。v14 以前の行は書き換えない。
- **後続のプロトコル番号**: M6 → v16。

### 終了のタイムアウトと tick 上限
- `RACE_FINISH_TIMEOUT` は **45 s → 90 s**（`src/sim/race.ts`、M5-00）。最初の完走から 90 s で打ち切る。コースが約 3.5 倍に長くなったため。
- テストの tick 上限は `60 * 180` から **`60 * 420`**（420 s）に延ばした（`sim.test.ts`、`handling.test.ts`、`net-core.test.ts`、`surfaces.test.ts`、各コースのテストなど）。E2E の待ちも 420 s。`tracks.test.ts` の決定性テストはタイムアウトも 30 s → 120 s にした。

### メッシュ予算式
コース全体の三角形数（影の描画を含む。視錐台カリングなし）に、レーサー分の 20,000 を足した値の上限は次のとおり。

`triangles + 20_000 ≤ 60 × track.length + 30_000`（`canyon.test.ts`。右辺は長さで決まる）

| コース | 実測の三角形数 | 上限（右辺） |
| --- | --- | --- |
| MEADOW | 100,312 + 影 7,704 | 167,181.21 |
| SNOWPEAK | 106,084 + 影 5,784 = 111,868 | 165,738.34 |
| NEON | 影を含め 108,730 | 166,975.88 |

CANYON も同じ式で `canyon.test.ts` が検査する。島ごとの式（島 1 つ +5、2 split 以上や rock と building の混在で +7）は M6 に送った。

### 4 コース（layoutVersion と実測）
各コースに**ゲート 24 個**（`checkpointCount: 24`）、箱 8 列（24 個）。CPU の平均ラップは 8 CPU × seeds [1, 42, 98765] × 3 周（コースごと 72 周）の `handling.test.ts` の BASELINE（v15）。壁ヒットは全コースで 0。

| コース | layout | 長さ (m) | おもな要素 | CPU 平均ラップ (s) | bandHits |
| --- | --- | --- | --- | --- | --- |
| MEADOW | 3 | 2286.35 | ヘアピン、S 字（交互のカーブ）、複合コーナー、ダート 2、尾根のジャンプ、牧草の狭路、バンク | 68.5012 | 0 |
| CANYON | 5 | 2274.65 | 90 度の立体交差（高低差 20 m、デッキ 40 m）、島の近道、下りジャンプ 2、幅 55% の狭路、砂利のヘアピン、S 字、複合コーナー | 68.4958 | 0 |
| SNOWPEAK | 4 | 2262.31 | 山頂のヘアピン、凍結した S 字、複合コーナー、バンク 2（0.3 rad）、幅 55% の尾根、上りから平坦への頂上ジャンプ、ダート | 67.8912 | 0 |
| NEON | 4 | 2282.93 | 高架（直交する立体交差が 80 m のブーストトンネルの上、18 m）、sweep / gate / spin、ビルの島、狭い街路、ヘアピン、シケイン、複合コーナー | 64.3294 | 1 |

| コース | 最小曲率半径 (m) | 最大勾配 | 高低差 (m) |
| --- | --- | --- | --- |
| MEADOW | 18.1156 | 0.1052 | 8.64 |
| CANYON | 17.5868 | 0.2576 | — |
| SNOWPEAK | 18.1156 | 0.2542 | 40.07 |
| NEON | 17.3499 | 0.1729 | — |

- CANYON の近道（島）: 内側 4.400 s、外側 4.900 s、落ちた場合 6.650 s。**得 0.500 s、落とし穴のコスト 1.750 s**。必要な余裕は 0.100 s（得）と 0.250 s（落下）で、得の余裕はちょうど 0.100 s（1 tick 失えば落ちる。決定的なので flaky ではない）。停止状態から入る近道の fixture は、ブーストありで越え、なしで落ちる。島は 816〜911 m、`islandHalf` 6.9、`laneWidth` 11.7。
- NEON: 島は 1380〜1450 m、`islandHalf` 4、`laneWidth` 11.7。直線の開始 100 m は平坦（平坦勾配の検査は合成 fixture に移した）。
- CANYON の旧設計値（`islandHalf` 6 / `laneWidth` 9）は採らなかった。決めた値は上のとおり。
- 4 コースとも長さは 2100〜2400 m に収める（`meadow.test.ts` など）。

### 新しい検証規則
`validateTrackDef` は従来どおり。M5-0V（`63251c2`）で `validateCoursePlayability`（`src/sim/corridor.ts`）に split の規則を 2 つ足した。どちらも `RangeError`。

| 規則 | 内容 |
| --- | --- |
| スタートラインをまたがない | split の区間がスタートライン（距離 0）をまたぐ配置は拒否する。`to` がちょうど 0 で終わる配置と、`from` が 0 で始まる配置は通す。メッセージは `split must not cross the start line` |
| 島の曲率 | split 区間の各サンプルで、外側レーンの半幅（`offsetMin` / `offsetMax` の絶対値の最大）が曲率半径を超えると拒否する（内側のオフセット曲線が自己交差するため）。メッセージは `split outer lane half-width must not exceed the curvature radius` |

従来からある規則: split のレーン幅は `MIN_PASSAGE + 1`（= 2R + 0.6 + 1.0 = 3.5 m）以上。**レーン幅 6 m 未満の島を拒否する規則はまだ無い**（M6 に送った）。

曲率と道幅は各コースのテストが検査する。

- 曲率半径は壁の半幅 + 2.5 m 以上（継ぎ目を含む全サンプル、`tracks.test.ts`）。MEADOW と SNOWPEAK のテストは、さらに 0.8 m の余裕を要求する。
- MEADOW の最小曲率半径は 17 m 以上（`meadow.test.ts`）。
- 狭路の通路幅は 2.55 m 以上（`corridorAt` の `max - min`）。
- 景物は壁との局所的なクリアランスを持って置く（SNOWPEAK、`buildCourse.ts`）。

### shapeMetrics の定義（`src/sim/tracks/shapeMetrics.ts`）
コース設計の検査用で、シミュレーションは使わない。長さはサンプルした中心線に沿った m、角度は rad。曲率は隣り合う 3 サンプルの外接円から符号付きで求め、継ぎ目をまたいで巡回する。

| 名前 | 定義 |
| --- | --- |
| ヘアピン（`findHairpins`） | 120 m 以内で 150° 以上曲がる区間。その区間の最小半径が、その地点の壁の半幅 + 2.5 m 以上、+ 8 m 以下 |
| S 字（`findSCurves`） | 300 m 以内で曲率の符号が 3 回以上反転し、すべてのカーブの最小半径が 70 m 以下の区間。カーブは \|κ\| ≥ 1/200 の同符号の連なりで、それ未満（不感帯、`S_CURVE_DEADBAND`）の直線は反転に数えない。重なる候補は 1 区間にまとめる |
| 複合コーナー（`findCompoundCorners`） | 同符号で 90° 以上曲がる区間に、曲率の極大が 2 つあり、半径の比が 1.25 倍以上（広い方 ≥ 1.25 × 狭い方）。極大は \|κ\| ≥ 1/200 の局所最大（平らな頂は末端で 1 回と数える） |
| `minCurvatureRadius` / `elevationRange` / `maxSlope` | 最小曲率半径、高さの最小・最大・差、隣り合うサンプル間の \|Δy / Δdistance\| の最大（継ぎ目を含む） |

shapeMetrics は M5-0V で入り、Codex のレビューに 3 回 FAIL したあと（合成コースでの取りこぼし）、コーディネーターが仕様どおりの直接判定に直して回帰テスト 6 件を足した。

### 島の規約
- **widthKeys の合成**: `islandSplit` が返す 4 個のキー（`from - 20`、`from`、`to`、`to + 20`）は島の両端で進入幅を持つ。そのまま展開すると、島の外もすべて進入幅になる（幅は補間され、継ぎ目で巡回する）。**島の前後を基準幅のキーで挟み**、壁の半幅は基準以上に保つ。

  ```ts
  { distance: from - 40, ...base },
  ...island.widthKeys.map(key => ({ ...key, wallHalfWidth: Math.max(BASE_WALL_HALF_WIDTH, key.roadHalfWidth) })),
  { distance: to + 40, ...base },
  ```
  CANYON と NEON が同じ形で使う（`features.ts` のコメントが正本）。
- `from` / `to` は拡張した鼻を含む。レーン選択の進入（35 m）は `from` の直前で終わる。
- レーン幅は 11.7 m 前後（CANYON、NEON）。新コースの幅は `widths.ts` を基準にし、狭路は基準 × 0.55 前後。
- split はスタートラインをまたがず、外側レーンの半幅を曲率半径以下にする（上の検証規則）。

### LEGACY_MEADOW の位置づけ（fixture）
`src/sim/tracks/legacyMeadow.fixture.ts` の `LEGACY_MEADOW` は、プロトコル v14 時点の MEADOW（`layoutVersion: 2`、651.39 m、ゲート 12）を固定した**テスト専用の fixture**。実コースの MEADOW とは無関係で、M5 で実コースを作り直しても、そこから合成コースを作る共有テスト（assist、corridor、walls、netMotion、aiMotion など）の数値が変わらないようにする。**本番コードは import しない**。M5-01 で、全コースが幅キーを持つようになったため、plain-road のアシスト検査も fixture に切り替えた。

### 基準の更新
| 項目 | 旧 → 新 |
| --- | --- |
| BASELINE meadow（`handling.test.ts`） | v14（19.1056 s）→ **v15（68.5012 s）**。bandHits 0 |
| BASELINE canyon | v14（20.3940 s）→ **v15（68.4958 s）**。bandHits 1 → 0 |
| BASELINE snowpeak | v14（18.9225 s）→ **v15（67.8912 s）**。bandHits 0 |
| BASELINE neon | v14（19.1676 s）→ **v15（64.3294 s）**。bandHits 2 → 1 |
| `pinned[15]`（コース指紋） | **642527371**（v14 は 4027931737） |
| `RACE_FINISH_TIMEOUT` | 45 s → **90 s** |

MEADOW の golden（`surfaces.test.ts`）は darwin-arm64 列を新コースで取り直した（10 seed）。linux-x64 列は `'pending-ci'` で、公開 commit の CI ログから別 commit で置き換える。`surfaces.test.ts:43` のガードは撤去しない。

### M5-05 の性能表（a82b5d6）
ヘッドレス Chromium の `?perf=1`（FPS / ドロー数 / 三角形数。最初のフレームを含む）。視点は、スタートグリッドと、コースごとの特徴の手前。

| コース | 視点 | FPS | ドロー | 三角形 |
| --- | --- | --- | --- | --- |
| MEADOW | grid | 8.7 | 125 | 107,048 |
| MEADOW | narrow | 10.3 | 35 | 100,764 |
| CANYON | grid | 8.3 | 138 | 124,808 |
| CANYON | island | 10.3 | 44 | 118,234 |
| SNOWPEAK | grid | 7.8 | 129 | 112,768 |
| SNOWPEAK | narrow | 8.9 | 38 | 106,714 |
| NEON | grid | 7.4 | 134 | 115,360 |
| NEON | overpass | 7.6 | 38 | 108,988 |

grid の ドロー数 / 三角形数は `buildCourse.test.ts` の `RENDER_BASELINE`（meadow 125 / 107,048、canyon 138 / 124,808、snowpeak 129 / 112,768、neon 134 / 115,360）と一致する。FPS はヘッドレスの値で、実機の性能ではない。E2E は静かな作業ツリーで 24/24、`npm test` は 1523 件。

### E2E で見つけた回帰（M5-05）
- M1-06 のアシスト走行は、各地形の前後 ±60 m に限った（走行範囲が S 字まで伸びていた）。
- H6（reduced-motion）の前に、最初のレースを `about:blank` で止める（描画が重くなり、2 つ目のコンテキストの sim が遅れた）。
- ゲストの 5 秒の welcome タイマーを、参加ボタンの押下ではなく**接続確立後**から数える（`213fb99` 以降、ヘッドレスの遅いフレームで PeerJS の参加が 5 s を超えた回帰）。

### M5 の他の変更
- ミニマップは立体交差のデッキを上に描く（M5-08）。
- デッキの支柱は下側の道に立てない。デッキ下の地面の切り抜きはデッキの足跡だけに絞る（M5-09）。
- 他車の外挿は高さも進める。ゲストの非ローカル誤差の上限は 0.5 m に戻した（M5-07。seed 92: MEADOW 0.418、CANYON 0.203、SNOWPEAK 0.257、NEON 0.278）。

### M6 に送ったもの
`.omc/followups.md` の「v6 M5 後回し一覧」のとおり。

## v6 M6（8 コース・プロトコル v16）
新しい 4 コース（HARBOR / FOREST / VOLCANO / SKYLINE）を足し、コースは 8 本になった。通信の版は v16 に上がった。数値は `git log 7e86457~10..HEAD` のコミットメッセージと実ファイルから取った。計測は darwin-arm64。

### プロトコル v16 と pin
- `PROTOCOL_VERSION` は 16、`ROOM_PREFIX` は `pcircuit-v16-`（`src/net/protocol.ts`）。**対戦は両者とも新ページが必要**（v15 のルームは拒否する）。
- `LAYOUT_FINGERPRINT` は **`aa03c454` のまま**（`snapshotCodec.test.ts` に `16: 'aa03c454'`）。スナップショットのバイトは変えていない。M6-00 が変えたのは trackId の値域（`TRACK_IDS` / `PROTOCOL_TRACK_IDS` / `KNOWN_TRACK_IDS` を 8 に拡張）だけ。
- `COURSE_FINGERPRINT` の pin は `pinned[16] = 513548114`（M6-05 で確定。8 コースがそろい、M6-09 の見た目の修正も入った後の値）。`pinned[15] = 642527371` は残す。
- `scaffoldIds()` は空配列に固定した（MEADOW のコピーだった仮コースは無くなった）。

### 8 コースの一覧
`TRACK_IDS` の順（タイトルのコース番号 01〜08 の順）。

| 番号 | id | 名前 | 追加 |
| --- | --- | --- | --- |
| 01 | meadow | MEADOW LOOP | M5 |
| 02 | canyon | SUNSCAR CANYON | M5 |
| 03 | snowpeak | FROSTBITE PEAK | M5 |
| 04 | neon | NEON NIGHTLINE | M5 |
| 05 | harbor | TIDEWATER HARBOR | M6-01 |
| 06 | forest | MOSSWOOD TRAIL | M6-02 |
| 07 | volcano | EMBER CALDERA | M6-03 |
| 08 | skyline | STRATOS CITY | M6-04 |

### 新しい 4 コース
すべて `layoutVersion: 1`。CPU の平均ラップは 8 CPU × seeds [1, 42, 98765] × 3 周（コースごと 72 周）の `handling.test.ts` の BASELINE（v16）。比率は 0.95〜1.05 で検査する。壁 / 帯は `wallHits` / `bandHits`、pit は `pitFalls`（pit を置いたコースだけ記録）。

| コース | 長さ (m) | おもな要素 | CPU 平均ラップ (s) | 壁 / 帯 / pit |
| --- | --- | --- | --- | --- |
| HARBOR（TIDEWATER HARBOR） | 2341.24 | 長い直線 2、桟橋のヘアピン、遊歩道の S 字 2、灯台の島、桟橋のジャンプ 2、砂地 2、岸壁のゲート、バンク 1 | 69.7375 | 0 / 0 / —（pit なし） |
| FOREST（MOSSWOOD TRAIL） | 2237.37 | ヘアピン 2、S 字 2、ダート 3、幅 55% の狭路 2、小川のジャンプ、0.2 rad のバンク 1、丸太橋の立体交差（クリアランス 13.2 m） | 70.5359 | 0 / 0 / —（pit なし） |
| VOLCANO（EMBER CALDERA） | 2265.63 | 登りのヘアピン 2、玄武岩の陸橋、迂回できる溶岩の穴 2、下りのジャンプ、狭い尾根、バンク 1、火山灰 | 67.8241 | 0 / 0 / 0 |
| SKYLINE（STRATOS CITY） | 2390.43 | 高さ 24 m の立体交差 2、跳び越える足場の切れ目 2、風のゲート 2、回転する足場 1、島 1、バンク 2、開いたブーストチューブ | 67.3532 | 0 / 1 / 0 |

| コース | 最小曲率半径 (m) | 最大勾配 | 高低差 (m) |
| --- | --- | --- | --- |
| HARBOR | 18.1156 | 0.0781 | 3.60 |
| FOREST | 17.3499 | 0.1296 | 13.86 |
| VOLCANO | 17 以上（実測値は未記録） | 0.22〜0.30（検査範囲） | 18 以上（検査下限） |
| SKYLINE | 18.8718 | 0.1761 | 24.69 |

- 長さは 2100〜2400 m の範囲に収まる。
- FOREST の高低差の上限は、設計の 12 m から **14 m** に変えた。立体交差の規則（中心線の高さの差 ≥ 12 m ＋ デッキの厚み）と 12 m が両立しないため。
- SKYLINE は開始から 300 m に、デッキ・pit・spin を置かない。
- 三角形数（影を含む）と上限 `60 × length + 30_000`（上限は 20,000 を足した後の値と比べる）:

  | コース | 実測 | 上限 |
  | --- | --- | --- |
  | HARBOR | 105,630（コース＋影の見積もり） | 170,474.44 |
  | FOREST | — | 164,241.93 |
  | VOLCANO | — | 165,938.06 |
  | SKYLINE | 84,058 | 173,425.67 |

### 新しい検証規則
`validateCoursePlayability`（`src/sim/corridor.ts`）に **島のレーン幅は 6 m 以上** を足した（M6-0V、`a789231`）。6 m 未満のレーンは `RangeError('island lane width must be at least 6 m')`。ちょうど 6 m は通る（`corridor.test.ts`）。

`islandSplit` の `laneWidth` を省略したときの既定は `9 × WIDTH_SCALE`（約 11.7 m）。明示した CANYON / NEON の値は変わらない（M6-09）。

M6-0V でほかに直したもの: 島の看板を `buildIslands` の早期 return より前に作る（景物の無い split だけのコースでも出る）。看板は `<name> SAFE` / `<name> SHORT` と書き分ける。

### 島のメッシュ予算の式
島に由来するメッシュ数は次の式で決まる（M6-0V）。

`島のメッシュ = (景物があれば 1 + 景物の種類数) + 2 × split 数`

景物は種類ごとにコース全体で 1 つの InstancedMesh にまとまるので、島を増やしても景物の分は増えない。実測は、CANYON と NEON が +4、rock と building が混在する島 1 つが +5、split 2 本の fixture が +7（リボン 1、rock 1、building 1、看板 4。島が混在でも種類別でも同じ）。M5 の「島 1 つ +5、2 split 以上や混在で +7」を置き換える。

### コース選択 UI（M6-08）
- 選択肢は **44×44 px**（`.course-option span`）。ラベルは番号 `01`〜`08`、`aria-label` は `"NN NAME"`（例: `05 TIDEWATER HARBOR`）。
- デスクトップと横向きのスマホは **1 行 × 8**（`grid-template-columns: repeat(8, 44px)`）。縦向きの狭い画面は **2 段 × 4**（`repeat(4, 44px)`）。縦向きではオンラインパネルとタイトルの余白を上に詰めた。
- ロビーのコース選択は 8 行。
- E2E は 360×640、390×844、844×390 で `scrollWidth <= innerWidth` と、各ボックスが 44 px 以上であることを検査する。`courses.spec.ts` を単独で流して 17/17、16.2 分。

### guest の外挿（M6-07）
- 外挿は速さとドリフトを含まない向きに分け、**ヨー率に沿った弧**で最大 100 ms 進める。上限は 100 ms のまま。
- 誤差の基準: **スナップショットの age が 100 ms 以内なら 1.0 m 未満。超えたら `|v| × (age − 0.1 s) + 1.0 m`**。外挿を 100 ms で止める設計で、4 連続欠落（最新から 200 ms）のとき `36.6 m/s × 0.1 s = 3.66 m` の遅れが出るため（上限を延ばすと旋回中や壁際で行き過ぎる）。
- 実測（8 コース × 予測 {off, on} × seeds [92, 7, 1234, 31, 211]）:

  | 検査 | 最大 | 上限 |
  | --- | --- | --- |
  | seed 92 の全フレーム（600 tick。他は 400 tick） | 0.42 m | 0.5 m |
  | age ≤ 100 ms | 0.14 m | 1.0 m |
  | age > 100 ms（`|v| × (age − 0.1 s)` を超えた分） | 0.002 m | +1.0 m |
- `guestSession.test.ts` は 2.11 s → 20.5 s になった（+18.4 s、上限 30 s）。

### C-010 の安定化（RendererRebuild）
M5 の「M6 必須」だった、ロビーのコース変更でホストの再構築が長引き、ゲストの 5 s `host_lost` に近づく問題を直した（`RendererRebuild`、`src/net/hostSession.ts`）。

- ロビーでのコース変更は、レンダラーの再構築より**先に**ゲストへ送る。
- 再構築は次のフレームへずらし、描画は GPU の完了を待つ。待つ間も通信は動き続ける。
- C-010 単独で **5/5**（修正前は `host_lost` を 3/5 で捕捉）。ゲストのコース表示は 0.46〜8.1 s → **0.11〜0.15 s**。
- 8 コース × 3 周の C-010 が通る（M6-05）。
- 残り: 2 ページが GPU を奪い合う E2E で、ホストが受信を処理できない時間は 3.9〜4.3 s（ゲストの判定は 5 s）。単独なら約 0.7 s。`main.ts` の「再構築を次フレームへずらす」処理に単体テストは無く、E2E と計測で裏付けている。

### タイトル画面の描画を軽くした（M6-09）
タイトル画面のバッファを 1280×720 から **640×360**（画素数 1/4）にした。CSS の大きさは 1280×720 のまま。レースに入ると 1280×720 に戻し、transform を外す。ヘッドレス Chromium、MEADOW、`?perf=1`、frame 20 超えのあと 10 秒の平均:

| | 平均フレーム時間 | fps |
| --- | --- | --- |
| 変更前 | 198.1 ms | 5.05 |
| 変更後 | 142.3 ms | 7.03 |

最大値は 2983.2 → 3149.9 ms。起動時を含み、シェーダー起動の停止は残る。

### M6-09 の見た目の修正
- pit の上のデカールを切り、縁の警告塗装を路面 +0.015 m（`surfaceHeight + 0.075 m` の基準）に置く。穴の床（-0.24）と SKYLINE の開口は変えない。
- pit の境界でエッジリボンを切り、壁・縁石の実頂点が穴に入るインスタンスを除く。
- 島の先細り部の景物は、左右各 0.25 m の余白を引いた幅が 3 m 未満なら置かない。
- ミニマップは継ぎ目（length / 0）を連続して描き、分岐は両レーンを別パスで描いて入口と出口を本線につなぐ。
- 描画の指紋と基準（M6-09 で更新）:

  | コース | RENDER_BASELINE（ドロー / 三角形 / メッシュ） |
  | --- | --- |
  | CANYON | 138 / 124,808 / 42 → **139 / 124,630 / 43** |
  | NEON | 134 / 115,360 / 38 → **134 / 115,336 / 38** |
  | MEADOW、SNOWPEAK | 変更なし（125 / 107,048 / 34、129 / 112,768 / 36） |

### 基準の更新（M6-05）
- BASELINE の harbor / forest / volcano / skyline は v16 の値（上の表）。meadow / canyon / snowpeak / neon は v15 のまま（再計測で M5-05 と同じ）。
- 新コースの描画（グリッド視点のドロー / 三角形 / メッシュ）: HARBOR 129 / 110,460 / 47、FOREST 134 / 133,980 / 38、VOLCANO 132 / 100,648 / 37、SKYLINE 136 / 90,174 / 40。
- darwin の golden は 27 枚（新コースの場面 22、ミニマップ 4、タイトルとコース選択 1）を、更新なしで照合した。描画の時計は 0 に固定した（アイテムボックスの回転が別の時計を使うため）。linux の golden は CI で作る（pending-ci）。

### E2E の総時間
`VITE_KART_DEBUG=1 npm run build` を 1 回だけ行い、`npm run e2e -- --update-snapshots=none --global-timeout=3600000` を単独（workers 1）で流した。

| 項目 | 値 |
| --- | --- |
| 結果 | **29/29 通過** |
| 総時間 | **23.9 分**（1437.15 s = 23 分 57.15 s） |
| 内訳 | コース 16.9 分、対戦 5.9 分 |
| `npm test` | 45 ファイル、1772 件、98.45 s |

全体の実測は 35 分未満。CI の予算は 45 分、1 テストの上限は 300 s のまま。workers 2 は要らなかった。linux CI の所要時間は未計測。

### M7 に送ったもの
`.omc/followups.md` の「v6 M6 後回し一覧」のとおり。

## v6 M7（モード・CPU 難易度・ゴースト・プロトコル v17）
1 人用に 3 つのモード（レース / グランプリ / タイムアタック）と CPU 難易度（やさしい / ふつう / つよい）を足した。通信の版は v17 に上がった。数値は実ファイル（`src/net/protocol.ts`、`src/sim/*.ts`、`src/gp/grandPrix.ts`、`src/ghost/*.ts`、`src/storage.ts`）と、`243ceff`（M7-00）のコメントから取った。計測は darwin-arm64。

### プロトコル v17 と pin
- `PROTOCOL_VERSION` は 17、`ROOM_PREFIX` は `pcircuit-v17-`（`src/net/protocol.ts`）。**対戦は両者とも新ページが必要**（v16 のルームは拒否する）。
- 上げた理由は `isRaceState` が `RaceState` のキー集合を完全一致で見ること。`race_end.finalState` に `cpuLevel`（`'easy' | 'normal' | 'hard'`、必須）が載るので wire の形が変わる。Course / Welcome / RaceStart は変えていない。
- オンラインの部屋は常に `normal` の CPU とレース UI で走る。ホストもゲストも `createRace` に `cpuLevel` を渡さない。難易度を対戦に載せるのは v18 以降。
- `LAYOUT_FINGERPRINT` は **`aa03c454` のまま**（`snapshotCodec.test.ts` に `16: 'aa03c454'`、v17 も同値）。スナップショットのバイトは変えていない。
- `COURSE_FINGERPRINT` の pin は `pinned[17] = 513548114`（= `pinned[16]`。M7 はコース定義を変えていない）。`pinned[16]` 以前は残す。

### sim 指紋 pin
`sim.test.ts` の `sim fingerprint` は、M7-00 着手前のツリーで採った値を先にコミット（`f072d50`）してから実装した。normal の CPU が従来の経路と bit-exact であることの証明になる。

- 条件: seed 7、8 CPU（`racers: []`）、`getAIInput` で 1800 tick。
- 指紋: 全 karts の `[x, z, speed, trackDistance, heading]` を `JSON.stringify` し、FNV-1a（32 bit）にかけた値。
- 値: meadow `1966540717`、neon `1211865273`。

### CPU 難易度（`src/sim/race.ts`、`src/sim/ai.ts`）
`RaceState.cpuLevel` に持つ。人間のカートは影響を受けない。**normal は従来のコードをそのまま通り、×1 の乗算もしない**（bit-exact）。

| 項目 | easy | normal | hard |
| --- | --- | --- | --- |
| CPU の基準速度の係数（`CPU_SPEED_EASY` / `CPU_SPEED_HARD`） | ×0.93 | なし | ×1.04 |
| ラバーバンドの clamp（人間との進行差 / 1800 に掛ける補正） | −0.04 〜 0 | −0.02 〜 +0.04 | −0.01 〜 +0.06 |
| ドリフト窓（`driftWindow <` の値、窓の周期は 220） | 70 | 115 | 150 |

- 基準速度は `30.2 + (id % 3) × 0.35` に係数を掛け、その後にラバーバンドを掛ける。easy は人間に追いつかない（上限 0）。hard は人間の後ろに付いたとき最大 +6%。
- 実測（H7、`handling.test.ts`。8 CPU、seed 1 / 42 / 98765、3 周の meanLap。かっこ内は normal の BASELINE との比）:

| コース | easy | hard |
| --- | --- | --- |
| meadow | 73.0414 s（1.0663） | 66.6086 s（0.9724） |
| skyline | 72.5565 s（1.0773） | 64.7785 s（0.9618） |

  受け入れは easy ≥ 1.04 × BASELINE、hard ≤ 0.975 × BASELINE、壁・帯ヒット各 ≤ 6（skyline は落とし穴も ≤ 6）。skyline hard は壁 1 回。normal の BASELINE（v15 / v16 の 8 本）は動かしていない。
- 難易度は 1 人用のレースとグランプリで効く。タイムアタックは CPU がいない。

### `createRace` の options
- `karts`（1〜8、既定 8）: カート台数。範囲外・非整数は `RangeError`。`racers` が `karts` を超えても `RangeError`。
- `itemBoxes`（既定 true）: false で箱を置かない。
- `cpuLevel`（既定 `'normal'`）。未知の値は `RangeError`。
- タイムアタックは `{ karts: 1, itemBoxes: false }`。レンダラーは `boxSlots = max(initial.boxes.length, track.boxPoses.length)` でアイテムボックスのインスタンスを確保する（箱の無いレースで作ったレンダラーを、次の箱ありレースが再利用するため）。

### グランプリ（`src/gp/grandPrix.ts`）
- **オフライン専用で、永続化しない**（再読み込みで破棄）。オンラインでは選べない。
- カップは 2 本、各 4 コース（周回数はタイトルで選んだ値）。

| カップ | コース |
| --- | --- |
| SUNRISE CUP | meadow、canyon、snowpeak、neon |
| HORIZON CUP | harbor、forest、volcano、skyline |

- 得点 `GP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1]`（1 位から 8 位）。順位は既存の `getRank` を使う（結果画面と同じ。完走者はゴール時間順、未完走者は進行順）。未完走（DNF）の車も、その順位位置の得点を受ける。
- 総合順位のタイブレーク: 総得点の多い順 → 直近のレースの順位が良い順 → kart ID が小さい順。
- `recordRace` は 5 レース目を `RangeError` で拒否する。4 レース終わると `isComplete` が true。
- レース・グランプリのベストは `best.v4` を難易度に関係なく更新する（1 人用のみ）。

### タイムアタック（`src/ghost/*`、`src/main.ts`）
- 1 台・箱なしの sim（上の `createRace` options）。並走する「ゴースト」は、保存した入力を第 2 の `RaceState`（同じ seed、`karts: 1`、`itemBoxes: false`）に毎 tick 流して再生する。座標は保存しない。
- **入力量子化**: タイムアタック中は kart 0 の入力を `stepRace` に渡す前に `quantizeInput` し、記録 = 実際に sim へ入った値にする（steer は `round(×127)/127`、throttle は `round(×255)/255`）。`main.ts` の `stepOnce` が recorder 経由で 1 本化している（debug の `advance()` も同じ経路）。通常レースは量子化しない。
- **形式**（`GhostRecord`、`GHOST_FORMAT = 1`）: `format`、`trackId`、`layout`、`laps`、`seed`、`time`、`lapTimes`、`ticks`、`frames`、`checkpoints: { tick, distance }[]`。
- **RLE codec**（`codec.ts`）: 同じ入力が続く間を 1 つの run にし、run は 3 バイト + 長さ。steer は int8（−127〜127、−128 は不正）、throttle は uint8、flags は bit0 = brake、bit1 = drift、bit2 = useItem（> 7 は不正）、長さは符号なし LEB128。全体を base64 にする。復号は不正な run・長さ 0・総 tick 数との不一致を拒否する。
- **チェックポイント**: `CHECKPOINT_INTERVAL = 600` tick（10 s）ごとの kart 0 の `trackDistance`。ゴースト再生中に値が 1 つでも違うと `diverged` を立て、ゴーストを描かない。
- **上限**: `MAX_GHOST_TICKS = 36000`（10 分）。超えた走行は保存しない（`finish()` が null）。localStorage の容量超過は握りつぶす。
- **保存の規則**（`finishTimeAttack`）: ゴールタイムが保存済みのゴーストより速いときだけ `saveGhost`。ベストラップ（`lapTimes` の最小）も別に、速いときだけ `saveBestLap`。`best.v4` には触れない。コースの `layout`（layoutVersion）と周回数が一致しない記録は読まない。
- **ゴーストの描画**: 本体の半透明（不透明度 0.4、`depthWrite: false`）のコピー。ロスターの外にあり、**ミニマップにも影にも出さない**。コース再構築で破棄される。

### 保存（localStorage）
| キー | 内容 |
| --- | --- |
| `pocket-circuit.best.v4` | 1 人用レースのコース別・周回数別ベスト合計タイム |
| `pocket-circuit.timeattack.v1` | タイムアタックのゴースト（`trackId` → 周回数 → `GhostRecord`） |
| `pocket-circuit.bestlap.v1` | タイムアタックのコース別ベストラップ（`{ time, layout }`） |
| `pocket-circuit.cpu-level.v1` | CPU 難易度（`easy` / `normal` / `hard`、不正値は `normal`） |

ミュート（`muted.v1`）・ステア感度（`steer-sensitivity.v1`）・ハンドルアシスト（`steer-assist.v1`）は M7 以前から。

### タイトルのレイアウト（`src/style.css` 末尾）
- モード行（レース / グランプリ / タイムアタック）、グランプリ時のカップ行、CPU 難易度行を足した。
- 縦画面のスマホ（`max-width: 700px` かつ portrait）: `.title-description` を隠し、`.title-screen` を縦スクロール（`overflow-y: auto`、`overflow-x: hidden`、`touch-action: pan-y`）にして、すべての選択肢と開始ボタンに届くようにした。オンラインのパネルは下端に固定する。
- 短い横画面（`max-height: 480px` かつ landscape）: 同様に縦スクロール。コースの帯は文書の流れに入れる。
- 実機での見た目は人の目視が要る（followups の M7 節）。

### M8 に送ったもの
`.omc/followups.md` の「v6 M7」節のとおり。M8 はオンラインの安定化、M9 は保守。


## v6 M8（オンライン安定化・プロトコル v17 のまま）
ロビーのコース切替で切断される問題（C-010）と、悪回線でのゲストのジッターを直した。**通信の版は v17 のまま**で、スナップショットのバイトも変えていない。数値は実ファイル（`src/net/guestSession.ts`、`src/net/renderClock.ts`、`src/net/interpolation.ts`、`src/net/netQuality.test.ts`、`e2e/network.spec.ts`）と M8 のコミットメッセージ（`f923ff8` `4fcae9b` `33004af` `7e72f99` `f13ab3b` `43463c7` `b045877` `ff6194a` `6dbaf68` `ec37436`）から取った。E2E は darwin、Chromium、2 ページ、実 PeerJS。

### wire は不変（v17）
- `PROTOCOL_VERSION` は 17、`ROOM_PREFIX` は `pcircuit-v17-`。`LAYOUT_FINGERPRINT` は `aa03c454`（v14〜v17 は同値）。`COURSE_FINGERPRINT` の pin は `pinned[17] = 513548114` のまま（M7 と同じ。M8 はコース定義を変えていない）。M7 から版を上げない。
- 版を上げずに済んだ理由: ホストはロビーで `course` を送ったあと必ずレンダラーを再構築する。つまりゲストが `course` を受け取ること自体が「ホストがこれから数秒止まる」予告になる。専用の制御メッセージ（案: `rebuilding`、v18）は同じ情報を持つので足さない。

### ロビーの生存判定（`src/net/guestSession.ts`）
- ゲストが `host_lost` と判定する条件（ロビーとリザルト）は、ホスト由来の**最後の受信**からの経過時間が閾値以上のとき。「最後の受信」は、ホストからの PING、有効な PONG、すべての制御メッセージ（`welcome` / `roster` / `course` など）で更新する。以前は PONG だけだった。
- 閾値は `LOBBY_TIMEOUT_MS = 5000`。ただし `course` を受信してから `COURSE_GRACE_MS = 10_000` の間は閾値が 10 s になる（`graceUntil = now + COURSE_GRACE_MS`）。ホストの再構築で止まる時間の予告として使う。猶予の期間中は 5 s で切れない。
- レース中は不変: スナップショットの無音が 1500 ms で stall 表示、5000 ms で `host_lost`。猶予はレース中には効かない（ロビーとリザルトのみ）。
- 接続中の `timeout`（5 s）も不変。
- 副作用: コース切替の直後 10 s 間は、本当にホストが落ちた場合の検知が最大 10 s に伸びる。猶予内でも PING や制御メッセージが届けば「最後の受信」は更新される。
- `hostSession.test` のロビー停止ケースは、猶予に合わせて停止を 5.6 s から **10.6 s** にした。通常の 5 s は `guestSession.test` の (b) が固定している。M6-07 の履歴の数値は動かない。

### C-010 の根本原因と対策（`43463c7`、M8-01）
- **根本原因**: ロビーでコースを変えるたびに `recreateRenderer` が `THREE.WebGLRenderer` を作り直し、古い方を `dispose()` していた。`WebGLRenderer.dispose()` は three のプログラムキャッシュを捨てるため、新しいレンダラーが全シェーダーを再コンパイルする（スイッチごとに 13〜14 プログラム）。しかも古いレンダラーのプログラムが回収されず、約 7 つずつリークしていた。M6 の「GPU を奪い合う 2 ページで 3.9〜4.3 s」の大半はこの再コンパイルだった。
- **対策**: `GameRenderer` に既存の `WebGLRenderer` を注入できるようにし、ロビーの再構築を次の順にした。
  1. 共有の `WebGLRenderer` 上で新しいシーンを**構築**する。
  2. 1 回**描画**する（プログラムはキャッシュに命中する）。
  3. 描画先の所有権を新シーンに**引き渡す**。
  4. 最後に**旧シーンだけを `dispose()`** する。
  この順序が本質。material の `dispose()` は使用数が 0 になった時点でプログラムを削除するため、旧シーンを先に壊すと共有プログラムが消える。
- **実測（2 ページ、実 PeerJS、ロビーのコース切替 5 回 × 3 run）**:

| 項目 | 修正前 | 修正後 |
| --- | --- | --- |
| 生存プログラム数 | 13 → 40（増え続ける） | 13〜16（安定） |
| 1 回の切替でコンパイルされるプログラム数 | 13〜14 | 1〜4（neon 固有の分は戻るたびに再コンパイル） |
| 最長フレーム間隔 ホスト | 2.35〜4.47 s | 0.25〜0.99 s |
| 最長フレーム間隔 ゲスト | 2.45〜4.04 s | 0.40〜1.97 s |

- `courses.spec` の geometry テストは、`disposedGeometries === 0` の検査（新規 `WebGLRenderer` 前提）をやめ、geometries / textures / programs が有界であることと、2 周目 == 1 周目を検査する。
- 最終 dispose でも共有アイテム資源は保持する（同一ページで再初期化を繰り返すとリスナーが残る。followups の M8）。

### 見送った試行: M8-01b（neon の material キャッシュ）
- neon 固有の 3 マテリアルを保持し、起動時にウォームアップする案を試した。再コンパイルは消えたが、ロビー切替のゲストの `frameGap` は **1,750〜1,917 ms** のまま変わらなかった。
- 原因は再コンパイルではない。neon の構築 CPU（154〜171 ms。`roadHeightAtXZ` が 75〜92 ms で、他コースの約 5 倍）と、その後のネイティブ時間、2 ページのテストが 1 つの GPU を共有することの合算。
- 差分は**破棄**した。T1 のゲスト予算は下の再仕様化で 2,500 ms にした。neon の構築コストは M9 送り。

### E2E の予算の再仕様化（`e2e/network.spec.ts`、司令塔、2026-10-15）
M8-07 の E2E（T1〜T4）を実測したところ、設計時の予算が当たらなかった。実装を直すのではなく、予算を実測と理由つきで改めた（`6dbaf68`、`ec37436`）。

- **T1（8 コース連続切替）**: 伝搬 ≤ 1,000 ms、ホストのフレーム間隔 ≤ **1,500** ms、ゲスト ≤ **2,500** ms。訪問済みの meadow に戻るときはホスト・ゲストとも ≤ 1,000 ms で、プログラム数は戻る前後で同数。総プログラム数は P0 + 8 以下（P0 = 13、最大 16）。
  - 理由: 1,500 ms は単独のホストの目安。ゲストは neon で 1,450 ms（単独）、1,783〜1,833 ms（全体 run）、最大 1,917 ms（M8-01b 試行）が出た。原因は上の neon の構築 CPU・ネイティブ時間・2 ページが共有する GPU で、キャッシュでは消えない。M8-01 の前は 3,900〜4,300 ms。2,500 ms は `COURSE_GRACE_MS`（10,000 ms）の 1/4 で、猶予の内側に十分収まる。
- **T3（15 s の遅延・ジッター・ロス・バースト下のレース）**: 劣化は `latencyMs 120 / jitterMs 50 / lossRate 0.1 / seed 3`、3 s ごとに 400 ms の `+200 ms / loss 0.4` のバースト。5 s 後の最初の標本 ≥ 140 ms、5〜15 s の最大 ∈ [140, 250] ms、**全標本 ≤ 250 ms**、レンダー時刻の逆行 0、stall 0、ダイアログなし。
  - 回復: 劣化を外す前の 5 s（走行中・無劣化）で**同一レースの基準 B** を測り、劣化解除後 10 s 以内に、**同じ 1 標本**が `≤ max(110, B + 30)` かつ `≤ 劣化中の最大 − 50` を満たすこと（100 ms 周期で標本）。
  - 理由: 旧基準「解除 6 s 後に ≤ 110 ms」は、3 s 窓と 5 %/s のスルー（250 → 110 に落ちるだけで約 2.8 s）に加え、2 ページの headless 環境そのものの雑音（無劣化でも B ≈ 150 ms）で、136 ms / 123.675 ms と落ちた。絶対値では環境ごとの雑音を拾うので、同一レースの B を基準にした。また「5 s 後の全標本 ≥ 140 ms」は、バーストの合間に遅延が下がる設計（112 ms を観測）を弾くため、最初の標本と最大値だけを見て、上限は全標本に課した。
  - 実測: B = 146.055 ms（限界 176.055）で 174.020 ms @ 4,738 ms に回復（単独）。B = 152.880 ms（限界 182.880）で 179.435 ms @ 4,755.6 ms（全体 run。劣化中の最大 250 ms より 70.565 ms 下）。B は単一標本（中央値化が望ましい。followups）。
- **T2**: コース変更の直後にホストを `busyWait` 4.5 s 止めても、ロビーが保たれ、続くレースが走る。**T4**: ロビーのホスト喪失は 10 s 以内にダイアログを出し、OK でタイトルに戻る。
- 全体: 39 件を 1 build・1 worker・retries 0 で **39 passed (25.5m)**、壁時計 1527.573 s（35 分未満）。既存のスクリーンショット 47 ファイルの SHA-256 は実行前後で同一。
- T1 実測（全体 run、ms。ホスト/ゲストはフレーム間隔の最大。`ec37436`）:

| コース | 伝搬 | ホスト | ゲスト | プログラム数 |
| --- | --- | --- | --- | --- |
| canyon | 120.7 | 733.3 | 983.3 | 13 |
| snowpeak | 118.0 | 383.3 | 400.0 | 12 |
| neon | 143.0 | 983.3 | 1783.3 | 16 |
| harbor | 120.6 | 250.0 | 233.3 | 12 |
| forest | 113.3 | 583.3 | 850.0 | 13 |
| volcano | 128.9 | 366.6 | 466.6 | 12 |
| skyline | 111.5 | 850.0 | 1049.9 | 13 |
| meadow | 85.1 | 283.3 | 583.3 | 13 |

  単独 run は neon がホスト 783.2 / ゲスト 1449.9、meadow がホスト 216.7 / ゲスト 366.6。

### 適応表示遅延（`src/net/renderClock.ts`）
ゲストの他車の補間は、固定 100 ms の表示遅延から、ジッターに追従する遅延に変わった（`4fcae9b`、`7e72f99`）。

- 定数: `BASE_RENDER_DELAY_MS = 100`、`MAX_RENDER_DELAY_MS = 250`、`JITTER_WINDOW_MS = 3000`、`MIN_JITTER_SAMPLES = 10`、`JITTER_DEADBAND_MS = 2`、`DELAY_SLEW = 0.05`、`OFFSET_SLEW = 0.05`。外挿上限 `MAX_EXTRAPOLATION_MS = 100`（`interpolation.ts`）は不変。
- `JitterEstimator`: スナップショットごとに `到着のローカル時刻 − snapshot.hostTime` を標本にする。時計オフセットは定数なので引き算で消え、ロスの影響も受けない。3 s の窓で `p95 − min` を取り、標本が 10 未満または 2 ms 未満（デッドバンド）なら目標は 100 ms、それ以外は `100 + 値` を [100, 250] に丸める。
- `RenderClock`: 表示遅延とクロックオフセットの段差を、どちらも毎秒 5 %（50 ms/s）で目標に近づける。表示するホスト時刻は前進のみで、前進の速さは経過時間の 90〜110 %。`hostTime(now)` と `JitterEstimator.target(now)` は状態を変えるので、呼び手はそのフレームの `now` 以外で呼ばない。
- `GuestSession` の既定は `renderDelay: 'adaptive'`。`'fixed'` を渡すと従来の 100 ms 固定（`renderDelayMs` は `INTERPOLATION_DELAY_MS`）に戻る。
- **保証の再定義**: M6-07 の「age ≤ 100 ms で誤差 < 1.0 m」は**実際の遅延に対する基準**になった（`age = 表示するホスト時刻 − 最新スナップショットの送信時刻`）。固定遅延の条件では遅延が 100 ms に留まり、従来と同じ数値になる。誤差表（M6-07）、`netMotion` の ≤ 1.0 m、`predictor.test` seed 92 の ≤ 0.05 m は動かない。
  - 履歴テストの基準 tick は `hostTick − renderDelayMs / TICK_MS` に変え、その条件で `renderDelayMs === 100` を毎フレーム検査する（従来の `− 6` と同値）。
  - **fixed と adaptive の同値**: ジッター 0 の mock（RTT 120 ms、loss 10 %、seed 92、meadow、600 フレーム）で、両モードの描画ポーズが `toEqual` で完全一致する。ジッター 0 では遅延が 100 ms から動かない。

### interpolateState の tick 分母（`src/net/interpolation.ts`）
- 速度・ヨー率・y 速度・弾の速度の外挿に使う分母を、壁時計の `duration`（`to.hostTime − from.hostTime`）から、`rateDuration = (to.tick − from.tick) × TICK_MS` に変えた。位置の補間 `alpha` は従来どおり壁時計。
- 理由（既存のバグ）: ホストが約 15 fps 以下だと、同じ rAF の中で 2 枚のスナップショットが約 0.3 ms 差で出る。分母が 0.3 ms になり、外挿が 100 倍以上に発散していた。tick 差は壁時計差と一致する固定遅延の mock では同値なので、M6-07 の表は動かない。
- 範囲: M8 は分母の修正だけ。ホストのバンチングを根本から直す tick ベースのタイムラインは M9 送り。

### netQuality の指標（`src/net/netQuality.test.ts`、`f13ab3b`）
固定と適応を、同じ劣化プロファイルで決定的に比べる。予測 on、レース seed 431、`MockTransport`、host の AI 入力、他車（id ≠ 1）だけを対象にする。各 run は racing のまま、`reason` は null、stall 遷移 0、レンダー時刻の逆行 0。

- **pops**: 他車 1 台・1 フレームごとに、前フレームからの変位が `2 × |speed| × dt + 0.1 m` を超えた回数。ホストの権威的なワープ（同じ区間の tick で `popLimit` を超える移動）は数えない。
- **freezes**: `|speed| > 5` なのに変位が 0.01 m 未満のフレーム数。
- **max err**: adaptive の run のみ。`age ≤ 100 ms` の標本だけで、描画ポーズと、ホスト履歴を表示 tick で線形補間した位置との距離の最大値。< 1 m を検査。
- **delay**: 表示遅延の最小〜最大。adaptive は常に [100, 250] で、レンダー時刻の前進は経過時間の 0.85〜1.15 倍。
- プロファイル: **P1（jitter）** = `latencyMs 60 / jitterMs 60 / lossRate 0.2 / seed 92`、600 tick。**P2（spiky）** = `latencyMs 60 / jitterMs 15 / lossRate 0.05 / seed 7`、900 tick、3 s ごとに 400 ms の `+200 ms / loss 0.4` のバースト。
- 受け入れ: P1 は fixed の pops ≥ 20 かつ adaptive の pops・freezes が fixed の半分以下。P2 は adaptive が fixed 以下。
- **当初の P1 は 60±40 ms、loss 0.1**だった。fixed の pops が **0** で、比較の前提（固定遅延では pops が出る）が成り立たなかった（adaptive も 0 で、遅延 100〜178 ms、誤差 0.2013 / 0.1927 m）。司令塔の判断で 60±60 ms、loss 0.2 に強めた。

| プロファイル | コース | モード | pops | freezes | max err (m) | delay (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| P1 jitter（当初 60±40） | meadow | fixed | 0 | 0 | - | 100-100 |
| P1 jitter（当初 60±40） | meadow | adaptive | 0 | 0 | 0.2013 | 100-178 |
| P1 jitter（当初 60±40） | skyline | fixed | 0 | 0 | - | 100-100 |
| P1 jitter（当初 60±40） | skyline | adaptive | 0 | 0 | 0.1927 | 100-178 |
| P1 jitter（採用 60±60） | meadow | fixed | 27 | 42 | - | 100-100 |
| P1 jitter（採用 60±60） | meadow | adaptive | 0 | 0 | 0.7584 | 100-211 |
| P1 jitter（採用 60±60） | skyline | fixed | 29 | 42 | - | 100-100 |
| P1 jitter（採用 60±60） | skyline | adaptive | 0 | 0 | 0.4872 | 100-217 |
| P2 spiky | meadow | fixed | 89 | 441 | - | 100-100 |
| P2 spiky | meadow | adaptive | 42 | 210 | 0.7776 | 100-250 |
| P2 spiky | skyline | fixed | 82 | 427 | - | 100-100 |
| P2 spiky | skyline | adaptive | 68 | 294 | 0.4069 | 100-250 |

- spiky では adaptive でも pops が 42 / 68 残る（バースト中は最大 250 ms でも吸収しきれない）。遠隔カートの視覚平滑化は M9 送り。
- 悪回線の代償: 遅延は最大 250 ms まで伸びるので、**他のプレイヤーは最大 250 ms 遅れて見える**（自車は予測で遅れない）。

### ImpairingTransport は debug ビルド限定（`src/net/impairedLink.ts`、`b045877`）
- 遅延・ジッター・ロス・バーストを seed 付き（mulberry32）で `Transport` に与えるラッパー。`validate` が不正値を `RangeError('Invalid impairment profile')` で拒む。
- `src/main.ts` は `import.meta.env.DEV || import.meta.env.VITE_KART_DEBUG === '1'` のときだけ動的 import してラッパーを挟む。本番ビルドではこの条件が静的に偽で、**モジュールも `__kartDebug`（`impair()`、`busyWait`、`frameGap`、`render.programCount`）も dist に含まれない**。E2E は `__kartDebug.net.impair()`（async、検証後にコピーを保存）で切り替える。stall の回数はセッションごとに 0 に戻る。
- `MockTransport` にも `hold` / `release`（主スレッド停止の模擬）と `bursts` を足した（`f923ff8`）。バーストなしの乱数消費は HEAD と同一（35 構成で確認）。

### CDP の絞りを使わない理由
CDP のネットワーク絞りは HTTP スタックにだけ効き、WebRTC のデータチャネル（PeerJS のゲーム通信）には効かない。絞っても対戦の通信が劣化しないので、アプリ内で `ImpairingTransport` を挟む。

### 基準の更新
- 変更なし: `PROTOCOL_VERSION` 17、`pinned[17]`、`LAYOUT_FINGERPRINT`、コース指紋、M6-07 の誤差表、sim 指紋 pin。スクリーンショットの golden は更新していない。

### M9 に送ったもの
`.omc/followups.md` の「v6 M8」節の「M9 送り」のとおり。neon の構築コスト、実回線の適応遅延の基準、遠隔カートの視覚平滑化、tick ベースのタイムライン、初回アイテム material のコンパイル、途中再参加、および M7 から続く保守項目。

## v6 M9（保守・プロトコル v17 のまま）

M8 から送られた保守項目を片づけた。wire・`PROTOCOL_VERSION`・`LAYOUT_FINGERPRINT` は動かしていない。値は `16fa30f`〜`dc4683a`（M9-02 `16fa30f`、M9-01 `8d04b27`、M9-00 `bfdf79b`、M9-03 `e337a79`、M9-04 `d2e2c3b`、M9-05 `e8a5f67`、M9-06 `dc4683a`） のコミットメッセージと該当ファイルによる。

### 画面 golden の platform ゲート（`e2e/courses.spec.ts`、M9-00）
- golden は「その platform のディレクトリに同名のファイルがあれば照合、無ければ `golden-skipped` の注釈を付けて照合だけを省き、他の検査は続ける」。従来の darwin 固定をやめた。
- `KART_GOLDENS=write` は常に照合（`--update-snapshots` と併用して書き出す）。`KART_GOLDEN_PLATFORM` は存在確認の platform だけを差し替え、書き出し先は変えない。
- 閾値は `threshold: 0.2`, `maxDiffPixels: 0` と明示した。Playwright の既定と同じ値で、緩めてはいない。将来の変更が diff に出るようにするためである。darwin の 27 枚は SHA-256 不変で 5/5 通過し、`KART_GOLDEN_PLATFORM=linux` では 5/5 が skip 注釈つきで通る。`harbor-narrow.png` に 1 px 変えると TIDEWATER が「1 pixels ... different」で落ちることを確認し、元に戻した。
- 手順（linux golden の取得）: `.github/workflows/goldens-linux.yml`（`workflow_dispatch` のみ、ubuntu-latest）を dispatch → step A で `KART_GOLDENS=write` で書き出し → step B で同一 runner のまま書いた golden に再照合（SwiftShader が run 内で決定的かの証明）→ step C で artifact `linux-goldens`（`e2e/__screenshots__/linux/`、保持 14 日）を upload。B が通ったら artifact を `e2e/__screenshots__/linux/` に commit する。以後は linux でも自動で照合される。B が通らなければ commit しない。
- 対象は TIDEWATER / MOSSWOOD / EMBER / STRATOS / title-eight-courses（`-g 'TIDEWATER|MOSSWOOD|EMBER|STRATOS|eight-course'`）。darwin の golden は 27 枚。
- drawCalls / triangles の完全一致は緩めない。three の `info.render` は CPU 側のカウンタで GPU に依存せず、linux でも一致するはずだから。この理由は `courses.spec.ts` にコメントした。

### roadIndex（`src/render/course/roadIndex.ts`、M9-01）
- `roadHeightAtXZ` を 32 m 格子（`CELL_SIZE = 32`）の候補集合で引く。各区間を壁の半幅 + `MAX_MARGIN`（22 m）+ 1e-6 で広げて格子に登録し、候補は元の区間 index の昇順で走査する（同距離タイは先勝ちで、総当たりと同じ）。`margin` が 22 を超えると `RangeError`。
- 同値性: 総当たりの算術（符号つきゼロを含む）をそのまま使い、総当たりの参照実装は未変更で export して検証に使う。8 コース × 20,000 点 × 2 × 3 × 2 の行列、計 1,920,000 回の `Object.is` 比較が全て一致した（22.385 s）。`buildCourse` の形状 signature（`buildCourse.test.ts:128/180`）は不変で、既存 75 ケースが通った。
- 時間（darwin-arm64、Node 25.8.1、Vitest 4.1.11、neon の `buildCourse` を 5 回ウォームアップ後の中央値）: インデックスあり 33.911 ms、総当たり 179.301 ms（18.91%、-81%）。どちらもインデックス構築を含み dispose を除く。値は報告のみで assert しない。
- 効果の限界: ロビー切替のゲストの `frameGap` は neon でも約 1.8 s のまま（T1 で ホスト 883.2 ms / ゲスト 1816.6 ms、予算 1,500 / 2,500 ms）。主因は構築 CPU ではなくネイティブ / GPU 側と判断した。

### FOREST の racingLine（`src/sim/tracks/forest.ts`、M9-02）
- 従来は両端 offset 0 の 2 点だけだった。20 キーに増やした: ヘアピンは外→内→外（東 3 / -7.4 / 3、北 3 / -7.9 / 3）、左カーブは内側、S 字は浅く、デッキ・狭路・アンダーパス・小川のジャンプは offset 0。
- CPU のみが使う（`ai.ts` と `corridor.ts`）。人間・ゴースト・ベストは `racingLineOffset` を使わないので `layoutVersion 1`、ghost、best は無傷。
- 新 BASELINE（`handling.test.ts`、`version: 'm9'`）: 8 CPU × seed 1 / 42 / 98765 × 3 周 = 72 周で meanLap 69.52407407407406 s（旧 70.53587962962963 s、-1.43%）、wallHits 0、bandHits 0。他の seed 組 [2,3,4]、[7,1000,31337]、[5,6,8]、[7,2026,314159] でも速くなった。easy / hard の新 BASELINE に対する比は 1.0554 / 0.9773（記録のみ）。
- ジャンプ通過時の横ずれ上限を 1.5 → 2.55 m に改めた（司令塔の判断）。`getAiLineOffset` が全コースで足す sin×2.5 の蛇行のためで、旧い中央線でも 2.50 m だった（実測 2.500223 m）。

### COURSE_FINGERPRINT と pinned[17]（M9-02）
- `COURSE_FINGERPRINT`（`src/sim/tracks/index.ts`）は全 TrackDef の JSON を指紋化するので racingLine を含む。`snapshotCodec.test.ts` の `pinned[17]` を **1316474231** に更新した。
- **プロトコルは v17 のまま**。hello は `protocol !== 17 || course !== COURSE_FINGERPRINT` を `reject('version')` するので、旧ビルドとの混在は版を上げなくても弾かれる。前例（M5→v15、M6→v16）はコース変更で版を上げているが、今回は CPU の走行ラインだけで人間の入力・状態・wire は変わらないため据え置いた（司令塔の判断）。

### タイムアタックの表示（M9-03）
- `#item-display` は timeattack で非表示（「ボックスを取ろう」を出さない）。パネルの文言だけを省き、タッチのアイテムボタンは同期を続ける。
- ゴーストの車輪が回る: `GameRenderer.updateGhost` が `dt` を取り、ロスターと同じ式で `rotation.x` を進める。デバッグブリッジに `render.ghost { visible, wheelSpin }` と `ghost.speed`（debug ビルドのみ）。`modes.spec` が 500 ms で wheelSpin が 1 rad 以上増えることを検査する。記録と再生には影響しない。

### 縦画面のタイトルの幾何不変量（`e2e/layout.spec.ts`、M9-04）
- 縦画面のみ: `.title-screen` はトップバーの下端（`--topbar-bottom`）から始まる。スクリムはスクロール領域全体の背後に固定し、`#online-entry`（bottom sheet）は `max-height: min(40vh, 160px)`、スクローラの下余白はそれ + 16 px。
- 検査（360×640、390×844、844×390 の 3 ビューポート）: 縦画面でスクローラ上端 ≥ トップバー下端、最大スクロール時にコース選択の帯の下端 ≤ sheet の上端、横スクロールなし、コース 8・モード 3・開始ボタン 1 の各 44×44 px 以上。加えて 390×844 でホスト注意文が見出しと重ならない。4 件通過（37 s）。1280×720 の `title-eight-courses.png` は不変。
- 見た目の最終判断は目視。幾何不変量が固定するのは位置関係だけ。

### M7 の minor（M9-05）
- `recordRace` は trackId / phase / laps の不一致を `RangeError` で拒否する。
- `quantizeInput` は steer を [-1, 1]、throttle を [0, 1] に clamp し、NaN は 0 にする（保存できる 522,240 通りの入力は同じ符号化）。
- `GhostRecorder.checkpoint` は同じ tick の再呼び出しを無視する。
- `LobbyUI` は周回の選択肢を `LAP_CHOICES` から作る。`GrandPrixUI` の得点は `aria-label` ではなく視覚的に隠した文字で読み上げる。
- `modes.spec` のグランプリは強い CPU を選び、4 レースすべてで `state.cpuLevel === 'hard'` を確認する（単独 41.6 s）。各単体テストは修正を戻すと落ちる。

### jitterStats と T3 の基準（M9-06）
- `JitterEstimator.stats(now)` は窓（`JITTER_WINDOW_MS` 3,000 ms）の lateness を nearest rank（`ceil(n·q) - 1`）で `{ samples, minMs, p50Ms, p90Ms, p95Ms, maxMs }` として返す（窓が空か `now` が非有限なら null）。`target()` は不変（2 万回の比較が同一）、netQuality と guestSession の数値も不変。
- `GuestSession.latenessStats`（適応遅延時のみ。最後のフレームの `now` を使う）と、デバッグブリッジの `net.jitterStats`。`GuestSession` の getter 名を `jitterStats` にしなかったのは、その文字列を本番バンドルに入れないため（コミットメッセージ）。
- `network.spec` T3 の基準 B は、劣化前に 100 ms 間隔で取った 5 標本の中央値。回復条件は不変。単独 2 回通過（B = 120.5 / 121.9 ms）。5 s 時点でも標本はまだ下降中だった（M10 送り）。推定器そのものは変えていない。実機 2 台の lateness を取ってから見直す。

### 基準の更新（動いた pin / 動かない pin）
| pin | 状態 |
| --- | --- |
| `COURSE_FINGERPRINT` / `snapshotCodec.test.ts` の `pinned[17]` | 動いた: 1316474231（v17 据え置き） |
| `handling.test.ts` の forest BASELINE と `forest.test.ts` の実測コメント | 動いた: meanLap 69.524 s（`version: 'm9'`） |
| FOREST のジャンプ横ずれ上限 | 動いた: 1.5 → 2.55 m |
| `PROTOCOL_VERSION` 17、`ROOM_PREFIX` | 不変 |
| `LAYOUT_FINGERPRINT` aa03c454、sim 指紋（meadow / neon）、forest `layoutVersion 1` | 不変 |
| `buildCourse.test.ts` の形状 signature、courses.spec の 8 コース drawCalls / triangles | 不変 |
| darwin の golden 27 枚 | 不変（SHA-256 一致。linux は新規追加のみ） |
| netQuality の実測表、M6-07 の誤差表 | 不変 |

### M10 に送ったもの
`.omc/followups.md` の「v6 M9」節の「M10 送り」のとおり。

## v6 M10（16 コース・プロトコル v18）
コースを 8 本から 16 本に倍にし、ドリフトが必須のコース（SERPENT PASS）を足した。通信の版は v18 に上がった。sim 本体（`ai.ts` / `race.ts` / `corridor.ts`）は変えていない。数値は `.omc/plans/m10-design.md`、M10 のコミットメッセージ（`facd01a`〜`c38c138`）、各コースの `src/sim/tracks/<id>.ts` と `<id>.test.ts` の先頭コメントから取った。計測は darwin-arm64。

### 16 コースの一覧
`TRACK_IDS` の順（タイトルのコース番号 01〜16 の順＝カップ順）。

| 番号 | id | 名前 | カップ |
| --- | --- | --- | --- |
| 01 | meadow | MEADOW LOOP | SUNRISE |
| 02 | canyon | SUNSCAR CANYON | SUNRISE |
| 03 | snowpeak | FROSTBITE PEAK | SUNRISE |
| 04 | neon | NEON NIGHTLINE | SUNRISE |
| 05 | harbor | TIDEWATER HARBOR | HORIZON |
| 06 | forest | MOSSWOOD TRAIL | HORIZON |
| 07 | volcano | EMBER CALDERA | HORIZON |
| 08 | skyline | STRATOS CITY | HORIZON |
| 09 | dunes | SIROCCO DUNES | ZENITH |
| 10 | garden | BLOSSOM GARDEN | ZENITH |
| 11 | speedway | THUNDER OVAL | ZENITH |
| 12 | bayou | MOONLIT BAYOU | ZENITH |
| 13 | cavern | CRYSTAL HOLLOW | ECLIPSE |
| 14 | temple | SUNKEN TEMPLE | ECLIPSE |
| 15 | serpentine | SERPENT PASS | ECLIPSE |
| 16 | lunar | LUNAR BASIN | ECLIPSE |

### グランプリのカップ（`src/gp/grandPrix.ts`）
カップは 4 つ。`CUPS` を flatMap した順は `TRACK_IDS` と等しい。

| id | 名前 | コース |
| --- | --- | --- |
| sunrise | SUNRISE CUP | meadow, canyon, snowpeak, neon |
| horizon | HORIZON CUP | harbor, forest, volcano, skyline |
| zenith | ZENITH CUP | dunes, garden, speedway, bayou |
| eclipse | ECLIPSE CUP | cavern, temple, serpentine, lunar |

### 新しい 8 コース
すべて `layoutVersion: 1`、チェックポイント 24、`boxRows` 8。CPU 平均ラップは 8 CPU × seeds [1, 42, 98765] × 3 周（コースごと 72 周）の `handling.test.ts` の BASELINE（`version: 'm10'`）。平均速度は長さ ÷ 平均ラップ。壁 / 帯は `wallHits` / `bandHits`、pit は `pitFalls`（全コース 0）。drawCalls / triangles は `buildCourse.test.ts` の RENDER_BASELINE（Chromium darwin、seed 127、10 フレームで同一）。

| コース | テーマ | おもな仕掛け | 長さ (m) | CPU 平均ラップ (s) | 平均速度 (m/s) | 壁 / 帯 | drawCalls / triangles |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dunes | 夕暮れの砂漠（黄土色、紫の空） | 砂丘の稜線ジャンプ 3（216 回の着地すべて dirt）、長い dirt 2、±0.3 のバンクの S 字、幅 55% の峡谷 | 2,239.85 | 85.476 | 26.2 | 0 / 0 | 126 / 91,966 |
| garden | 春の日本庭園（桜、灯籠石） | 灯籠石の `islandSplit` 2、池の jump+pit（迂回あり）、木戸の gate、高低差 5.41 m | 2,309.59 | 65.242 | 35.4 | 0 / 0 | 123 / 105,118 |
| speedway | 夕方のスタジアム | 最速コース。±0.35 の長いバンク 2、boost 3 連、sweep 障害 1 | 2,256.39 | 63.363 | 35.6 | 0 / 0 | 125 / 73,308 |
| bayou | 夜の湿地 | 水面の pit 2、丸太の sweep 2、泥の dirt 2、丸木橋の deck（交差の高低差 18 m） | 2,225.08 | 68.798 | 32.3 | 0 / 0 | 127 / 79,339 |
| cavern | 地下洞窟（シアンとマゼンタの結晶） | 結晶の ice 2、鍾乳石の gate 2、幅 55% の狭路 2、deck 1 | 2,118.89 | 62.028 | 34.2 | 0 / 0 | 130 / 88,825 |
| temple | 密林の遺跡（金、苔、石） | 回転床 2、石扉 2（全開でも道路に 2.6 m 掛かる）、中庭の立体交差、boost、柱列の島（内側が 28.293 m 短い） | 2,254.10 | 63.467 | 35.5 | 0 / 0 | 138 / 97,474 |
| serpentine | 秋の山道（紅葉、灰色の岩） | ドリフト必須の狭いヘアピン 2（次節）、ヘアピン 1、高低差 20 m 以上（初回コミット時は 27.53 m）、バンク 1 | 2,328.60 | 68.324 | 34.1 | 1 / 0 | 123 / 110,066 |
| lunar | 月面（レゴリス、黒い空に地球） | クレーター 3 組（迂回あり）、dirt、居住チューブの deck、boost | 2,209.88 | 65.179 | 33.9 | 0 / 0 | 140 / 79,830 |

- 平均速度の実測（`speedway.test.ts` が BASELINE の元を読んで検査）: speedway 35.611 > temple 35.516 > skyline 35.491 > neon 35.488 m/s。上の表の平均速度は現行の長さ ÷ 平均ラップ（speedway はバンク修正で 2,211.31 → 2,256.39 m）。THUNDER OVAL が最速であることは実測の側で検査する。
- 長さは 2,100〜2,400 m の範囲。serpentine の長さは `SERPENTINE_LENGTH`（2,328.60）（初回コミット `d84e113` 時は 2,320.48 m。その後の形状の修正で変わった）。
- dunes は dirt が長く、平均ラップが他より約 25% 遅い（M11 送り）。
- meshes: dunes 32、garden 42、speedway 30、bayou 39、cavern 36、temple 43、serpentine 28、lunar 45。

### ドリフト必須のヘアピン（SERPENT PASS、M10-07）
`.omc/plans/m10-design.md` §3 の式から導いた値を、実走で確かめた。

- **旋回の式（`race.ts`）**: ドリフトなしの turnRate = max(1.72, 2.1 − (v − 15) × 0.025)。v = 32 で 1.725 rad/s、最小旋回半径は 18.6 m。ドリフト中は steering = 0.75·dir + 0.6·steer で最大 1.35、つまり 2.33 rad/s で、旋回半径は 13.7 m（さらに slip 0.23 rad の分だけ内側へ寄る）。
- **幅**: 路面は幅 50%（road 4.68 m）。中心線の半径 11 m 前後（実装は 11.043 / 11.937 m の逆向きの 2 つ）では、走れる帯が半径 5.1〜16.9 m になり、ドリフトなしの弧（18.6 m）は収まらず、ドリフト中の弧（13.7 m）は収まる。ヘアピンに roll と dirt は置かない（バンクは低い側への旋回を +30% し、dirt は旋回 ×0.85 のため、置くとドリフトなしでも曲がれてしまう）。
- **壁の半幅 5.60 m**（`444b04d`）: 当初の 6.825 m では、壁の手前の芝をブレーキで抜ける道ができた。壁の半幅を 5.60 m にして、road 4.68 m（50% の舗装）は保ったまま、カートの中心の限界を 5.60 − `KART_RADIUS`（0.95）= 4.65 m にした。これで芝の減速帯に入れない。
- **測定窓 [from − 20, to + 80]**（`2280280`、2026-10-16 の司令塔の判断）: 出口のドリフトターボを含めて、タイムと壁ヒットを比べる。初回の [from − 20, to + 20] は出口のターボを含まず不十分だった。
- **台本**（P 制御、seed 1、人間 1 台、アイテムなし。時間 s / 最高速 m/s / ヒット数）:

| 台本 | 下側のヘアピン | 上側のヘアピン |
| --- | --- | --- |
| A（全開・ドリフトなし） | 4.483 / 37.22 / 1 | 4.600 / 36.64 / 1 |
| B（ドリフトで抜ける） | 3.883 / 54.67 / 0 | 3.917 / 54.48 / 0 |
| C（ブレーキが遅い） | 7.067 / 37.22 / 0 | 7.467 / 36.64 / 0 |

  - A − B = 0.600 / 0.683 s（ヒットの判定には 0.5 s 以上の差が要る）。C − B = 3.183 / 3.550 s。B と C は壁に触れない。
- **総当たり**: 324 の制御器 × 320 のブレーキ / 惰行の台本（開始 40/25/15/8/3 m 手前、解除 進入/1/4/頂点/出口、目標 12〜25 m/s）を各ヘアピンで流した（スローダウン 103,680 回）。ドリフトなしで壁に当たらない最良は **4.383 / 4.417 s**、ドリフトの最良は **3.75 s**。余裕は **0.633 / 0.667 s**。全開のドリフトなしで壁に当たらないのは **0/324**（両ヘアピンとも）。ドリフトの勝者は壁に 1 度も触れない。
- **CPU**: AI は変えていない。`ai.ts:45` の曲率ブレーキで通れる。8 CPU × 3 seeds × 3 周 = 72 周を完走、平均 68.324 s、`wallHits` **1**、`bandHits` 0、`pitFalls` 0。
- 描画: 28 meshes、113,488 三角形（影込み）。

### プロトコル v18 と pin
- `PROTOCOL_VERSION` は 18、`ROOM_PREFIX` は `pcircuit-v18-`（`src/net/protocol.ts`）。`PROTOCOL_TRACK_IDS` の値域が 16 に広がったため。**対戦は両者とも新ページが必要**（v17 のルームは拒否する）。
- `COURSE_FINGERPRINT` の pin は `pinned[18] = 2618543986`（`snapshotCodec.test.ts`、M10-10 で 16 コースがそろった後の値）。`pinned[17]` 以前は残す。`scaffoldIds()` は空配列（MEADOW のコピーだった仮コースは無い）。
- 不変: sim の指紋 pin（meadow 1966540717 / neon 1211865273、linux 1670404181 / 1324528798）と `LAYOUT_FINGERPRINT` `aa03c454`。スナップショットのバイトも変えていない。
- ガード: M10-00 が足した pending 行は M10-10 で全て確定した。tripwire が pending の行、整数でない描画値、pin されていない protocol の版を拒否する。

### コース選択 UI（M10-09）
- 選択肢は 16 個。デスクトップは **2 段 × 8**（44×44 px）で、周回数とオプションをその横に置く。幅 ≥ 1000 px かつ高さ 720〜800 px または 880 px 以上のときだけ、固定のストリップにする。それ以外のデスクトップのサイズ（幅 701〜999 px、高さ 481〜719 / 801〜879 px）は、スクロールするフローレイアウトで、オンラインパネルとは重ならない。縦向きのスマホは **4 × 4**。
- `layout.spec.ts` に境界の 12 サイズ（480/481、719/720、800/801、879/880、701×720、844×481、999/1000×720）を足し、内容とストリップの順、選択肢どうしが交差しないこと、`elementFromPoint` の当たりを検査する。360×640、390×844、844×390 でも 16 個が交差しない。
- `modes.spec.ts` はカップ 4 つ（ZENITH / ECLIPSE を選択できること）を検査する。ロビーのコース選択は 16 行。

### E2E と golden
- `e2e/courses-m10.spec.ts`（8 テスト）: 新 8 コースそれぞれの start-grid と minimap の golden（各 2 枚）。feature view は attachment のみ。
- `e2e/courses.spec.ts`: タイトルの golden を `title-sixteen-courses.png` に改名。32 回の切替テスト（TRACK_IDS を 2 回、meadow を末尾へ回して 32 回すべてが実際の切替になるようにし、回数も検査する）。C-011（タッチ）は `.course-option` 16 個を期待する。`network.spec.ts` M8-07 T1 は meadow へ戻るときの条件を「プログラムが増えない（≤ 戻る前）かつ meadow 自身の集合が残る（≥ p0）」に改めた。最後の切替先が lunar になり、その固有のプログラム 3 個を three.js が戻る途中で解放する（16 → 13）ため。
- 全体: **63 テスト、31.8 分（1,911 s）**、workers 1・retries 0。設計の基準（40 分超で workers 2、45 分超で CI の timeout 60 分）に収まり、workers と timeout は変えていない。
- golden: darwin は新 16 枚と `title-sixteen-courses.png`（既存の 73 ファイルはバイト一致）。linux は未採取で、`goldens-linux.yml`（8 コース名を追加済み）で採取する。
- `npm test`: 60 ファイル / 2,336 テスト。

### 基準の更新（動いた pin / 動かない pin）
| pin | 状態 |
| --- | --- |
| `PROTOCOL_VERSION` 17 → **18**、`ROOM_PREFIX` `pcircuit-v18-` | 動いた |
| `COURSE_FINGERPRINT` / `pinned[18]` | 動いた: 2618543986（新規） |
| `handling.test.ts` の BASELINE | 動いた: 新 8 コースを `version: 'm10'` で追加 |
| `buildCourse.test.ts` の RENDER_BASELINE | 動いた: 新 8 コースを追加 |
| `courses.spec.ts` のタイトル golden | 動いた: `title-sixteen-courses.png` に改名し darwin を再採取 |
| sim 指紋（meadow / neon）、`LAYOUT_FINGERPRINT` aa03c454 | 不変 |
| 既存 8 コースの TrackDef、BASELINE、RENDER_BASELINE、darwin golden | 不変 |

### M11 に送ったもの
`.omc/followups.md` の「M10」節のとおり（レビュー由来の minor と、linux golden の採取、公開版の確認）。
