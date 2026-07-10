// 特徴量 → 感情ラベルへのルールベース分岐。
// 閾値は test-samples/ の実測値に基づく（詳細は各定数のコメントと EMOTIONS の説明を参照）。
// 分類できない音は無理に感情を当てず REJECTED を返す。

import { PITCH_MAX_HZ } from './feature-extraction.js';

export const EMOTIONS = {
  AFFECTION_DEMAND: 'affection_demand',
  ALERT_THREAT: 'alert_threat',
  PLAY_INVITATION: 'play_invitation',
  ANXIETY_FEAR: 'anxiety_fear',
  LONELINESS: 'loneliness',
  PAIN_SOS: 'pain_sos',
  GREETING_CALL: 'greeting_call',
  REJECTED: 'rejected',
};

export const EMOTION_LABELS = {
  [EMOTIONS.AFFECTION_DEMAND]: '甘え・要求',
  [EMOTIONS.ALERT_THREAT]: '警戒・威嚇',
  [EMOTIONS.PLAY_INVITATION]: '遊びの誘い',
  [EMOTIONS.ANXIETY_FEAR]: '不安・恐怖',
  [EMOTIONS.LONELINESS]: 'さみしさ・分離不安',
  [EMOTIONS.PAIN_SOS]: '痛み・SOS',
  [EMOTIONS.GREETING_CALL]: '挨拶・呼びかけ',
  [EMOTIONS.REJECTED]: '判定できません',
};

// 「気持ちの詳細」: 判定理由(reason)を補う一般的な行動学の説明文。
// REJECTED は感情そのものを断定していないため用意しない(UI側は null を非表示扱いにする)。
export const EMOTION_DETAILS = {
  [EMOTIONS.AFFECTION_DEMAND]: 'かまってほしかったり、何かを要求したりする気持ちを表しているようです。',
  [EMOTIONS.ALERT_THREAT]: '何かを警戒していたり、威嚇していたりする気持ちを表しているようです。',
  [EMOTIONS.PLAY_INVITATION]: '遊びたい、楽しいという気持ちを表しているようです。',
  [EMOTIONS.ANXIETY_FEAR]: '不安や恐怖を感じている気持ちを表しているようです。',
  [EMOTIONS.LONELINESS]: 'さみしさや、そばにいたい気持ちを表しているようです。',
  [EMOTIONS.PAIN_SOS]: '痛みや体調不良など、SOSのサインである可能性があります。',
  [EMOTIONS.GREETING_CALL]: '挨拶や、飼い主さんへの呼びかけの気持ちを表しているようです。',
  [EMOTIONS.REJECTED]: null,
};

// 「おすすめの対応」: 断定的な指示ではなく、あくまで一般的な目安としての行動提案。
export const EMOTION_ADVICE = {
  // 要求に毎回即応すると要求吠えが強化されうる、という行動学の指摘(専門家資料調査より)を反映
  [EMOTIONS.AFFECTION_DEMAND]: '要求に応える前に、いったん鳴きやむのを待ってから構ってあげると、要求吠えの助長を避けられます。',
  [EMOTIONS.ALERT_THREAT]: '無理に近づかず、何を警戒しているか確認し、落ち着ける環境を作ってあげましょう。',
  [EMOTIONS.PLAY_INVITATION]: '手が空いていれば、一緒に遊んであげると喜びます。',
  [EMOTIONS.ANXIETY_FEAR]: '大きな音など原因になっていそうなものを遠ざけ、優しい声で安心させてあげましょう。',
  [EMOTIONS.LONELINESS]: '留守番の時間が長くなっていないか見直し、そばにいられるときはスキンシップを取ってあげましょう。',
  [EMOTIONS.PAIN_SOS]: '元気や食欲の様子もあわせて確認し、心配なときは動物病院に相談しましょう。',
  [EMOTIONS.GREETING_CALL]: '「どうしたの?」と声をかけてあげると、良いコミュニケーションになります。',
  [EMOTIONS.REJECTED]: 'もう少し愛犬に近づいて、はっきりと鳴き声を録音してみてください。',
};

// 感情ごとのイラスト(透過PNG)。REJECTED は特定の感情を断定していないため用意しない。
export const EMOTION_ILLUSTRATIONS = {
  [EMOTIONS.AFFECTION_DEMAND]: 'img/emotions/amae-youkyuu.png',
  [EMOTIONS.ALERT_THREAT]: 'img/emotions/keikai-ikaku.png',
  [EMOTIONS.PLAY_INVITATION]: 'img/emotions/asobi-no-sasoi.png',
  [EMOTIONS.ANXIETY_FEAR]: 'img/emotions/fuan-kyoufu.png',
  [EMOTIONS.LONELINESS]: 'img/emotions/samishisa-bunri-fuan.png',
  [EMOTIONS.PAIN_SOS]: 'img/emotions/itami-sos.png',
  [EMOTIONS.GREETING_CALL]: 'img/emotions/aisatsu-yobikake.png',
  [EMOTIONS.REJECTED]: null,
};

// --- 棄却の閾値 ---
// ノイズ成分が多い音は、犬の唸り声か別の動物・人の声・咳のような雑音か区別できない。
// pitchHz が null でない時点で合意度は必ず 0.5 以上(feature-extraction.js の
// PITCH_MIN_AGREEMENT で保証済み)なので、ここで合意度も条件に加えると
// 「ノイズが多い かつ 合意度が低い」の後半がほぼ常に偽になり実質無効化されてしまう。
// 声帯振動を伴う荒れた音(咳払い等)はノイズが多くても合意度は高く出るため、
// ノイズ比単独で判定する。
const REJECT_NOISE_RATIO = 0.6;
// 鳴き声とみなす最小音量。実測では全サンプルが 0.129 以上（冷蔵庫・エアコン等の
// 環境音はこれよりはるかに小さく、拾っても鳴き声と誤認しないようにする）
const MIN_VOICE_PEAK_RMS = 0.02;
// ピッチ探索の上限付近に張り付いた推定値は「範囲内で最も高い周波数」を返しただけで意味がない。
// 高域ノイズ（換気扇など）を高い鳴き声と誤認する原因になるため棄却する
const PITCH_CEILING_HZ = PITCH_MAX_HZ * 0.95;

// --- 反復吠えの判定 ---
// 3回以上の短い吠えが続くもの（実測: 遊び6回/甘え4〜6回）
const REPEATED_BARK_MIN_SEGMENTS = 3;
// 小型犬の甘え声は1000Hz超、中型犬の遊び吠えは650Hz前後だった
const HIGH_PITCH_BARK_HZ = 900;

// --- 単発の吠えの判定 ---
// 悲鳴的な高さ（実測: 1496Hz）。甘え声(1103Hz)を巻き込まないよう高めに置く
const SCREAM_PITCH_HZ = 1200;
const SCREAM_MAX_DURATION_SEC = 1.0;
// 遠吠え・持続音とみなす長さ（実測: 1.06秒）と、澄んだ音の目安（実測: 0.009）
const SUSTAINED_MIN_DURATION_SEC = 1.0;
const TONAL_MAX_NOISE_RATIO = 0.2;
// 唸り声の目安（実測: ノイズ0.579・ピッチ319Hz）
const GROWL_MIN_NOISE_RATIO = 0.45;
const GROWL_MAX_PITCH_HZ = 500;
// 単発の「ワンッ」（実測: 0.19秒・608Hz）
const GREETING_MAX_DURATION_SEC = 0.4;
const GREETING_MIN_PITCH_HZ = 400;
// 不安・恐怖: ピッチが上昇しながら高くなる声
const ANXIETY_MIN_PITCH_HZ = 500;

/**
 * 特徴量から感情を推定する。
 * 戻り値の reason は「なぜその判定になったか」の説明で、UIとデバッグの両方に使う。
 */
export const classifyEmotion = (features) => {
  const { segmentCount, peakRms, pitchHz, noiseRatio, mainDurationSec, pitchContour } = features;

  if (segmentCount === 0) {
    return { emotion: EMOTIONS.REJECTED, reason: '鳴き声と思われる音が検出されませんでした' };
  }

  // 冷蔵庫・エアコン等の環境音しか入っていない録音を鳴き声と誤認しない
  if (peakRms < MIN_VOICE_PEAK_RMS) {
    return {
      emotion: EMOTIONS.REJECTED,
      reason: '音が小さすぎます。鳴き声が録れているか確認して、もう一度お試しください',
    };
  }

  // ピッチが定まらない音（声帯が不規則に振動する咆哮など）は分類の主軸を欠く
  if (pitchHz === null) {
    return {
      emotion: EMOTIONS.REJECTED,
      reason: '音の高さが安定せず、犬の鳴き声として解析できませんでした',
    };
  }

  // 探索上限に張り付いたピッチ（換気扇などの高域ノイズ）は実質的な意味を持たない
  if (pitchHz >= PITCH_CEILING_HZ) {
    return {
      emotion: EMOTIONS.REJECTED,
      reason: '解析できる範囲を超えた高い音のため、犬の鳴き声か判断できませんでした',
    };
  }

  // 荒れた音(唸り声・咳・咳払いなど)は、犬の唸り声か別の音かを区別できない
  if (noiseRatio > REJECT_NOISE_RATIO) {
    return {
      emotion: EMOTIONS.REJECTED,
      reason: '雑音成分が多いため、犬の鳴き声か判断できませんでした',
    };
  }

  // 反復する吠え: ピッチの高さで甘えと遊びを分ける
  if (segmentCount >= REPEATED_BARK_MIN_SEGMENTS) {
    if (pitchHz >= HIGH_PITCH_BARK_HZ) {
      return {
        emotion: EMOTIONS.AFFECTION_DEMAND,
        reason: `高い声（${Math.round(pitchHz)}Hz）で${segmentCount}回続けて鳴いています`,
      };
    }
    return {
      emotion: EMOTIONS.PLAY_INVITATION,
      reason: `テンポよく${segmentCount}回続けて鳴いています`,
    };
  }

  // ここから単発（1〜2区間）の鳴き声
  if (pitchHz >= SCREAM_PITCH_HZ && mainDurationSec < SCREAM_MAX_DURATION_SEC) {
    return {
      emotion: EMOTIONS.PAIN_SOS,
      reason: `非常に高い声（${Math.round(pitchHz)}Hz）で短く鳴いています`,
    };
  }

  if (noiseRatio >= GROWL_MIN_NOISE_RATIO && pitchHz < GROWL_MAX_PITCH_HZ) {
    return {
      emotion: EMOTIONS.ALERT_THREAT,
      reason: `低くうなるような、ざらついた声です`,
    };
  }

  if (mainDurationSec >= SUSTAINED_MIN_DURATION_SEC && noiseRatio < TONAL_MAX_NOISE_RATIO) {
    return {
      emotion: EMOTIONS.LONELINESS,
      reason: `澄んだ声を${mainDurationSec.toFixed(1)}秒のあいだ長く伸ばしています`,
    };
  }

  if (pitchContour === 'rising' && pitchHz >= ANXIETY_MIN_PITCH_HZ) {
    return {
      emotion: EMOTIONS.ANXIETY_FEAR,
      reason: '声が高い方へ上ずっていく鳴き方です',
    };
  }

  if (
    mainDurationSec < GREETING_MAX_DURATION_SEC &&
    pitchHz >= GREETING_MIN_PITCH_HZ &&
    pitchHz < HIGH_PITCH_BARK_HZ
  ) {
    return {
      emotion: EMOTIONS.GREETING_CALL,
      reason: `短く一声「ワンッ」と鳴いています（${Math.round(pitchHz)}Hz）`,
    };
  }

  return {
    emotion: EMOTIONS.REJECTED,
    reason: 'どの鳴き方の特徴にも当てはまらず、判定できませんでした',
  };
};
