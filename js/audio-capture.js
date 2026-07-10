// 音声入力基盤: マイク録音（PCMバッファリング）とファイルデコードを
// 同じ出口（AudioBuffer）に揃える。解析側は入力源がどちらかを意識しない。

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

const WORKLET_URL = 'js/pcm-capture-worklet.js';
// stop 指示後、オーディオスレッドから送信済みのチャンクが届き切るのを待つ時間
const CHUNK_FLUSH_WAIT_MS = 100;

const workletLoadedContexts = new WeakSet();

const ensureCaptureWorklet = async (audioContext) => {
  if (workletLoadedContexts.has(audioContext)) return;
  await audioContext.audioWorklet.addModule(WORKLET_URL);
  workletLoadedContexts.add(audioContext);
};

const assembleAudioBuffer = (audioContext, chunks, sampleRate) => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalLength === 0) return null;
  const merged = new Float32Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.length;
  }
  const buffer = audioContext.createBuffer(1, totalLength, sampleRate);
  buffer.copyToChannel(merged, 0);
  return buffer;
};

/**
 * 任意のソースノードからPCMを録るレコーダを作る。
 * マイク録音とループバックテスト（発振器入力）が同じこの経路を通る。
 */
export const createPcmRecorder = async (audioContext) => {
  await ensureCaptureWorklet(audioContext);
  const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture');
  // destination に繋がっていないノードは駆動されないため、無音ゲイン経由で接続する
  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;
  workletNode.connect(muteGain).connect(audioContext.destination);

  const chunks = [];
  workletNode.port.onmessage = (event) => chunks.push(event.data);

  return {
    node: workletNode,
    stop: async () => {
      workletNode.port.postMessage('stop');
      await new Promise((resolve) => setTimeout(resolve, CHUNK_FLUSH_WAIT_MS));
      workletNode.disconnect();
      muteGain.disconnect();
      return assembleAudioBuffer(audioContext, chunks, audioContext.sampleRate);
    },
  };
};

// ブラウザ標準の音声加工（会議用DSP）をすべて無効化して生の音を録る。
// AGCは音量エンベロープ（立ち上がり特徴量）を潰し、ノイズ抑制は唸り声の
// ノイズ成分（分類の主要特徴量）を除去してしまうため、解析には無加工が必須。
const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

/**
 * マイク録音を開始する。stop() で AudioBuffer（モノラル）を返し、
 * マイク（MediaStreamTrack）を必ず解放する。
 * monitorNode を渡すと入力を分岐して接続する（スペクトログラム表示用の AnalyserNode 等）。
 */
export const startMicRecording = async (audioContext, monitorNode = null) => {
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const recorder = await createPcmRecorder(audioContext);
  sourceNode.connect(recorder.node);
  if (monitorNode) sourceNode.connect(monitorNode);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return null;
      stopped = true;
      // 先にトラックを止めてマイク使用インジケータを確実に消す
      stream.getTracks().forEach((track) => track.stop());
      sourceNode.disconnect();
      return recorder.stop();
    },
  };
};

/** 音声ファイルをデコードして AudioBuffer を返す（サイズ上限ガード付き） */
export const decodeAudioFile = async (audioContext, file) => {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const error = new Error(
      `ファイルサイズが上限（20MB）を超えています: ${(file.size / 1024 / 1024).toFixed(1)}MB`,
    );
    error.code = 'FILE_TOO_LARGE';
    throw error;
  }
  const arrayBuffer = await file.arrayBuffer();
  return audioContext.decodeAudioData(arrayBuffer);
};

/** AudioBuffer をモノラルの Float32Array に落とす（解析関数への入力形式） */
export const toMono = (audioBuffer) => {
  if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
  const out = new Float32Array(audioBuffer.length);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch += 1) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < audioBuffer.length; i += 1) out[i] += data[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= audioBuffer.numberOfChannels;
  return out;
};
