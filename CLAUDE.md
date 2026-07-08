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

コードが増えてきたら以下のような構成を想定する（未確定・目安）:

```
index.html
css/
  style.css
js/
  main.js               # エントリーポイント、UIとの結線
  audio-capture.js       # getUserMedia / AudioContext のセットアップ
  fft-analyzer.js         # AnalyserNode からの周波数データ取得
  spectrogram-renderer.js # Canvas へのスペクトログラム描画
  emotion-classifier.js   # 特徴量 → 感情ラベルへの分岐ロジック
```

## コーディング規約

- ES2020+ の構文（`const`/`let`、アロー関数、モジュール `import`/`export`）を使う
- 1ファイル1責務を意識し、音声取得・FFT解析・描画・感情判定のロジックを混在させない
- 周波数閾値やしきい値などのマジックナンバーは定数化し、根拠が非自明な場合のみ短いコメントを添える
- DOM操作はフレームワークを使わず素の `document` API で行う
- 命名は camelCase（変数・関数）、定数は UPPER_SNAKE_CASE

## よく使うコマンド

```bash
# ローカルサーバー起動（どちらか）
npx serve .
python -m http.server 8000
```

自動テスト・Lint は現時点で未導入。ブラウザの開発者ツールでの動作確認が基本。

## 注意事項

- `getUserMedia` はセキュアコンテキスト（`localhost` または `https`）でのみ動作する。`file://` で直接開いても動作しないことに注意
- 録音した音声データを外部（サーバー・API）に送信しない設計を維持すること（プライバシー配慮）。将来クラウドAPI連携を追加する場合は `.env` に鍵を置き、`.claude/settings.json` の deny 設定により Claude はそれを読み取らない
- `.env` 系ファイルは読み取らない・コミットしない

※ コードが揃ったら `/init` で本ファイルを更新・拡充できます。
