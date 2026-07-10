// Phase 1 スパイク用の開発ハーネス。
// ①合成音（期待値が数学的に確定する信号）で特徴量計算の正しさを検証し、
// ②実サンプル（test-samples/ またはファイル選択）で判別可能性を確認する。

import { analyzeSamples, estimatePitchRobust } from './feature-extraction.js';
import { createPcmRecorder, toMono } from './audio-capture.js';
import { createSpectrogramRenderer, startRenderLoop } from './spectrogram-renderer.js';
import { classifyEmotion, EMOTIONS, EMOTION_LABELS } from './emotion-classifier.js';

const SYNTH_SAMPLE_RATE = 44100;
const SYNTH_AMPLITUDE = 0.5;
// ノイズ生成に Math.random() を使うとテストの合否が実行ごとに揺れるため、
// シード付き擬似乱数（mulberry32）で毎回同じ波形を生成する
const NOISE_SEED = 20260708;

const createRandom = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------- 合成音の生成 ----------

const generateSine = (freqHz, durationSec) => {
  const n = Math.floor(SYNTH_SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = SYNTH_AMPLITUDE * Math.sin((2 * Math.PI * freqHz * i) / SYNTH_SAMPLE_RATE);
  }
  return out;
};

const generateWhiteNoise = (durationSec) => {
  const n = Math.floor(SYNTH_SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  const random = createRandom(NOISE_SEED);
  for (let i = 0; i < n; i += 1) {
    out[i] = SYNTH_AMPLITUDE * (random() * 2 - 1);
  }
  return out;
};

const generateSilence = (durationSec) => new Float32Array(Math.floor(SYNTH_SAMPLE_RATE * durationSec));

/** 周波数が線形に変化するスイープ（ピッチ変化パターンの検証用） */
const generateSweep = (startHz, endHz, durationSec) => {
  const n = Math.floor(SYNTH_SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const freq = startHz + ((endHz - startHz) * i) / n;
    phase += (2 * Math.PI * freq) / SYNTH_SAMPLE_RATE;
    out[i] = SYNTH_AMPLITUDE * Math.sin(phase);
  }
  return out;
};

// 各窓が別々の基音になるよう、窓長（約0.19秒）と同程度の間隔で大きく飛ぶ周波数列。
// 乱数を使うとテスト結果が実行ごとに揺れるため固定列にする
const IRREGULAR_FREQS_HZ = [180, 700, 240, 850, 300, 620, 160, 900, 210, 760];
const IRREGULAR_CHANGE_INTERVAL_SEC = 0.2;

/**
 * 周期が不規則に飛ぶ音（唸り声・咆哮の音響的な特徴を模したもの）。
 * 各窓の中では純音なので clarity は高いが、窓ごとに基音が違うためピッチは一意に定まらない。
 */
const generateIrregularTone = (durationSec) => {
  const n = Math.floor(SYNTH_SAMPLE_RATE * durationSec);
  const interval = Math.floor(SYNTH_SAMPLE_RATE * IRREGULAR_CHANGE_INTERVAL_SEC);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const freq = IRREGULAR_FREQS_HZ[Math.floor(i / interval) % IRREGULAR_FREQS_HZ.length];
    phase += (2 * Math.PI * freq) / SYNTH_SAMPLE_RATE;
    out[i] = SYNTH_AMPLITUDE * Math.sin(phase);
  }
  return out;
};

/** 一定のノイズフロアに小さな信号だけがある音（SNRゲートの検証用） */
const generateNoiseOnly = (durationSec, amplitude) => {
  const n = Math.floor(SYNTH_SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  const random = createRandom(NOISE_SEED);
  for (let i = 0; i < n; i += 1) out[i] = amplitude * (random() * 2 - 1);
  return out;
};

const generateBurstTrain = (freqHz, burstSec, gapSec, count) => {
  const burst = generateSine(freqHz, burstSec);
  const gap = generateSilence(gapSec);
  const n = count * burst.length + (count - 1) * gap.length;
  const out = new Float32Array(n);
  let pos = 0;
  for (let i = 0; i < count; i += 1) {
    out.set(burst, pos);
    pos += burst.length + gap.length;
  }
  return out;
};

// ---------- 合成音テストケース（期待値と判定条件） ----------

const SYNTHETIC_CASES = [
  {
    name: '正弦波 440Hz・1秒',
    generate: () => generateSine(440, 1),
    expectedText: 'ピッチ 440±10Hz / ノイズ割合 < 0.2 / 区間数 1',
    check: (f) =>
      f.pitchHz !== null && Math.abs(f.pitchHz - 440) <= 10 && f.noiseRatio < 0.2 && f.segmentCount === 1,
  },
  {
    name: 'ホワイトノイズ・1秒',
    generate: () => generateWhiteNoise(1),
    expectedText: 'ノイズ割合 > 0.6 / 区間数 1',
    check: (f) => f.noiseRatio !== null && f.noiseRatio > 0.6 && f.segmentCount === 1,
  },
  {
    name: '無音・1秒',
    generate: () => generateSilence(1),
    expectedText: '鳴き声区間の検出 0 件',
    check: (f) => f.segmentCount === 0,
  },
  {
    name: '600Hzバースト×5（0.1秒鳴き＋0.2秒無音）',
    generate: () => generateBurstTrain(600, 0.1, 0.2, 5),
    expectedText: '区間数 5 / ピッチ 600±15Hz / 平均間隔 0.08〜0.25秒',
    check: (f) =>
      f.segmentCount === 5 &&
      f.pitchHz !== null &&
      Math.abs(f.pitchHz - 600) <= 15 &&
      f.meanGapSec !== null &&
      f.meanGapSec >= 0.08 &&
      f.meanGapSec <= 0.25,
  },
  // --- Phase 4 で追加した特徴量の検証 ---
  {
    name: '正弦波 200Hz（低いスペクトル重心）',
    generate: () => generateSine(200, 1),
    expectedText: 'スペクトル重心 200Hz±30 / ピッチ変化 flat',
    check: (f) =>
      f.spectralCentroidHz !== null &&
      Math.abs(f.spectralCentroidHz - 200) <= 30 &&
      f.pitchContour === 'flat',
  },
  {
    name: '正弦波 3000Hz（高いスペクトル重心）',
    generate: () => generateSine(3000, 1),
    expectedText: 'スペクトル重心 3000Hz±60（200Hz版より高い）',
    check: (f) => f.spectralCentroidHz !== null && Math.abs(f.spectralCentroidHz - 3000) <= 60,
  },
  {
    name: '上昇スイープ 300→900Hz',
    generate: () => generateSweep(300, 900, 1),
    expectedText: "ピッチ変化 'rising'",
    check: (f) => f.pitchContour === 'rising',
  },
  {
    name: '下降スイープ 900→300Hz',
    generate: () => generateSweep(900, 300, 1),
    expectedText: "ピッチ変化 'falling'",
    check: (f) => f.pitchContour === 'falling',
  },
  {
    // 定常ノイズと持続音はRMS分布では区別できないため、区間検出では弾かない。
    // 「ダイナミクスが乏しく(peak/noise比が低い)、かつ非周期的(ノイズ割合が高い)」ことを
    // 分類器が棄却の根拠にできる状態になっているかを検証する。
    name: '環境ノイズのみ（棄却の根拠となる特徴量が出るか）',
    generate: () => generateNoiseOnly(1.5, 0.02),
    expectedText: 'peak/noise比 < 2.5 かつ ノイズ割合 > 0.6',
    check: (f) => f.peakToNoiseRatio !== null && f.peakToNoiseRatio < 2.5 && f.noiseRatio > 0.6,
  },
  {
    // 上のノイズと対比: 持続する正弦波はダイナミクスが乏しくても周期的なので棄却されない
    name: '定常正弦波（持続する遠吠え相当）は区間検出される',
    generate: () => generateSine(500, 1.5),
    expectedText: '区間数 1（定常音でも検出できる）/ ノイズ割合 < 0.2 / 窓の合意 1.0',
    check: (f) =>
      f.segmentCount === 1 && f.noiseRatio !== null && f.noiseRatio < 0.2 && f.pitchAgreement === 1,
  },
  {
    // 周期が不規則に揺れる音（唸り声・咆哮相当）にはピッチが定義できない。
    // 窓ごとの推定が一致しないことを検出し、数値をでっち上げずに null を返すべき
    name: '窓ごとに基音が飛ぶ音（唸り声相当・周期性は高いがピッチは不定）',
    generate: () => generateIrregularTone(2),
    expectedText: '窓の合意 < 0.5 のため ピッチ null',
    check: (f) => f.pitchHz === null && f.pitchAgreement < 0.5,
  },
  {
    // 対比: 周期が規則的なら強いノイズに埋もれていてもピッチは定義できる（ノイズ耐性）
    name: 'ノイズに埋もれた規則的な300Hz（ノイズ耐性）',
    generate: () => {
      const noisy = generateWhiteNoise(1);
      const tone = generateSine(300, 1);
      const out = new Float32Array(noisy.length);
      for (let i = 0; i < out.length; i += 1) out[i] = 0.75 * noisy[i] + 0.25 * tone[i];
      return out;
    },
    expectedText: 'ノイズ割合 > 0.5 でも ピッチ 300±15Hz を復元できる',
    check: (f) => f.noiseRatio > 0.5 && f.pitchHz !== null && Math.abs(f.pitchHz - 300) <= 15,
  },
  {
    name: '極短ファイル（0.01秒）',
    generate: () => generateSine(500, 0.01),
    expectedText: 'エラーで停止せず区間数 0',
    check: (f) => f.segmentCount === 0 && f.pitchHz === null,
  },
];

// ---------- 期待ラベルとの照合（Phase 5） ----------
// 閾値をいじるたびに手で聴き直さずに済むよう、期待ラベルとの一致率を機械的に出す。

let expectedLabels = null;

const loadExpectedLabels = async () => {
  if (expectedLabels) return expectedLabels;
  const response = await fetch('test-samples/expected-labels.json');
  if (!response.ok) throw new Error(`期待ラベルを読み込めません（HTTP ${response.status}）`);
  expectedLabels = await response.json();
  return expectedLabels;
};

const classificationCells = (name, features) => {
  const { emotion, reason } = classifyEmotion(features);
  const expected = expectedLabels?.[name];
  const match = expected === undefined ? '期待値なし' : expected === emotion ? '一致' : '不一致';
  return {
    emotion,
    cells: [
      EMOTION_LABELS[emotion],
      expected === undefined ? '—' : EMOTION_LABELS[expected] ?? expected,
      match,
      reason,
    ],
    match,
  };
};

// ---------- 表示ユーティリティ ----------

const fmt = (value, digits = 2) =>
  value === null || value === undefined || Number.isNaN(value) ? '—' : Number(value).toFixed(digits);

const featureCells = (f) => [
  fmt(f.totalDurationSec, 2),
  String(f.segmentCount),
  f.pitchHz === null ? '—' : `${f.pitchHz.toFixed(1)} Hz`,
  fmt(f.noiseRatio, 2),
  f.spectralCentroidHz === null || f.spectralCentroidHz === undefined
    ? '—'
    : `${f.spectralCentroidHz.toFixed(0)} Hz`,
  f.pitchContour ?? '—',
  fmt(f.mainDurationSec, 2),
  fmt(f.mainAttackSec, 3),
  fmt(f.meanGapSec, 2),
];

const appendRow = (tbody, cells, className = '') => {
  const tr = document.createElement('tr');
  if (className) tr.className = className;
  for (const cell of cells) {
    const td = document.createElement('td');
    td.textContent = cell;
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
};

// ---------- 合成音テストの実行 ----------

const runSyntheticTests = () => {
  const tbody = document.querySelector('#synthetic-results tbody');
  tbody.replaceChildren();
  const results = [];
  for (const testCase of SYNTHETIC_CASES) {
    const features = analyzeSamples(testCase.generate(), SYNTH_SAMPLE_RATE);
    const pass = testCase.check(features);
    results.push({ name: testCase.name, expected: testCase.expectedText, features, pass });
    appendRow(
      tbody,
      [testCase.name, testCase.expectedText, ...featureCells(features), pass ? 'PASS' : 'FAIL'],
      pass ? 'row-pass' : 'row-fail',
    );
  }
  const allPass = results.every((r) => r.pass);
  const summary = document.getElementById('synthetic-summary');
  summary.textContent = allPass
    ? `全 ${results.length} 件 PASS`
    : `FAIL あり（${results.filter((r) => !r.pass).length}/${results.length} 件）`;
  summary.className = allPass ? 'summary-pass' : 'summary-fail';
  // 自動検証（preview_eval）から結果を読み取るためのフック
  window.__syntheticResults = results.map(({ name, expected, pass, features }) => ({
    name,
    expected,
    pass,
    pitchHz: features.pitchHz,
    noiseRatio: features.noiseRatio,
    segmentCount: features.segmentCount,
    meanGapSec: features.meanGapSec,
  }));
  return results;
};

// ---------- 実サンプルの基準値（回帰検出用） ----------
// Phase 4 の本実装時点での実測値。以降の変更でこれらが動いたら理由を確認すること。
// Phase 1 スパイク時からピッチ値が変わっているのは、単一窓の自己相関から
// 「複数窓 → オクターブ畳み込み → 合意判定」の堅牢な推定へ手法を変更したため。
// 特に barking-3 の 314→319Hz、barking-6 の 373.7→null（唸り/咆哮はピッチが定義できない）が該当。
const FEATURE_BASELINE = {
  'A dog barking-1.mp3': { segmentCount: 1, pitchHz: 608.0, noiseRatio: 0.276 },
  'A dog barking-2.mp3': { segmentCount: 6, pitchHz: 646.4, noiseRatio: 0.091 },
  'A dog barking-3.mp3': { segmentCount: 2, pitchHz: 319.3, noiseRatio: 0.579 },
  'A dog barking-4.mp3': { segmentCount: 1, pitchHz: 382.6, noiseRatio: 0.009 },
  'A dog barking-5.mp3': { segmentCount: 1, pitchHz: 1496.1, noiseRatio: 0.230 },
  // ライオンの咆哮。窓ごとのピッチが合意せず null になるのが正しい挙動
  'A dog barking-6.mp3': { segmentCount: 1, pitchHz: null, noiseRatio: 0.665 },
  'A dog barking-7.mp3': { segmentCount: 4, pitchHz: 1103.1, noiseRatio: 0.390 },
  'A dog barking-8.mp3': { segmentCount: 6, pitchHz: 1016.8, noiseRatio: 0.143 },
  'hitonokoe.mp3': { segmentCount: 1, pitchHz: 352.9, noiseRatio: 0.636 },
};

const PITCH_REGRESSION_TOLERANCE_HZ = 1;
const NOISE_REGRESSION_TOLERANCE = 0.01;

const pitchMatchesBaseline = (actual, expected) => {
  if (expected === null) return actual === null;
  return actual !== null && Math.abs(actual - expected) <= PITCH_REGRESSION_TOLERANCE_HZ;
};

/** 基準値と比較し、回帰の有無を短い文字列で返す */
const regressionVerdict = (name, f) => {
  const base = FEATURE_BASELINE[name];
  if (!base) return '基準なし';
  const diffs = [];
  if (f.segmentCount !== base.segmentCount) {
    diffs.push(`区間数 ${base.segmentCount}→${f.segmentCount}`);
  }
  if (!pitchMatchesBaseline(f.pitchHz, base.pitchHz)) {
    const expected = base.pitchHz === null ? 'null' : base.pitchHz;
    diffs.push(`ピッチ ${expected}→${f.pitchHz === null ? 'null' : f.pitchHz.toFixed(1)}`);
  }
  if (f.noiseRatio === null || Math.abs(f.noiseRatio - base.noiseRatio) > NOISE_REGRESSION_TOLERANCE) {
    diffs.push(`ノイズ ${base.noiseRatio}→${f.noiseRatio === null ? '—' : f.noiseRatio.toFixed(3)}`);
  }
  return diffs.length === 0 ? '一致' : diffs.join(' / ');
};

// ---------- 実サンプルの解析 ----------

let audioContext = null;
const getAudioContext = () => {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return audioContext;
};

const analyzeArrayBuffer = async (name, arrayBuffer) => {
  const tbody = document.querySelector('#sample-results tbody');
  try {
    const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);
    const features = analyzeSamples(toMono(audioBuffer), audioBuffer.sampleRate);
    const verdict = regressionVerdict(name, features);
    const classification = classificationCells(name, features);
    const rowFailed = verdict !== '一致' && verdict !== '基準なし';
    appendRow(
      tbody,
      [name, ...featureCells(features), ...classification.cells, verdict],
      classification.match === '不一致' || rowFailed ? 'row-fail' : 'row-pass',
    );
    return {
      name,
      features,
      regression: verdict,
      emotion: classification.emotion,
      labelMatch: classification.match,
    };
  } catch (error) {
    appendRow(tbody, [name, `デコード失敗: ${error}`], 'row-fail');
    return { name, error: String(error) };
  }
};

const analyzeFiles = async (files) => {
  await loadExpectedLabels().catch(() => null);
  const results = [];
  for (const file of files) {
    results.push(await analyzeArrayBuffer(file.name, await file.arrayBuffer()));
  }
  window.__sampleResults = results;
};

/** 期待ラベルとの一致率を集計して表示する */
const reportAccuracy = (results) => {
  const el = document.getElementById('accuracy-summary');
  const scored = results.filter((r) => r.labelMatch === '一致' || r.labelMatch === '不一致');
  if (scored.length === 0) {
    el.textContent = '';
    el.className = '';
    return;
  }
  const matched = scored.filter((r) => r.labelMatch === '一致').length;
  const allMatch = matched === scored.length;
  const mismatches = scored
    .filter((r) => r.labelMatch === '不一致')
    .map((r) => r.name)
    .join(', ');
  el.textContent = allMatch
    ? `期待ラベルとの一致: ${matched}/${scored.length} 件`
    : `期待ラベルとの一致: ${matched}/${scored.length} 件（不一致: ${mismatches}）`;
  el.className = allMatch ? 'summary-pass' : 'summary-fail';
  window.__accuracy = { matched, total: scored.length };
};

const loadFromManifest = async () => {
  const status = document.getElementById('sample-status');
  try {
    await loadExpectedLabels();
    const response = await fetch('test-samples/manifest.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const fileNames = await response.json();
    status.textContent = `manifest から ${fileNames.length} 件を解析中…`;
    const results = [];
    for (const fileName of fileNames) {
      const fileResponse = await fetch(`test-samples/${encodeURIComponent(fileName)}`);
      if (!fileResponse.ok) {
        status.textContent = `${fileName} の取得に失敗（HTTP ${fileResponse.status}）`;
        continue;
      }
      results.push(await analyzeArrayBuffer(fileName, await fileResponse.arrayBuffer()));
    }
    window.__sampleResults = results;
    reportAccuracy(results);
    status.textContent = `${results.length} 件の解析が完了`;
  } catch (error) {
    status.textContent = `manifest の読み込みに失敗: ${error}（test-samples/manifest.json を配置してください）`;
  }
};

// ---------- 棄却クラスの自動アサート（Phase 5） ----------
// 犬の鳴き声でない音に対して、6感情のどれかを断定しないことを検証する。

/**
 * 静かな部屋の環境音（冷蔵庫・エアコン・換気扇）を模した音。
 * 低域のハム音と、断続的に強弱がつく微小な広帯域ノイズからなる。
 * 実機で「甘え・要求（高い声2000Hz）」と誤判定された不具合の再現ケース。
 */
const generateRoomNoise = (durationSec) => {
  const n = Math.floor(SYNTH_SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  const random = createRandom(NOISE_SEED);
  for (let i = 0; i < n; i += 1) {
    const t = i / SYNTH_SAMPLE_RATE;
    const hum = 0.004 * Math.sin(2 * Math.PI * 100 * t);
    // 家電の動作音のように音量がゆっくり脈動する（区間検出が反応しうる状況を作る）
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.3 * t);
    out[i] = hum + 0.006 * envelope * (random() * 2 - 1);
  }
  return out;
};

/** 換気扇のような高域寄りのノイズ（ピッチ推定が探索上限に張り付く） */
const generateHighFrequencyNoise = (durationSec) => {
  const n = Math.floor(SYNTH_SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  const random = createRandom(NOISE_SEED);
  let previous = 0;
  for (let i = 0; i < n; i += 1) {
    const white = random() * 2 - 1;
    // 一次差分で低域を落とし高域を強調する（ハイパスフィルタ相当）
    out[i] = 0.3 * (white - previous);
    previous = white;
  }
  return out;
};

/**
 * 咳払いのような「声帯振動を伴う荒れた音」の反復（4回）。
 * 各バーストは前半に低い声帯振動(150Hz)、後半に乱流雑音が強くなる包絡を持つ。
 * 実機で「遊びの誘い（テンポよく4回続けて鳴いています）」と誤判定された不具合の再現ケース。
 * ノイズ割合が高くても窓間のピッチ合意度は高く出るため、ノイズ比とピッチ合意度を
 * AND条件で棄却していた旧ロジックでは弾けなかった（pitchHzがnullでない時点で
 * 合意度は必ず0.5以上という前提と、AND条件が矛盾していた）。
 */
const generateVoicedNoiseBurstTrain = (burstSec, gapSec, count, amplitude, voicedFreqHz) => {
  const random = createRandom(NOISE_SEED);
  const burstLen = Math.floor(SYNTH_SAMPLE_RATE * burstSec);
  const gapLen = Math.floor(SYNTH_SAMPLE_RATE * gapSec);
  const n = count * burstLen + (count - 1) * gapLen;
  const out = new Float32Array(n);
  let pos = 0;
  let phase = 0;
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < burstLen; j += 1) {
      const t = j / burstLen;
      const voicedAmp = Math.max(0, 1 - t * 1.5);
      const noiseAmp = 0.4 + 0.6 * t;
      phase += (2 * Math.PI * voicedFreqHz) / SYNTH_SAMPLE_RATE;
      out[pos + j] = (amplitude * (voicedAmp * Math.sin(phase) + noiseAmp * (random() * 2 - 1))) / 1.4;
    }
    pos += burstLen + gapLen;
  }
  return out;
};

const REJECTION_CASES = [
  { name: '無音', generate: () => generateSilence(1) },
  { name: 'ホワイトノイズ', generate: () => generateWhiteNoise(1) },
  { name: '環境ノイズのみ（微小振幅）', generate: () => generateNoiseOnly(1.5, 0.02) },
  { name: '窓ごとに基音が飛ぶ音（咆哮相当）', generate: () => generateIrregularTone(2) },
  { name: '静かな部屋の環境音（冷蔵庫・エアコン）', generate: () => generateRoomNoise(3) },
  { name: '換気扇のような高域ノイズ', generate: () => generateHighFrequencyNoise(2) },
  {
    name: '咳払いの反復（声帯振動+雑音、4回）',
    generate: () => generateVoicedNoiseBurstTrain(0.25, 0.5, 4, 0.4, 150),
  },
];

const runRejectionTests = () => {
  const listEl = document.getElementById('rejection-results');
  const summaryEl = document.getElementById('rejection-summary');
  listEl.replaceChildren();
  const results = [];
  for (const testCase of REJECTION_CASES) {
    const features = analyzeSamples(testCase.generate(), SYNTH_SAMPLE_RATE);
    const { emotion, reason } = classifyEmotion(features);
    const pass = emotion === EMOTIONS.REJECTED;
    results.push({ name: testCase.name, emotion, pass });
    const li = document.createElement('li');
    li.textContent = `${testCase.name} — 期待: 判定できません / 実測: ${EMOTION_LABELS[emotion]}（${reason}） → ${pass ? 'PASS' : 'FAIL'}`;
    li.className = pass ? 'row-pass' : 'row-fail';
    listEl.appendChild(li);
  }
  const allPass = results.every((r) => r.pass);
  summaryEl.textContent = allPass
    ? `全 ${results.length} 件 PASS`
    : `FAIL あり（${results.filter((r) => !r.pass).length}/${results.length} 件）`;
  summaryEl.className = allPass ? 'summary-pass' : 'summary-fail';
  window.__rejectionResults = results;
  return results;
};

// ---------- ピッチ推定の境界安定性テスト（Phase 4） ----------
// 区間の切り出し位置がわずかに変わってもピッチ推定が飛ばないことを、実サンプルで検証する。
// 単一窓での推定は唸り声でオクターブ誤りを起こし、境界が0.14秒ずれただけで倍になる不具合があった。

const BOUNDARY_TEST_FILE = 'A dog barking-3.mp3';
const BOUNDARY_TRIM_SEC = 0.15;
// 境界を動かしたときに許容するピッチのばらつき（半音3つぶん ≈ 1.19倍）
const BOUNDARY_PITCH_TOLERANCE_RATIO = 1.19;

const runBoundaryStabilityTest = async () => {
  const el = document.getElementById('boundary-result');
  el.textContent = '実行中…';
  el.className = '';
  try {
    const response = await fetch(`test-samples/${encodeURIComponent(BOUNDARY_TEST_FILE)}`);
    if (!response.ok) throw new Error(`サンプルを取得できません（HTTP ${response.status}）`);
    const audioBuffer = await getAudioContext().decodeAudioData(await response.arrayBuffer());
    const samples = toMono(audioBuffer);
    const sampleRate = audioBuffer.sampleRate;

    const startSample = Math.floor(1.099 * sampleRate);
    const endSample = Math.floor(2.229 * sampleRate);
    const trim = Math.floor(BOUNDARY_TRIM_SEC * sampleRate);
    const variants = {
      基準: samples.subarray(startSample, endSample),
      '末尾を0.15秒短く': samples.subarray(startSample, endSample - trim),
      '先頭を0.15秒短く': samples.subarray(startSample + trim, endSample),
    };
    const pitches = Object.entries(variants).map(([label, slice]) => ({
      label,
      pitchHz: estimatePitchRobust(slice, sampleRate).pitchHz,
    }));

    const values = pitches.map((p) => p.pitchHz).filter((p) => p !== null);
    const ratio = values.length > 1 ? Math.max(...values) / Math.min(...values) : Infinity;
    const pass = values.length === pitches.length && ratio <= BOUNDARY_PITCH_TOLERANCE_RATIO;

    el.textContent =
      `期待: 境界を±0.15秒動かしてもピッチ比 ≤ ${BOUNDARY_PITCH_TOLERANCE_RATIO} — 実測: ` +
      pitches.map((p) => `${p.label} ${p.pitchHz === null ? '—' : p.pitchHz.toFixed(1)}Hz`).join(' / ') +
      `（比 ${ratio.toFixed(3)}） → ${pass ? 'PASS' : 'FAIL'}`;
    el.className = pass ? 'summary-pass' : 'summary-fail';
    window.__boundaryResult = { pass, ratio, pitches };
  } catch (error) {
    el.textContent = `エラー: ${error}`;
    el.className = 'summary-fail';
    window.__boundaryResult = { pass: false, error: String(error) };
  }
};

// ---------- ループバック録音テスト（Phase 2） ----------
// 440Hz発振器を「マイクの代わり」に録音チェーン（AudioWorklet→チャンク結合→AudioBuffer）へ
// 流し、取得PCMのピッチと長さを検証する。マイク以外の録音経路すべてがテスト対象になる。

const LOOPBACK_FREQ_HZ = 440;
const LOOPBACK_DURATION_SEC = 0.5;
const LOOPBACK_SAMPLE_RATE = 44100;

const runLoopbackTest = async () => {
  const resultEl = document.getElementById('loopback-result');
  resultEl.textContent = '実行中…';
  resultEl.className = '';
  try {
    const ctx = new OfflineAudioContext(
      1,
      LOOPBACK_SAMPLE_RATE * LOOPBACK_DURATION_SEC,
      LOOPBACK_SAMPLE_RATE,
    );
    const oscillator = new OscillatorNode(ctx, { frequency: LOOPBACK_FREQ_HZ, type: 'sine' });
    const recorder = await createPcmRecorder(ctx);
    oscillator.connect(recorder.node);
    oscillator.start();
    await ctx.startRendering();
    const buffer = await recorder.stop();
    if (!buffer) throw new Error('録音バッファが空でした');

    const features = analyzeSamples(toMono(buffer), buffer.sampleRate);
    const actualDurationSec = buffer.length / buffer.sampleRate;
    const pitchOk = features.pitchHz !== null && Math.abs(features.pitchHz - LOOPBACK_FREQ_HZ) <= 10;
    // チャンク欠落があれば長さが足りなくなる（±50ms 許容）
    const lengthOk = Math.abs(actualDurationSec - LOOPBACK_DURATION_SEC) <= 0.05;
    const pass = pitchOk && lengthOk;

    resultEl.textContent =
      `期待: ピッチ ${LOOPBACK_FREQ_HZ}±10Hz / 長さ ${LOOPBACK_DURATION_SEC}秒±0.05 — ` +
      `実測: ピッチ ${features.pitchHz === null ? '—' : features.pitchHz.toFixed(1)}Hz / ` +
      `長さ ${actualDurationSec.toFixed(3)}秒 → ${pass ? 'PASS' : 'FAIL'}`;
    resultEl.className = pass ? 'summary-pass' : 'summary-fail';
    window.__loopbackResult = {
      pass,
      pitchHz: features.pitchHz,
      actualDurationSec,
      sampleRate: buffer.sampleRate,
    };
  } catch (error) {
    resultEl.textContent = `エラー: ${error}`;
    resultEl.className = 'summary-fail';
    window.__loopbackResult = { pass: false, error: String(error) };
  }
};

// ---------- スペクトログラム描画テスト（Phase 3） ----------
// 特定ビンにだけ山がある合成スペクトルをレンダラーへ注入し、getImageData で
// 「輝点が期待どおりのY座標に出るか」「スクロールするか」「停止するか」を機械判定する。

const SPEC_TEST_WIDTH = 200;
const SPEC_TEST_HEIGHT = 128;
const SPEC_TEST_BINS = 1024;
// 輝点判定の輝度しきい値（背景は暗紺 ≈ 輝度10、スパイクは白系 ≈ 輝度225）
const SPEC_BRIGHT_LUMINANCE = 150;

const runSpectrogramTests = async () => {
  const listEl = document.getElementById('spectrogram-results');
  const summaryEl = document.getElementById('spectrogram-summary');
  listEl.replaceChildren();
  summaryEl.textContent = '実行中…';
  summaryEl.className = '';

  const canvas = document.createElement('canvas');
  const renderer = createSpectrogramRenderer(canvas, {
    width: SPEC_TEST_WIDTH,
    height: SPEC_TEST_HEIGHT,
    pixelRatio: 1,
  });
  const ctx = canvas.getContext('2d');
  const results = [];

  const luminanceAt = (x, y) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return (d[0] + d[1] + d[2]) / 3;
  };
  const brightestYAt = (x) => {
    let best = -1;
    let bestY = -1;
    for (let y = 0; y < renderer.height; y += 1) {
      const l = luminanceAt(x, y);
      if (l > best) {
        best = l;
        bestY = y;
      }
    }
    return { y: bestY, luminance: best };
  };
  const spikeData = (bin) => {
    const data = new Uint8Array(SPEC_TEST_BINS);
    data[bin] = 255;
    return data;
  };
  // 実装と同じマッピング: ビン b は下から floor(b/bins*height) 行目
  const expectedYForBin = (bin) =>
    renderer.height - 1 - Math.floor((bin / SPEC_TEST_BINS) * renderer.height);

  const addResult = (name, expected, actual, pass) => {
    results.push({ name, expected, actual, pass });
    const li = document.createElement('li');
    li.textContent = `${name} — 期待: ${expected} / 実測: ${actual} → ${pass ? 'PASS' : 'FAIL'}`;
    li.className = pass ? 'row-pass' : 'row-fail';
    listEl.appendChild(li);
  };

  // テスト1: 周波数→縦位置のマッピング（低ビン=下、高ビン=上）
  renderer.clear();
  renderer.drawColumn(spikeData(100));
  const low = brightestYAt(renderer.width - 1);
  const lowExpected = expectedYForBin(100);
  addResult(
    '低周波ビン(100)の輝点位置',
    `y=${lowExpected}`,
    `y=${low.y}（輝度${low.luminance.toFixed(0)}）`,
    low.y === lowExpected && low.luminance >= SPEC_BRIGHT_LUMINANCE,
  );

  renderer.drawColumn(spikeData(800));
  const high = brightestYAt(renderer.width - 1);
  const highExpected = expectedYForBin(800);
  addResult(
    '高周波ビン(800)の輝点位置（低ビンより上）',
    `y=${highExpected} かつ y(高) < y(低)`,
    `y=${high.y}`,
    high.y === highExpected && high.y < low.y && high.luminance >= SPEC_BRIGHT_LUMINANCE,
  );

  // テスト2: スクロール（1列描くと過去の列が左へ colWidth ぶん移動する）
  const scrolled = brightestYAt(renderer.width - renderer.colWidth - 1);
  addResult(
    'スクロール後の旧列の位置',
    `1列左（x=${renderer.width - renderer.colWidth - 1}）に y=${lowExpected} の輝点`,
    `y=${scrolled.y}（輝度${scrolled.luminance.toFixed(0)}）`,
    scrolled.y === lowExpected && scrolled.luminance >= SPEC_BRIGHT_LUMINANCE,
  );

  // テスト3: 停止後に描画ループが止まる（偽Analyserで呼び出し回数を計測）。
  // 非表示タブではブラウザ仕様で rAF が発火しないため、テスト中のみ
  // setTimeout ベースの代替に差し替えてループ制御ロジックを検証する。
  let calls = 0;
  const fakeAnalyser = {
    frequencyBinCount: SPEC_TEST_BINS,
    getByteFrequencyData: (arr) => {
      calls += 1;
      arr.fill(0);
    },
  };
  const realRaf = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  let callsWhileRunning = 0;
  let callsAfterStop = 0;
  try {
    const stopLoop = startRenderLoop(fakeAnalyser, renderer);
    await new Promise((resolve) => setTimeout(resolve, 200));
    callsWhileRunning = calls;
    stopLoop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    callsAfterStop = calls;
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
  }
  addResult(
    '停止後に描画ループが止まる',
    '稼働中は呼び出しが増え、停止後は増えない',
    `稼働中${callsWhileRunning}回 → 停止後${callsAfterStop}回`,
    callsWhileRunning > 0 && callsAfterStop === callsWhileRunning,
  );

  const allPass = results.every((r) => r.pass);
  summaryEl.textContent = allPass
    ? `全 ${results.length} 件 PASS`
    : `FAIL あり（${results.filter((r) => !r.pass).length}/${results.length} 件）`;
  summaryEl.className = allPass ? 'summary-pass' : 'summary-fail';
  window.__spectrogramTests = results;
  return results;
};

// ---------- イベント結線 ----------

document.getElementById('run-synthetic-tests').addEventListener('click', runSyntheticTests);
document.getElementById('run-loopback-test').addEventListener('click', runLoopbackTest);
document.getElementById('run-spectrogram-tests').addEventListener('click', runSpectrogramTests);
document.getElementById('run-boundary-test').addEventListener('click', runBoundaryStabilityTest);
document.getElementById('run-rejection-tests').addEventListener('click', runRejectionTests);
document.getElementById('load-manifest-button').addEventListener('click', loadFromManifest);
document.getElementById('sample-file-input').addEventListener('change', (event) => {
  analyzeFiles([...event.target.files]);
});
