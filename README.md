# POCKET CIRCUIT / Kart Racer

青空と丘の **MEADOW LOOP** を、プレイヤーと CPU 5 台で走るオリジナルの 3D カートレース。3 周の順位とタイムを競います。モデル・景色は手続き生成、音は WebAudio 合成で、外部画像・モデル・音声ファイルは使いません。

▶ **今すぐ遊ぶ: https://machaniconico.github.io/kart-racer/** （PC・スマホ対応。スマホは横画面で）

## 起動と開発

Node.js **22.12 以降**（22 LTS 推奨）を使用してください。

```sh
npm install
npm run dev
```

表示されたローカル URL の `/kart-racer/` を開きます。スマホからは同じ Wi-Fi に接続し、Vite の Network URL に `/kart-racer/` を付けてアクセスしてください。

```sh
npm run build       # strict TypeScript チェック + dist/ に本番ビルド
npm test            # Vitest を一度実行
npm run test:watch  # Vitest の監視実行
npm run typecheck   # 型チェックのみ
npm run preview    # ビルド済み dist/ を確認
```

## 遊び方

「レースをはじめる」で 3・2・1 の後にスタート。道路の外の芝は減速し、壁や他のカートに衝突すると速度や進路が変わります。チェックポイントを順番に通過して 3 周してください。逆走・チェックポイントの飛ばし・コースの瞬間移動では周回が成立しません。

| 操作 | PC | スマホ | 標準ゲームパッド |
| --- | --- | --- | --- |
| ステア | ← → / A D | 左スティックを左右へ | 左スティック / 十字キー |
| アクセル | ↑ / W | アクセル、または AUTO 切替 | A / RT |
| ブレーキ | ↓ / S | ブレーキ | B / LT |
| ドリフト・ホップ | Space を押しながら曲がる | DRIFT を押しながら曲がる | X |
| アイテム | Shift / E | ITEM | RB / Y |
| 一時停止 | Esc / 一時停止ボタン | 一時停止ボタン | 画面の一時停止ボタン |

ドリフトの火花が **水色（0.65 秒）→ オレンジ（1.5 秒）** に変化します。ドリフトを離すと、溜めた段階に応じてミニターボが発動します。

アイテムボックスはコース上の 4 列・計 12 個。取得すると 5 秒で復活します。一度に持てるアイテムは 1 個です。

- **ダッシュ**: 約 1.9 秒の加速。下位ほど当たりやすくなります。
- **トラップ**: 後方に置き、踏んだ相手をスピンさせます。一定時間後は自分も踏みます。
- **ボルト**: 前方へ直進。壁で反射し、4 回反射または寿命で消えます。

スマホは横画面推奨。ステアとドリフトなどの同時押しに対応し、タッチ端末では自動アクセルが初期 ON です。縦画面には横向きの案内を表示します。画面を離れた場合は自動で一時停止します。音は開始操作後に有効になり、右上のボタンでミュートできます。

ベストの合計タイムとミュート設定を `localStorage` に保存します。ストレージが利用できない場合もプレイできます。プレイヤーがゴールすると結果画面に移り、未完走 CPU はその時点の進行順位で「走行中」と表示します。

## 構成

```text
src/
  sim/        # three / DOM に依存しない固定 60 Hz のシミュレーション
    types.ts  # InputFrame、InputSource、JSON 保存可能な RaceState
    track.ts  # 閉じた Catmull-Rom スプライン、距離・路面投影
    race.ts   # 簡易物理、衝突、ドリフト、アイテム、レース進行
    laps.ts   # 方向付きチェックポイント、周回、順位
    ai.ts     # CPU の InputFrame 生成
    random.ts # seed 付き PRNG と順位依存のアイテム抽選
    sim.test.ts
  render/     # three のコース、カート、追従カメラ、火花
  input/      # キーボード・タッチ・Gamepad を InputFrame に変換
  audio/      # WebAudio のエンジン・ドリフト・効果音
  ui/         # タイトル、HUD、ミニマップ、結果、一時停止
  main.ts     # 固定ステップ実行、状態補間、各層の接続
  storage.ts  # 例外処理付きのベストタイム・ミュート保存
  style.css
.github/workflows/deploy.yml
```

シミュレーションは `stepRace(state, inputs)` で 1 tick 進みます。`RaceState` に RNG 状態を含むため、同じ seed と tick ごとの `InputFrame[]` で再現できます。`JSON.parse(JSON.stringify(state))` したスナップショットからも継続可能です。CPU も入力を作るだけで、物理を直接上書きしません。将来のネットワーク入力はこの境界で差し替えられます。

描画は前後のカート状態を補間し、シミュレーションを変更しません。木・岩・縁石・ガードレールなどはインスタンシング、カート本体はマテリアルごとに結合しています。影は directional light 1 灯、DPR は最大 2。`prefers-reduced-motion` 時はタイトルカメラの揺れや追従カメラのドリフト演出を抑えます。

開発サーバーでのみ `window.__kartDebug` から状態の参照と `advance(ticks, true)` による CPU 自動走行検証ができます。本番ビルドには含まれません。

## GitHub Pages

`vite.config.ts` の `base` は **`/kart-racer/`** です。GitHub リポジトリの Settings → Pages → Source を **GitHub Actions** に設定してください。`main` への push または workflow の手動実行で、`npm ci` → テスト → ビルド → `actions/deploy-pages` の順に公開します。リポジトリ名を変える場合は `base` も変更してください。

## 実装上の範囲

- コースは 1 つ、CPU 戦のみ。対人通信やネットワーク同期そのものは未実装です。
- 物理は平面上の簡易カート物理と路面の高さへの追従です。ホップは描画演出で、立体ジャンプや転倒は扱いません。
- 60fps は中級スマホでの目安です。実機・ブラウザ・電力設定によって性能とゲームパッドの割り当ては異なります。
- WebGL が利用できない場合は画面内に再読み込み案内を表示します。音声が許可されない場合もゲームは動作します。
