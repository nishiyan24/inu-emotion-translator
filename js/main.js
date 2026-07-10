// エントリーポイント: UI要素とロジックの結線を担当する。
// 録音/ファイルのどちらの入力も currentBuffer（AudioBuffer）に集約され、
// 解析（特徴量抽出 → 感情分類）はこのバッファだけを見る。

import { startMicRecording, decodeAudioFile, toMono } from './audio-capture.js';
import { createSpectrogramRenderer, startRenderLoop } from './spectrogram-renderer.js';
import { analyzeSamples } from './feature-extraction.js';
import {
  classifyEmotion,
  EMOTION_LABELS,
  EMOTION_DETAILS,
  EMOTION_ADVICE,
  EMOTION_ILLUSTRATIONS,
} from './emotion-classifier.js';
import { describeFeatures } from './feature-descriptors.js';

const recordStartButton = document.getElementById('record-start-button');
const recordStopButton = document.getElementById('record-stop-button');
const playbackButton = document.getElementById('playback-button');
const playbackButtonLabel = document.getElementById('playback-button-label');
const audioFileInput = document.getElementById('audio-file-input');
const filePickerFilename = document.getElementById('file-picker-filename');
const fileDropzone = document.getElementById('file-dropzone');
const statusMessage = document.getElementById('status-message');
const spectrogramCanvas = document.getElementById('spectrogram-canvas');
const spectrogramStatus = document.getElementById('spectrogram-status');
const spectrogramStatusText = document.getElementById('spectrogram-status-text');
const emotionLabelElement = document.getElementById('emotion-label');
const emotionReasonElement = document.getElementById('emotion-reason');
const analyzingIndicator = document.getElementById('analyzing-indicator');
const emotionDetailBox = document.getElementById('emotion-detail-box');
const emotionDetailText = document.getElementById('emotion-detail');
const emotionAdviceBox = document.getElementById('emotion-advice-box');
const emotionAdviceText = document.getElementById('emotion-advice');
const emotionIllustrationImage = document.getElementById('emotion-illustration-image');
const featureCardElements = {
  pitch: document.getElementById('feature-pitch'),
  volume: document.getElementById('feature-volume'),
  duration: document.getElementById('feature-duration'),
  spread: document.getElementById('feature-spread'),
  waviness: document.getElementById('feature-waviness'),
};
const howToOpenButton = document.getElementById('how-to-open-button');
const howToCloseButton = document.getElementById('how-to-close-button');
const howToModal = document.getElementById('how-to-modal');
const modeMenu = document.querySelector('.mode-menu');
const modeOpenButton = document.getElementById('mode-open-button');
const modePopup = document.getElementById('mode-popup');
const modeOptionButtons = document.querySelectorAll('.mode-option');

const ANALYSER_FFT_SIZE = 2048;
// 表示専用のため軽く平滑化する(0=生値でチラつく、1に近いほど残像が強い)
const ANALYSER_SMOOTHING = 0.5;

const RESULT_PLACEHOLDER_LABEL = 'まだ解析結果はありません';

let audioContext = null;
let activeRecording = null;
let currentBuffer = null;
let playbackSource = null;
let analyser = null;
let spectrogramRenderer = null;
let stopSpectrogramLoop = null;

const setStatus = (text) => {
  statusMessage.textContent = text;
};

// iOS では Web Audio の出力が既定で ambient 扱いとなり、消音スイッチで無音化される。
// AudioSession API（iOS 17+）で用途を宣言すると消音スイッチを無視して再生できる。
// 録音時は 'play-and-record'、再生時は 'playback' と、用途ごとに切り替える必要がある
// （録音中に 'playback' を宣言するとマイク入力が使えなくなる）。
const declareAudioSession = (type) => {
  if ('audioSession' in navigator) {
    try {
      navigator.audioSession.type = type;
    } catch {
      // 非対応環境では無視してよい（PC ブラウザ等）
    }
  }
};

// iOS Safari の自動再生ポリシー対応: AudioContext はユーザー操作の中で生成・resume する
const getAudioContext = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
};

const getAnalyser = () => {
  const ctx = getAudioContext();
  if (!analyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
  }
  return analyser;
};

const setSpectrogramStatus = (active) => {
  spectrogramStatus.classList.toggle('status-pill--active', active);
  spectrogramStatus.classList.toggle('status-pill--idle', !active);
  spectrogramStatusText.textContent = active ? 'リアルタイム解析中' : '待機中';
};

const startSpectrogram = () => {
  stopSpectrogram();
  if (!spectrogramRenderer) {
    spectrogramRenderer = createSpectrogramRenderer(spectrogramCanvas);
  }
  spectrogramRenderer.clear();
  stopSpectrogramLoop = startRenderLoop(getAnalyser(), spectrogramRenderer);
  setSpectrogramStatus(true);
};

const stopSpectrogram = () => {
  if (stopSpectrogramLoop) {
    stopSpectrogramLoop();
    stopSpectrogramLoop = null;
  }
  setSpectrogramStatus(false);
};

// 再生ボタンのラベルは、いま読み込まれている音声の出自に追従させる
// （録音とファイルは同じ currentBuffer に集約されるため、表示だけが実態とずれないようにする）
const setPlaybackSource = (buffer, kind) => {
  currentBuffer = buffer;
  playbackButton.disabled = buffer === null;
  playbackButtonLabel.textContent = kind === 'file' ? '音声を再生' : '録音を再生';
};

const setEmotionResult = (labelText, reasonText) => {
  emotionLabelElement.textContent = labelText;
  emotionReasonElement.textContent = reasonText;
};

const FEATURE_CARD_PLACEHOLDER = '—';

/** 音の特徴量カード5枚を「まだ何もない」状態に戻す */
const resetFeatureCards = () => {
  Object.values(featureCardElements).forEach((el) => {
    el.textContent = FEATURE_CARD_PLACEHOLDER;
  });
};

/** 音の特徴量カード5枚に、解析結果から作ったラベルを反映する */
const showFeatureCards = (features) => {
  const descriptors = describeFeatures(features);
  Object.entries(featureCardElements).forEach(([key, el]) => {
    el.textContent = descriptors[key];
  });
};

/**
 * 「気持ちの詳細」「おすすめの対応」ボックスとイラストを更新する。
 * 対応する文言・画像が無い（= 判定できませんでした）場合はそれぞれ隠す。
 */
const showEmotionInfoBoxes = (emotion) => {
  const detail = EMOTION_DETAILS[emotion];
  const advice = EMOTION_ADVICE[emotion];
  const illustration = EMOTION_ILLUSTRATIONS[emotion];
  emotionDetailBox.hidden = detail === null;
  emotionDetailText.textContent = detail ?? '';
  emotionAdviceBox.hidden = advice === null;
  emotionAdviceText.textContent = advice ?? '';
  emotionIllustrationImage.hidden = illustration === null;
  emotionIllustrationImage.src = illustration ?? '';
};

const resetEmotionInfoBoxes = () => {
  emotionDetailBox.hidden = true;
  emotionAdviceBox.hidden = true;
  emotionIllustrationImage.hidden = true;
  emotionIllustrationImage.src = '';
};

/** 感情の推定結果を「まだ何もない」状態に戻す（前回の結果が居残らないようにする） */
const resetEmotionResult = (hintText) => {
  setAnalyzingResultState(false);
  setEmotionResult(RESULT_PLACEHOLDER_LABEL, hintText);
  resetFeatureCards();
  resetEmotionInfoBoxes();
};

/**
 * 再生(=解析)が進行中であることを、結果表示エリア自体にも点滅で示す。
 * 解析中インジケーター（スペクトログラム脇）と二重に伝えることで、
 * 「表示は解析中なのに結果はもう出ている」という状態のズレを防ぐ。
 */
const setAnalyzingResultState = (isAnalyzing) => {
  emotionLabelElement.classList.toggle('result-label--analyzing', isAnalyzing);
  emotionReasonElement.classList.toggle('result-reason--analyzing', isAnalyzing);
  if (isAnalyzing) {
    setEmotionResult('ただいま音声を解析中…', 'スペクトログラムの動きをご確認ください。');
  }
};

/** 現在のバッファを解析し、感情の推定結果をUIへ反映する */
const analyzeAndShowEmotion = (buffer) => {
  try {
    const features = analyzeSamples(toMono(buffer), buffer.sampleRate);
    const { emotion, reason } = classifyEmotion(features);
    setEmotionResult(EMOTION_LABELS[emotion], reason);
    showFeatureCards(features);
    showEmotionInfoBoxes(emotion);
    // 検証用フック（自動テストが解析結果を読むためのもの。UIからは使わない）
    window.__lastAnalysis = { features, emotion, reason };
  } catch (error) {
    console.error('[main] 解析エラー:', error);
    setEmotionResult('解析できませんでした', 'この音声の解析中に問題が発生しました。');
    resetFeatureCards();
    resetEmotionInfoBoxes();
  }
};

const setRecordingUiState = (isRecording) => {
  recordStartButton.disabled = isRecording;
  recordStopButton.disabled = !isRecording;
};

const micErrorMessage = (error) => {
  if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
    return 'マイクの使用が許可されませんでした。ブラウザのサイト設定でマイクを許可してから再度お試しください。';
  }
  if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
    return 'マイクが見つかりませんでした。マイクを接続してから再度お試しください。';
  }
  if (window.isSecureContext === false) {
    return 'このページが安全な接続（https または localhost）で開かれていないため、マイクを使用できません。';
  }
  return `マイクを開始できませんでした: ${error.message}`;
};

const startRecording = async () => {
  try {
    declareAudioSession('play-and-record');
    const ctx = getAudioContext();
    setStatus('マイクの許可を待っています…');
    activeRecording = await startMicRecording(ctx, getAnalyser());
    setRecordingUiState(true);
    startSpectrogram();
    setEmotionResult('録音中…', '停止した後、「録音を再生」ボタンを押すと解析されます。');
    setStatus('録音中… 停止ボタンで終了します。');
  } catch (error) {
    console.error('[main] マイク開始エラー:', error);
    activeRecording = null;
    setRecordingUiState(false);
    setStatus(micErrorMessage(error));
  }
};

const stopRecording = async (reasonText = '') => {
  if (!activeRecording) return;
  const recording = activeRecording;
  activeRecording = null;
  setRecordingUiState(false);
  stopSpectrogram();
  const buffer = await recording.stop();
  if (!buffer) {
    setStatus(`${reasonText}録音データが空でした。もう一度お試しください。`);
    return;
  }
  setPlaybackSource(buffer, 'recording');
  resetEmotionResult('「録音を再生」ボタンを押すと解析されます。');
  setStatus(`${reasonText}録音完了（${buffer.duration.toFixed(1)}秒）。「録音を再生」ボタンで解析します。`);
};

// 解析は「再生」ボタンを押した時だけ行う（録音停止・ファイル選択の直後には行わない）。
// 再生 = スペクトログラムでの可視化 = 解析のタイミングを1つの経路に統合することで、
// 「表示は解析中なのに結果はもう出ている」といった状態のズレが起きないようにする。
const playCurrentBuffer = () => {
  if (!currentBuffer) return;
  declareAudioSession('playback');
  const ctx = getAudioContext();
  if (playbackSource) {
    playbackSource.stop();
    playbackSource = null;
  }
  const bufferToAnalyze = currentBuffer;
  const source = ctx.createBufferSource();
  source.buffer = bufferToAnalyze;
  source.connect(ctx.destination);
  source.connect(getAnalyser());
  source.onended = () => {
    if (playbackSource === source) playbackSource = null;
    stopSpectrogram();
    analyzingIndicator.hidden = true;
    setAnalyzingResultState(false);
    analyzeAndShowEmotion(bufferToAnalyze);
    setStatus('再生が終了しました。解析が終わりました。');
  };
  setAnalyzingResultState(true);
  analyzingIndicator.hidden = false;
  source.start();
  startSpectrogram();
  playbackSource = source;
  setStatus(`再生中（${bufferToAnalyze.duration.toFixed(1)}秒）…`);
};

const loadAudioFile = async (file) => {
  try {
    const ctx = getAudioContext();
    setStatus(`読み込み中: ${file.name} …`);
    const buffer = await decodeAudioFile(ctx, file);
    setPlaybackSource(buffer, 'file');
    resetEmotionResult('「音声を再生」ボタンを押すと解析されます。');
    setStatus(`読み込み完了: ${file.name}（${buffer.duration.toFixed(1)}秒）。「音声を再生」ボタンで解析します。`);
  } catch (error) {
    console.error('[main] ファイル読み込みエラー:', error);
    if (error.code === 'FILE_TOO_LARGE') {
      setStatus(error.message);
    } else {
      setStatus(`このファイルは読み込めませんでした: ${file.name}（対応形式: mp3 / wav / m4a など）`);
    }
  }
};

recordStartButton.addEventListener('click', startRecording);
recordStopButton.addEventListener('click', () => stopRecording());
playbackButton.addEventListener('click', playCurrentBuffer);

// 「使い方」はページ遷移ではなく画面中央のポップアップで見せる（この先「設定」等が
// 増えても同じ仕組みを使い回せるよう、開閉だけの単純なオーバーレイにしている）
const openHowToModal = () => {
  howToModal.hidden = false;
  howToCloseButton.focus();
};

const closeHowToModal = () => {
  howToModal.hidden = true;
  howToOpenButton.focus();
};

howToOpenButton.addEventListener('click', openHowToModal);
howToCloseButton.addEventListener('click', closeHowToModal);
howToModal.addEventListener('click', (event) => {
  if (event.target === howToModal) closeHowToModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !howToModal.hidden) closeHowToModal();
});

// ドロップ枠を外れた位置にファイルを落とした場合、既定動作のままだとブラウザが
// そのファイルを開いてページごと遷移してしまうため、ページ全体で止めておく
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

const THEME_STORAGE_KEY = 'theme';

/** 昼(既定)/夜モードを適用し、選択状態の保存とメニュー表示への反映をする */
const applyTheme = (theme) => {
  if (theme === 'dark') {
    document.documentElement.dataset.theme = 'dark';
  } else {
    delete document.documentElement.dataset.theme;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // プライベートブラウジング等で保存できなくても、表示の切り替え自体は成立させる
  }
  modeOptionButtons.forEach((button) => {
    button.setAttribute('aria-current', button.dataset.themeChoice === theme ? 'true' : 'false');
  });
};

const openModePopup = () => {
  modePopup.hidden = false;
  modeOpenButton.setAttribute('aria-expanded', 'true');
};

const closeModePopup = () => {
  modePopup.hidden = true;
  modeOpenButton.setAttribute('aria-expanded', 'false');
};

modeOpenButton.addEventListener('click', () => {
  if (modePopup.hidden) openModePopup();
  else closeModePopup();
});

modeOptionButtons.forEach((button) => {
  button.addEventListener('click', () => {
    applyTheme(button.dataset.themeChoice);
    closeModePopup();
  });
});

document.addEventListener('click', (event) => {
  if (!modePopup.hidden && !modeMenu.contains(event.target)) closeModePopup();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modePopup.hidden) closeModePopup();
});

// head内の初期化スクリプトが既に data-theme を設定済みなので、ここではメニューの
// 選択状態(aria-current)を実際の状態に合わせるだけでよい
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

audioFileInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  filePickerFilename.textContent = file ? file.name : '選択されていません';
  if (file) loadAudioFile(file);
});

// ドラッグ&ドロップでのファイル読み込み（クリック選択と同じ loadAudioFile に合流させる）。
// dragenter/dragleave は子要素への出入りでも発火するため、カウンタで正味の在/不在を数える
// （素朴に真偽値で管理すると、子要素をまたぐたびに枠のハイライトがちらつく）
let dropDepth = 0;

fileDropzone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dropDepth += 1;
  fileDropzone.classList.add('file-dropzone--active');
});

fileDropzone.addEventListener('dragover', (event) => {
  // drop イベントを発生させるには dragover 側でも既定動作を止める必要がある
  event.preventDefault();
});

fileDropzone.addEventListener('dragleave', () => {
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0) fileDropzone.classList.remove('file-dropzone--active');
});

fileDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropDepth = 0;
  fileDropzone.classList.remove('file-dropzone--active');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  filePickerFilename.textContent = file.name;
  loadAudioFile(file);
});

// タブが非表示になったら録音を止め、マイクを解放する（録りっぱなし防止）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && activeRecording) {
    stopRecording('タブが非表示になったため録音を停止しました。');
  }
});

// 検証用フック（自動テストが現在のバッファ状態を読むためのもの。UIからは使わない）
window.__getCurrentBufferInfo = () =>
  currentBuffer
    ? {
        durationSec: currentBuffer.duration,
        sampleRate: currentBuffer.sampleRate,
        length: currentBuffer.length,
      }
    : null;
