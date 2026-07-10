// 音声特徴量の抽出（オフライン解析専用 — AnalyserNode には依存しない）。
// 入力は Float32Array（モノラルPCM）+ sampleRate。AudioBuffer.getChannelData(0) をそのまま渡せる。

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;

// 鳴き声区間の検出: ピークRMSに対する相対閾値（マイクごとの音量差に依存しないため相対値を使う）
const ACTIVITY_THRESHOLD_RATIO = 0.15;
// ほぼ無音の入力を「全区間アクティブ」と誤検出しないための絶対フロア
const MIN_RMS_FLOOR = 0.001;
// 環境ノイズをこの倍率で上回る音のみを鳴き声候補とする（AGC無効化でノイズフロアが素のまま出るため必要）
const NOISE_FLOOR_MARGIN = 3;
// ノイズフロア由来の閾値がピークに対して高くなりすぎないようにする上限。
// これがないと定常音（持続する遠吠え・正弦波）でノイズフロア≒ピークとなり区間を1つも検出できない
const MAX_THRESHOLD_TO_PEAK_RATIO = 0.5;
// ノイズフロアの推定に使う下位パーセンタイル（静かなフレームの代表値）
const NOISE_FLOOR_PERCENTILE = 0.2;
// この秒数以内に隣接する区間は同一の鳴き声として結合する
const SEGMENT_MERGE_GAP_SEC = 0.08;
// これより短い区間はクリックノイズ等とみなして捨てる
const MIN_SEGMENT_DURATION_SEC = 0.03;

// ピッチ探索範囲: 低い唸り（〜60Hz台）から高い悲鳴（〜2kHz）までを想定
const PITCH_MIN_HZ = 60;
// 探索上限。この値に張り付いた推定値は「範囲内で最も高い周波数」を返しただけで
// 実質的な意味を持たないため、分類器側で信頼できないものとして扱う
export const PITCH_MAX_HZ = 2000;
const PITCH_WINDOW_SAMPLES = 8192;
// 自己相関のグローバル最大の90%以上なら最小ラグ側の局所ピークを採用（オクターブ下の誤検出防止）
const PITCH_PEAK_TOLERANCE = 0.9;

// 堅牢ピッチ推定: 区間を複数窓に分けて推定し、オクターブを揃えてから代表値を取る。
// 単一窓だと唸り声（周期性が弱い音）で基音と倍音のどちらにロックするかが揺れるため。
const PITCH_WINDOW_HOP_RATIO = 0.5;
// この clarity 未満の窓は推定が信用できないので代表値の計算から除外する
const PITCH_MIN_WINDOW_CLARITY = 0.15;
// 長い区間で窓が増えすぎないように上限を設ける（計算量の抑制）
const PITCH_MAX_WINDOWS = 24;
// 基準ピッチに対してこの倍率を超えていたらオクターブ違いとみなして畳み込む
const OCTAVE_FOLD_RATIO = 1.5;
// 代表値のこの倍率内に収まる窓を「合意している」とみなす（約±2半音）
const PITCH_AGREEMENT_RATIO = 1.12;
// 合意した窓がこの割合に満たない場合、ピッチは定義できないとみなし null を返す。
// 唸り声・咆哮は声帯が不規則に振動するため一意なピッチが存在しない（物理的に妥当な棄却）
const PITCH_MIN_AGREEMENT = 0.5;

// ピッチ変化パターンの判定: 区間をこの数に分割して先頭と末尾のピッチを比較する
const CONTOUR_SEGMENT_COUNT = 4;
// 分割窓のピッチをこのclarity未満なら信頼せず除外する
const CONTOUR_MIN_CLARITY = 0.3;
// 末尾/先頭のピッチ比がこの範囲を外れたら上昇・下降とみなす（約±2半音）
const CONTOUR_RISING_RATIO = 1.12;
const CONTOUR_FALLING_RATIO = 0.89;

// スペクトル重心の計算に使うFFTサイズ（2の冪であること）
const SPECTRUM_FFT_SIZE = 2048;

/** フレームごとのRMS（音量エンベロープの元データ）を計算する */
export const computeRmsFrames = (samples, sampleRate) => {
  const frames = [];
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    let sum = 0;
    for (let i = start; i < start + FRAME_SIZE; i += 1) {
      sum += samples[i] * samples[i];
    }
    frames.push({
      timeSec: (start + FRAME_SIZE / 2) / sampleRate,
      rms: Math.sqrt(sum / FRAME_SIZE),
    });
  }
  return frames;
};

/** 静かなフレームの代表値から環境ノイズのレベルを推定する */
export const estimateNoiseFloor = (frames) => {
  if (frames.length === 0) return 0;
  const sorted = frames.map((f) => f.rms).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * NOISE_FLOOR_PERCENTILE));
  return sorted[index];
};

/** RMSフレーム列から鳴き声区間（アクティブ区間）を検出する */
export const detectSegments = (frames) => {
  if (frames.length === 0) return [];
  const peak = Math.max(...frames.map((f) => f.rms));
  if (peak < MIN_RMS_FLOOR) return [];

  // 環境ノイズを踏まえて閾値を持ち上げる。ただしピークの一定割合で頭打ちにしないと、
  // 定常音（録音全体を埋める遠吠え等）でノイズフロア≒ピークとなり検出不能になる。
  // 「定常ノイズか持続音か」はRMS分布では判別できない（周期性=clarityが必要）ため、
  // ノイズの棄却はここでは行わず、peakToNoiseRatio を特徴量として分類器へ渡す。
  const noiseFloor = estimateNoiseFloor(frames);
  const noiseBasedThreshold = Math.min(
    noiseFloor * NOISE_FLOOR_MARGIN,
    peak * MAX_THRESHOLD_TO_PEAK_RATIO,
  );
  const threshold = Math.max(peak * ACTIVITY_THRESHOLD_RATIO, noiseBasedThreshold, MIN_RMS_FLOOR);

  const raw = [];
  let current = null;
  for (const frame of frames) {
    if (frame.rms >= threshold) {
      if (current) {
        current.endSec = frame.timeSec;
        current.frames.push(frame);
      } else {
        current = { startSec: frame.timeSec, endSec: frame.timeSec, frames: [frame] };
      }
    } else if (current) {
      raw.push(current);
      current = null;
    }
  }
  if (current) raw.push(current);

  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.startSec - last.endSec <= SEGMENT_MERGE_GAP_SEC) {
      last.endSec = seg.endSec;
      last.frames.push(...seg.frames);
    } else {
      merged.push(seg);
    }
  }

  return merged
    .map((seg) => {
      let peakFrame = seg.frames[0];
      for (const f of seg.frames) {
        if (f.rms > peakFrame.rms) peakFrame = f;
      }
      return {
        startSec: seg.startSec,
        endSec: seg.endSec,
        durationSec: seg.endSec - seg.startSec,
        // 立ち上がりの鋭さ: 区間開始からピーク音量までの時間（短いほど鋭い）
        attackSec: peakFrame.timeSec - seg.startSec,
        peakRms: peakFrame.rms,
      };
    })
    .filter((seg) => seg.durationSec >= MIN_SEGMENT_DURATION_SEC);
};

/**
 * 正規化自己相関（NAC）によるピッチ推定。
 * 戻り値の clarity（相関ピークの鮮明さ 0〜1）は周期性の強さを表し、
 * 1 - clarity をノイズ成分割合の指標として使う。
 */
export const estimatePitch = (samples, sampleRate) => {
  const n = Math.min(PITCH_WINDOW_SAMPLES, samples.length);
  const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
  const maxLag = Math.min(Math.floor(sampleRate / PITCH_MIN_HZ), n - 2);
  if (maxLag <= minLag + 1) return { pitchHz: null, clarity: 0 };

  const offset = Math.floor((samples.length - n) / 2);
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += samples[offset + i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = samples[offset + i] - mean;

  // 自己相関はパワースペクトルの逆変換に等しい（ウィーナー=ヒンチンの定理）ため、
  // 総当たり O(n×ラグ数) ではなく FFT の O(n log n) で求める
  const raw = autocorrelateViaFft(x, maxLag);
  // 各ラグでの正規化に使うエネルギーは、二乗の累積和から O(1) で引く
  const prefixSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefixSq[i + 1] = prefixSq[i] + x[i] * x[i];

  const nac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const e1 = prefixSq[n - lag];
    const e2 = prefixSq[n] - prefixSq[lag];
    nac[lag] = e1 > 0 && e2 > 0 ? raw[lag] / Math.sqrt(e1 * e2) : 0;
  }

  let globalMax = 0;
  let globalMaxLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (nac[lag] > globalMax) {
      globalMax = nac[lag];
      globalMaxLag = lag;
    }
  }
  if (globalMax <= 0) return { pitchHz: null, clarity: 0 };

  let chosen = -1;
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    if (
      nac[lag] >= PITCH_PEAK_TOLERANCE * globalMax &&
      nac[lag] >= nac[lag - 1] &&
      nac[lag] >= nac[lag + 1]
    ) {
      chosen = lag;
      break;
    }
  }
  if (chosen < 0) chosen = globalMaxLag;

  // 放物線補間でラグをサブサンプル精度に補正する
  let lagRefined = chosen;
  if (chosen > minLag && chosen < maxLag) {
    const y1 = nac[chosen - 1];
    const y2 = nac[chosen];
    const y3 = nac[chosen + 1];
    const denom = y1 - 2 * y2 + y3;
    if (denom !== 0) lagRefined = chosen + (0.5 * (y1 - y3)) / denom;
  }

  return { pitchHz: sampleRate / lagRefined, clarity: nac[chosen] };
};

/** 重み付き中央値（重みの累積が半分を超える要素を返す。外れ値に強い） */
const weightedMedian = (values, weights) => {
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const half = pairs.reduce((sum, p) => sum + p.w, 0) / 2;
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= half) return p.v;
  }
  return pairs[pairs.length - 1].v;
};

/**
 * 区間全体から堅牢にピッチを推定する。
 * 複数窓で推定 → 最も clarity の高い窓を基準にオクターブを揃える → clarity 重み付き中央値。
 * 窓同士が合意しない場合（唸り声など周期性が乱れた音）は pitchHz に null を返す。
 * clarity は窓の平均（区間全体としての周期性の強さ）、agreement は合意した窓の割合。
 */
export const estimatePitchRobust = (samples, sampleRate) => {
  const windowSize = Math.min(PITCH_WINDOW_SAMPLES, samples.length);
  const hop = Math.max(1, Math.floor(windowSize * PITCH_WINDOW_HOP_RATIO));
  const estimates = [];
  for (let start = 0; start + windowSize <= samples.length; start += hop) {
    if (estimates.length >= PITCH_MAX_WINDOWS) break;
    const { pitchHz, clarity } = estimatePitch(samples.subarray(start, start + windowSize), sampleRate);
    if (pitchHz !== null) estimates.push({ pitchHz, clarity });
  }
  if (estimates.length === 0) {
    const single = estimatePitch(samples, sampleRate);
    return { ...single, agreement: single.pitchHz === null ? 0 : 1 };
  }

  const meanClarity = estimates.reduce((sum, e) => sum + e.clarity, 0) / estimates.length;
  const usable = estimates.filter((e) => e.clarity >= PITCH_MIN_WINDOW_CLARITY);
  if (usable.length === 0) return { pitchHz: null, clarity: meanClarity, agreement: 0 };

  // 最も信頼できる窓を基準に、各推定値を1オクターブだけ畳み込んで揃える。
  // 2オクターブ以上離れた値は「同じ音の別オクターブ」ではなく別物を測った結果なので、
  // 基準へ引き寄せずに不一致として扱う（多数決の汚染を防ぐ）
  const reference = usable.reduce((a, b) => (b.clarity > a.clarity ? b : a)).pitchHz;
  const lowerBound = reference / OCTAVE_FOLD_RATIO;
  const upperBound = reference * OCTAVE_FOLD_RATIO;
  const foldOneOctave = (pitchHz) => {
    if (pitchHz > upperBound && pitchHz / 2 >= lowerBound) return pitchHz / 2;
    if (pitchHz < lowerBound && pitchHz * 2 <= upperBound) return pitchHz * 2;
    return pitchHz;
  };

  const foldable = [];
  for (const e of usable) {
    const p = foldOneOctave(e.pitchHz);
    if (p >= lowerBound && p <= upperBound) foldable.push({ pitchHz: p, clarity: e.clarity });
  }
  if (foldable.length === 0) return { pitchHz: null, clarity: meanClarity, agreement: 0 };

  const candidate = weightedMedian(foldable.map((e) => e.pitchHz), foldable.map((e) => e.clarity));
  // 合意の分母は「使えた窓すべて」。畳み込めなかった窓も不一致として数える
  const agreeing = foldable.filter(
    (e) => Math.max(e.pitchHz, candidate) / Math.min(e.pitchHz, candidate) <= PITCH_AGREEMENT_RATIO,
  ).length;
  const agreement = agreeing / usable.length;

  return {
    pitchHz: agreement >= PITCH_MIN_AGREEMENT ? candidate : null,
    clarity: meanClarity,
    agreement,
  };
};

/** 実数入力の基数2 FFT（in-place）。re/im は長さが2の冪の Float32Array */
const fftInPlace = (re, im) => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
};

/**
 * 自己相関 r[lag] = Σ x[i]·x[i+lag] を FFT 経由で求める（0 ≦ lag ≦ maxLag）。
 * 巡回畳み込みの回り込みを避けるため 2n 以上の 2 の冪まで零詰めする。
 * 実信号のパワースペクトルは実かつ偶対称なので、逆変換は順変換で代用できる（1/N のみ補正）。
 */
const autocorrelateViaFft = (x, maxLag) => {
  const n = x.length;
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  re.set(x);
  fftInPlace(re, im);
  for (let i = 0; i < size; i += 1) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fftInPlace(re, im);
  const result = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag += 1) result[lag] = re[lag] / size;
  return result;
};

/**
 * スペクトル重心（音の「明るさ」の指標）を Hz で返す。
 * 振幅スペクトルを重みとした周波数の加重平均。唸り声（低く暗い）と吠え（高く明るい）を分ける。
 */
export const computeSpectralCentroid = (samples, sampleRate) => {
  if (samples.length < SPECTRUM_FFT_SIZE) return null;
  let weightedSum = 0;
  let magnitudeSum = 0;
  const re = new Float32Array(SPECTRUM_FFT_SIZE);
  const im = new Float32Array(SPECTRUM_FFT_SIZE);

  for (let start = 0; start + SPECTRUM_FFT_SIZE <= samples.length; start += SPECTRUM_FFT_SIZE) {
    for (let i = 0; i < SPECTRUM_FFT_SIZE; i += 1) {
      // Hann窓でスペクトル漏れを抑える（矩形窓だと重心が高域へ引きずられる）
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPECTRUM_FFT_SIZE - 1)));
      re[i] = samples[start + i] * w;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let bin = 1; bin < SPECTRUM_FFT_SIZE / 2; bin += 1) {
      const magnitude = Math.hypot(re[bin], im[bin]);
      weightedSum += ((bin * sampleRate) / SPECTRUM_FFT_SIZE) * magnitude;
      magnitudeSum += magnitude;
    }
  }
  return magnitudeSum > 0 ? weightedSum / magnitudeSum : null;
};

/**
 * ピッチの時間変化パターンを 'rising' | 'falling' | 'flat' | null で返す。
 * 区間を分割して各窓のピッチを推定し、信頼できる先頭と末尾を比較する。
 */
export const analyzePitchContour = (samples, sampleRate) => {
  const windowSize = Math.floor(samples.length / CONTOUR_SEGMENT_COUNT);
  if (windowSize < sampleRate / PITCH_MIN_HZ) return { contour: null, pitches: [] };

  const pitches = [];
  for (let i = 0; i < CONTOUR_SEGMENT_COUNT; i += 1) {
    const slice = samples.subarray(i * windowSize, (i + 1) * windowSize);
    const { pitchHz, clarity } = estimatePitch(slice, sampleRate);
    if (pitchHz !== null && clarity >= CONTOUR_MIN_CLARITY) pitches.push(pitchHz);
  }
  if (pitches.length < 2) return { contour: null, pitches };

  const ratio = pitches[pitches.length - 1] / pitches[0];
  let contour = 'flat';
  if (ratio >= CONTOUR_RISING_RATIO) contour = 'rising';
  else if (ratio <= CONTOUR_FALLING_RATIO) contour = 'falling';
  return { contour, pitches };
};

/** PCM全体を解析し、特徴量一式を返す */
export const analyzeSamples = (samples, sampleRate) => {
  const frames = computeRmsFrames(samples, sampleRate);
  const segments = detectSegments(frames);
  const peakRms = frames.length > 0 ? Math.max(...frames.map((f) => f.rms)) : 0;
  const noiseFloorRms = estimateNoiseFloor(frames);

  const result = {
    totalDurationSec: samples.length / sampleRate,
    peakRms,
    noiseFloorRms,
    // 音量のダイナミクス。定常ノイズ・定常音では 1 に近く、明確な発声があると大きくなる。
    // clarity と組み合わせることで「環境ノイズだけの録音」を分類器が棄却できる
    peakToNoiseRatio: noiseFloorRms > 0 ? peakRms / noiseFloorRms : null,
    segmentCount: segments.length,
    segments,
    meanGapSec: null,
    mainDurationSec: null,
    mainAttackSec: null,
    pitchHz: null,
    pitchClarity: 0,
    // 窓ごとのピッチ推定が一致した割合。低い＝周期が乱れており「ピッチが定義できない音」
    pitchAgreement: 0,
    noiseRatio: null,
    spectralCentroidHz: null,
    pitchContour: null,
  };
  if (segments.length === 0) return result;

  if (segments.length >= 2) {
    let gapSum = 0;
    for (let i = 1; i < segments.length; i += 1) {
      gapSum += segments[i].startSec - segments[i - 1].endSec;
    }
    result.meanGapSec = gapSum / (segments.length - 1);
  }

  // ピッチ・ノイズ割合は最も長い区間（主要な鳴き）で代表させる
  const main = segments.reduce((a, b) => (b.durationSec > a.durationSec ? b : a));
  result.mainDurationSec = main.durationSec;
  result.mainAttackSec = main.attackSec;

  const start = Math.max(0, Math.floor(main.startSec * sampleRate));
  const end = Math.min(samples.length, Math.ceil(main.endSec * sampleRate));
  const mainSamples = samples.subarray(start, end);

  const { pitchHz, clarity, agreement } = estimatePitchRobust(mainSamples, sampleRate);
  result.pitchHz = pitchHz;
  result.pitchClarity = clarity;
  result.pitchAgreement = agreement;
  result.noiseRatio = 1 - clarity;
  result.spectralCentroidHz = computeSpectralCentroid(mainSamples, sampleRate);
  result.pitchContour = analyzePitchContour(mainSamples, sampleRate).contour;

  return result;
};
