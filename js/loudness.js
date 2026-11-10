// 音量解析（ITU-R BS.1770-4 / EBU R128 の統合ラウドネス）
// exe 版は ffmpeg の loudnorm で測っていた。Web 版はブラウザでデコードした PCM から同じ方式で計算する。

// K 特性フィルタ（2段の双2次フィルタ）の係数。libebur128 と同じ式で任意のサンプルレートに対応する。
export function kWeightingCoeffs(fs) {
  // 1段目: ハイシェルフ（頭部の影響を模擬）
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // 2段目: ハイパス（RLB）
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, highpass];
}

// チャンネルの重み。5.1ch（L R C LFE Ls Rs）は LFE を除外し、サラウンドを 1.41 倍にする。
function channelWeights(n) {
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return new Array(n).fill(1);
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/**
 * AudioBuffer の統合ラウドネス（LUFS）とサンプルピーク（dBFS）を返す。
 * 長いファイルでも画面が固まらないよう、数秒ごとに処理を譲る。
 */
export async function measureLoudness(audioBuffer, isCancelled = () => false) {
  const fs = audioBuffer.sampleRate;
  const nch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const weights = channelWeights(nch);
  const [s1, s2] = kWeightingCoeffs(fs);

  // 100ms ごとの二乗和を記録し、あとで 400ms（4区間）のブロックにまとめる（75% 重なり）
  const step = Math.round(fs * 0.1);
  const nSteps = Math.floor(len / step);
  const stepEnergy = new Float64Array(nSteps); // チャンネル重み込みの二乗和
  let peak = 0;

  const chunk = step * 50; // 5秒ごとに UI へ処理を譲る
  for (let c = 0; c < nch; c++) {
    const w = weights[c];
    const x = audioBuffer.getChannelData(c);
    // フィルタの状態（直接形 I）
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // 1段目
    let z1 = 0, z2 = 0;                 // 2段目の出力履歴
    let acc = 0;
    let si = 0;
    let inStep = 0;
    for (let start = 0; start < nSteps * step; start += chunk) {
      const end = Math.min(start + chunk, nSteps * step);
      for (let i = start; i < end; i++) {
        const v = x[i];
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
        const y = s1.b0 * v + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
        x2 = x1; x1 = v;
        // 2段目は入力が1段目の出力 y。b = (1, -2, 1)
        const z = y - 2 * y1 + y2 - s2.a1 * z1 - s2.a2 * z2;
        y2 = y1; y1 = y;
        z2 = z1; z1 = z;
        acc += z * z;
        if (++inStep === step) {
          stepEnergy[si++] += w * acc;
          acc = 0;
          inStep = 0;
        }
      }
      if (isCancelled()) throw new Error("中止しました");
      await yieldToUi();
    }
    // 最後の 100ms に満たない端数はブロックに使わない（規格どおり）
    for (let i = nSteps * step; i < len; i++) {
      const av = Math.abs(x[i]);
      if (av > peak) peak = av;
    }
  }

  // 400ms ブロックの平均パワー
  const blockLen = step * 4;
  const nBlocks = Math.max(0, nSteps - 3);
  const blocks = new Float64Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    blocks[b] = (stepEnergy[b] + stepEnergy[b + 1] + stepEnergy[b + 2] + stepEnergy[b + 3]) / blockLen;
  }
  const toLufs = (p) => -0.691 + 10 * Math.log10(p);

  // 絶対ゲート（-70 LUFS）
  let sum = 0, n = 0;
  for (const p of blocks) {
    if (p > 0 && toLufs(p) > -70) { sum += p; n++; }
  }
  let integrated = -Infinity;
  if (n > 0) {
    // 相対ゲート（絶対ゲート通過分の平均 -10 LU）
    const rel = toLufs(sum / n) - 10;
    let sum2 = 0, n2 = 0;
    for (const p of blocks) {
      if (p > 0 && toLufs(p) > -70 && toLufs(p) > rel) { sum2 += p; n2++; }
    }
    if (n2 > 0) integrated = toLufs(sum2 / n2);
  }

  return {
    lufs: integrated,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    duration: len / fs,
    sampleRate: fs,
    channels: nch,
  };
}
