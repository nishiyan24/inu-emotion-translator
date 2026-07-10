// スペクトログラム描画（録音・再生中のリアルタイム表示専用 — 特徴量抽出には使わない）。
// AnalyserNode に依存する部分（startRenderLoop）と、周波数データ配列を受け取って
// 1列描く純粋な描画部（createSpectrogramRenderer）を分離し、後者は音声なしで検証できる。

// 1フレームぶんの列幅（CSSピクセル基準。devicePixelRatio 倍して使う）
const COLUMN_WIDTH_PX = 2;
// 高DPI端末での描画コスト抑制のため、拡大率はここで頭打ちにする
const MAX_PIXEL_RATIO = 2;

// 表示する周波数の上限。犬の鳴き声のエネルギーは実測でおよそ3kHz以下に収まる
// (センサー実測: スペクトル重心200〜3300Hz)ため、ナイキスト周波数全体(20kHz超)を
// そのまま表示すると大部分が空白になる。この上限で絞ることで意味のある帯域を
// 大きく見せ、かつ軸ラベル(0/2k/4k/6k/8kHz)を固定値として正直に表示できる
const MAX_DISPLAY_FREQUENCY_HZ = 8000;

// 強度（0〜255）→ 色のグラデーション（マグマ配色: 黒 → 紫 → 橙赤 → 淡い黄）
const COLOR_STOPS = [
  { at: 0, rgb: [8, 0, 12] },
  { at: 90, rgb: [122, 20, 90] },
  { at: 170, rgb: [249, 69, 48] },
  { at: 255, rgb: [254, 226, 150] },
];

const colorFor = (value) => {
  for (let i = 1; i < COLOR_STOPS.length; i += 1) {
    if (value <= COLOR_STOPS[i].at) {
      const from = COLOR_STOPS[i - 1];
      const to = COLOR_STOPS[i];
      const t = (value - from.at) / (to.at - from.at);
      return [
        Math.round(from.rgb[0] + (to.rgb[0] - from.rgb[0]) * t),
        Math.round(from.rgb[1] + (to.rgb[1] - from.rgb[1]) * t),
        Math.round(from.rgb[2] + (to.rgb[2] - from.rgb[2]) * t),
      ];
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1].rgb;
};

/**
 * canvas にスペクトログラムを描くレンダラーを作る。
 * drawColumn(freqData) を呼ぶたびに全体が1列ぶん左へスクロールし、右端に新しい列が入る。
 * 縦軸は下=低周波・上=高周波。options はテスト用の上書き（width/height/pixelRatio）。
 */
export const createSpectrogramRenderer = (canvas, options = {}) => {
  const pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const cssWidth = options.width ?? (canvas.clientWidth || canvas.width);
  const cssHeight = options.height ?? (canvas.clientHeight || canvas.height);
  const width = Math.max(1, Math.round(cssWidth * pixelRatio));
  const height = Math.max(1, Math.round(cssHeight * pixelRatio));
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  const colWidth = Math.max(1, Math.round(COLUMN_WIDTH_PX * pixelRatio));
  const column = ctx.createImageData(colWidth, height);

  const clear = () => {
    ctx.fillStyle = `rgb(${COLOR_STOPS[0].rgb.join(',')})`;
    ctx.fillRect(0, 0, width, height);
  };
  clear();

  const drawColumn = (freqData, activeBinCount = freqData.length) => {
    const binCount = activeBinCount;
    // 既存の絵を左へ1列ぶんずらす（canvas 自己コピー。getImageData 方式より高速）
    ctx.drawImage(canvas, colWidth, 0, width - colWidth, height, 0, 0, width - colWidth, height);

    for (let y = 0; y < height; y += 1) {
      const rowFromBottom = height - 1 - y;
      // この行が受け持つビン範囲の最大値を採る（ビン数 > 行数のとき狭いピークを取りこぼさないため）
      const binLo = Math.floor((rowFromBottom / height) * binCount);
      const binHi = Math.max(binLo + 1, Math.floor(((rowFromBottom + 1) / height) * binCount));
      let value = 0;
      for (let b = binLo; b < binHi && b < binCount; b += 1) {
        if (freqData[b] > value) value = freqData[b];
      }
      const [r, g, b] = colorFor(value);
      for (let x = 0; x < colWidth; x += 1) {
        const idx = (y * colWidth + x) * 4;
        column.data[idx] = r;
        column.data[idx + 1] = g;
        column.data[idx + 2] = b;
        column.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(column, width - colWidth, 0);
  };

  return { drawColumn, clear, width, height, colWidth };
};

/**
 * AnalyserNode から周波数データを読み、rAF ごとにレンダラーへ流すループを開始する。
 * 戻り値の関数を呼ぶとループを確実に停止する。
 */
export const startRenderLoop = (analyser, renderer) => {
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  // sampleRate が分からない（テスト用の簡易オブジェクト等）場合は全ビンを使う
  const nyquist = analyser.context?.sampleRate ? analyser.context.sampleRate / 2 : null;
  const activeBinCount = nyquist
    ? Math.min(freqData.length, Math.ceil((MAX_DISPLAY_FREQUENCY_HZ / nyquist) * freqData.length))
    : freqData.length;
  let rafId = null;
  let running = true;
  const tick = () => {
    if (!running) return;
    analyser.getByteFrequencyData(freqData);
    renderer.drawColumn(freqData, activeBinCount);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  return () => {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
};
