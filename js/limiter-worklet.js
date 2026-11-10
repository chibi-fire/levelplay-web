// ピーク抑制用のソフトリミッター（AudioWorklet）
// exe 版の LimiterSampleProvider と同じ役割。補正ゲインで大きくした音が -1 dB を超えないようにする。
// 5ms 先読みしてゲインを先に下げるので、急な音でも歪みにくい。

const CEILING_DB = -1;
const LOOKAHEAD_SEC = 0.005;
const RELEASE_SEC = 0.1;

class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ceiling = Math.pow(10, CEILING_DB / 20);
    this.n = Math.max(1, Math.round(sampleRate * LOOKAHEAD_SEC));
    // 遅延バッファ（チャンネル数は入力に合わせて作る）
    this.delay = [];
    this.wpos = 0;
    // 先読み区間の「必要ゲイン」の最小値を求めるための単調キュー
    const cap = this.n + 2;
    this.qIdx = new Float64Array(cap);
    this.qVal = new Float32Array(cap);
    this.qHead = 0;
    this.qTail = 0;
    this.qCap = cap;
    this.t = 0;
    this.gain = 1;
    // 先読み区間内に目標へほぼ到達する速さ（残差 e^-5）
    this.attack = 1 - Math.exp(-5 / this.n);
    this.release = 1 - Math.exp(-1 / (sampleRate * RELEASE_SEC));
    this.reduction = 0;
    this.port.onmessage = () => {};
  }

  ensureChannels(n) {
    while (this.delay.length < n) this.delay.push(new Float32Array(this.n + 1));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }
    const nch = Math.min(input.length, output.length);
    this.ensureChannels(nch);
    const frames = input[0].length;
    const dlen = this.n + 1;
    const ceil = this.ceiling;

    for (let i = 0; i < frames; i++) {
      // この瞬間の全チャンネルのピーク
      let pk = 0;
      for (let c = 0; c < nch; c++) {
        const v = input[c][i];
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
      }
      const need = pk > ceil ? ceil / pk : 1;
      const t = this.t++;

      // 単調キューに追加（後ろから、より大きい値を捨てる）
      while (this.qTail !== this.qHead) {
        const back = (this.qTail - 1 + this.qCap) % this.qCap;
        if (this.qVal[back] >= need) this.qTail = back;
        else break;
      }
      this.qIdx[this.qTail] = t;
      this.qVal[this.qTail] = need;
      this.qTail = (this.qTail + 1) % this.qCap;
      // 区間（t-n .. t）から外れたものを前から捨てる
      while (this.qIdx[this.qHead] < t - this.n) this.qHead = (this.qHead + 1) % this.qCap;
      const target = this.qVal[this.qHead];

      const g = this.gain;
      this.gain = g + (target - g) * (target < g ? this.attack : this.release);

      // n サンプル前の音に今のゲインを掛けて出す
      const rpos = (this.wpos + 1) % dlen;
      for (let c = 0; c < nch; c++) {
        const buf = this.delay[c];
        buf[this.wpos] = input[c][i];
        let out = buf[rpos] * this.gain;
        // 取りこぼし対策の最終クリップ
        if (out > ceil) out = ceil;
        else if (out < -ceil) out = -ceil;
        output[c][i] = out;
      }
      this.wpos = rpos;
    }
    for (let c = nch; c < output.length; c++) output[c].set(output[0]);
    return true;
  }
}

registerProcessor("levelplay-limiter", LimiterProcessor);
