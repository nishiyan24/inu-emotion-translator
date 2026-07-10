// analyzeSamples() が返す生の数値特徴量を、UIの「音の特徴量」カードに出す
// 「高め/中くらい/低め」等の短い日本語ラベルへ変換する。判定ロジックは持たない(表示専用)。

const PLACEHOLDER = '測定不可';

const bucket = (value, thresholds) => {
  if (value === null || value === undefined) return PLACEHOLDER;
  for (const [limit, label] of thresholds) {
    if (value < limit) return label;
  }
  return thresholds[thresholds.length - 1][1];
};

// 各しきい値は emotion-classifier.js の分岐で使っている実測値(唸り319Hz・甘え1103Hz等)に揃えている
const describePitch = (pitchHz) =>
  bucket(pitchHz, [
    [450, '低め'],
    [900, '中くらい'],
    [Infinity, '高め'],
  ]);

const describeVolume = (peakRms) =>
  bucket(peakRms, [
    [0.2, '小さめ'],
    [0.5, '中くらい'],
    [Infinity, '大きい'],
  ]);

const describeDuration = (mainDurationSec) =>
  bucket(mainDurationSec, [
    [0.4, '短い'],
    [1.0, '中くらい'],
    [Infinity, '長い'],
  ]);

// ノイズ比が高い(倍音が乱れ広帯域に広がっている)ほど「広がりが大きい」と表現する
const describeSpread = (noiseRatio) =>
  bucket(noiseRatio, [
    [0.2, '狭い'],
    [0.45, 'やや広い'],
    [Infinity, '広い'],
  ]);

// pitchAgreement(窓ごとのピッチ推定が一致した割合)が低いほど声が「ゆらいでいる」とみなす
const describeWaviness = (pitchAgreement) => {
  if (pitchAgreement === null || pitchAgreement === undefined) return PLACEHOLDER;
  return bucket(1 - pitchAgreement, [
    [0.15, '少ない'],
    [0.35, 'やや多い'],
    [Infinity, '多い'],
  ]);
};

/** analyzeSamples() の結果から、特徴量カード5枚ぶんの表示用ラベルを作る */
export const describeFeatures = (features) => ({
  pitch: describePitch(features.pitchHz),
  volume: describeVolume(features.peakRms),
  duration: describeDuration(features.mainDurationSec),
  spread: describeSpread(features.noiseRatio),
  waviness: describeWaviness(features.pitchAgreement),
});
