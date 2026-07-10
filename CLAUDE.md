# CLAUDE.md

このファイルは Claude Code がこのプロジェクトで作業する際の指針です。

## プロジェクトの目的

愛犬の鳴き声をマイクで録音し、Web Audio API で周波数分解 → スペクトログラム描画 → 音の特徴量（ピッチ・スペクトル重心・音量エンベロープ等）から JS のルールベース分岐で感情を推定・表示するブラウザ完結ツール。サーバーへの音声送信は行わない。

## 技術スタック / 主要ライブラリ

- Vanilla JavaScript（ES Modules）。フレームワーク・バンドラーは使用しない
- Web Audio API: `AudioContext`, `AnalyserNode`, `getUserMedia`
- Canvas 2D API: スペクトログラム描画
- 外部 npm 依存なし（現時点）

## ディレクトリ構成の方針

実際の構成は以下のとおり:

```
index.html                  # 本番UI（機能確認用の仮UI）
test-features.html          # 開発用の検証ハーネス（本番UIとは独立）
https-server.js             # スマホ実機検証用のローカルHTTPS配信サーバー（Node標準モジュールのみ）
css/
  style.css
js/
  main.js                   # エントリーポイント、UIとの結線・入力→解析→表示の集約
  audio-capture.js          # getUserMedia / 録音チェーン / ファイルデコードを共通化
  pcm-capture-worklet.js    # AudioWorkletProcessor（オーディオスレッドでPCMを捕捉）
  spectrogram-renderer.js   # Canvas へのスペクトログラム描画（表示専用）+ rAFループ制御
  feature-extraction.js     # AudioBuffer からの特徴量抽出（オフライン解析）
  emotion-classifier.js     # 特徴量 → 感情ラベルへの分岐ロジック
  test-features.js          # test-features.html 用の検証ロジック
test-samples/               # 検証用の音声サンプル（gitignore 済み）+ manifest.json / expected-labels.json
.certs/                     # 自己署名証明書（gitignore 済み、秘密鍵を含む）
```

### 解析アーキテクチャの要点

- **特徴量抽出はオフライン解析に統一**: マイク録音は PCM をバッファに貯め、停止後に `AudioBuffer` 化して解析する。ファイル入力は `decodeAudioData` の結果を同じ解析関数に渡す。両入力が同一経路を通る
- **`AnalyserNode` + `requestAnimationFrame` は「スペクトログラム表示専用」**。時間精度が必要な特徴量（反復間隔・エンベロープ）の計測には使わない（rAF はフレーム落ちを許容し端末のリフレッシュレートに依存するため）
- ピッチ推定は複数窓の自己相関（FFT 経由）で行い、窓が合意しない音（唸り・咆哮）は `pitchHz = null` を返す。ピッチには体格の交絡があるため、相対ピッチ方式の導入は V2 の改善項目（`.claude/plans/` 参照）

## コーディング規約

- ES2020+ の構文（`const`/`let`、アロー関数、モジュール `import`/`export`）を使う
- 1ファイル1責務を意識し、音声取得・FFT解析・描画・感情判定のロジックを混在させない
- 周波数閾値やしきい値などのマジックナンバーは定数化し、根拠が非自明な場合のみ短いコメントを添える
- DOM操作はフレームワークを使わず素の `document` API で行う
- 命名は camelCase（変数・関数）、定数は UPPER_SNAKE_CASE

## UI実装方針（重要）

現段階のUIは**機能確認用の仮UI**であり、見た目の作り込みは行わない。機能（音声入力・スペクトログラム・特徴量抽出・感情分類・エラーハンドリング・レスポンシブ・実機動作）がすべて完成した後、Phase 7 で外部デザイン案（GPT等で作成）をベースに**UIを全面リデザイン**する前提で進める。

そのため、装飾よりも「後から差し替えやすい構造」を優先する:

- **JSからの要素取得は `id` のみ、CSSのスタイリングは `class` のみ**に分離する（CSSを全捨てしてもJSが壊れない状態を維持する）
- HTMLは役割ごとに `<section>` で整理し、リデザイン時にセクション単位で差し替えられるようにする
- JSがUIに反映する箇所（状態メッセージ・結果表示等）は関数として切り出し、DOM構造の変更が波及しにくくする
- 見た目に関する凝ったCSS（アニメーション・装飾・アイコン・イラスト）は Phase 7 まで追加しない

## よく使うコマンド

```bash
# PC用ローカルサーバー起動（HTTP。どちらか）
npx serve .
python -m http.server 8000

# スマホ実機用のHTTPS配信（証明書は README のセットアップ手順で生成）
node https-server.js
```

Lint は未導入。動作検証は `test-features.html` をブラウザで開き、各テストボタン（合成音テスト・棄却テスト・境界安定性テスト・manifest読み込み）を実行して確認する。閾値やロジックを変更したら、実サンプルの「回帰」列がすべて「一致」か、期待ラベルとの一致率を確認すること。

## 注意事項

- `getUserMedia` はセキュアコンテキスト（`localhost` または `https`）でのみ動作する。`file://` で直接開いても動作しないことに注意。スマホ実機は `http://<LAN-IP>` では不可で HTTPS が必須（`https-server.js`）
- マイク録音では `getUserMedia` のデフォルトDSP（AGC・ノイズ抑制・エコーキャンセル）を必ず無効化する。これらは音量エンベロープやノイズ成分といった特徴量を歪めるため（`audio-capture.js` の `MIC_CONSTRAINTS`）
- 録音した音声データを外部（サーバー・API）に送信しない設計を維持すること（プライバシー配慮）。将来クラウドAPI連携を追加する場合は `.env` に鍵を置き、`.claude/settings.json` の deny 設定により Claude はそれを読み取らない
- `.env` 系ファイル・`.certs/`（秘密鍵）は読み取らない・コミットしない
- 感情分類の精度・限界や V2 改善項目（相対ピッチ方式など）は `.claude/plans/dog-bark-emotion-translator.md` に記録している
