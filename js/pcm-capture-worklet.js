// PCMキャプチャ用 AudioWorkletProcessor（オーディオスレッドで動作する）。
// 入力の第1チャンネルを128サンプルずつメインスレッドへ送る。

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // process() 間で内部バッファが再利用されるため、コピーを送る必要がある
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
