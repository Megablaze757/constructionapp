/**
 * Whisper, in a Web Worker, on this device.
 *
 * The bottom rung of the transcription ladder — free, offline once the weights
 * are cached, and the only rung that works with no signal and no API key.
 * Measured on a mid-range CPU with no WebGPU adapter available: the model is
 * ready about 5s after download and transcribes roughly 3x faster than
 * real-time, so a 30-second voice note comes back in about ten seconds.
 *
 * It runs in a Worker because inference blocks whatever thread it is on, and an
 * owner holding a phone on a scaffold should not be looking at a frozen screen.
 *
 * Messages in:  {type:'load'} | {type:'transcribe', pcm: Float32Array}
 * Messages out: {type:'progress'|'ready'|'result'|'error', ...}
 */

const MODEL = 'onnx-community/whisper-tiny.en';
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

let pipe = null;
let loading = null;

/**
 * Whisper's own sample rate. The caller resamples to this before posting, so
 * the Worker never has to construct an AudioContext it cannot have.
 */
export const SAMPLE_RATE = 16000;

/**
 * Whether this device really has a usable GPU.
 *
 * Asked before trying, not after failing: a `device: 'webgpu'` attempt on a
 * machine without an adapter does not fall back cleanly — it leaves the ONNX
 * runtime reporting "no available backend found" on the next call, so the CPU
 * path is lost too. Checking first costs a millisecond and keeps the fallback.
 */
async function webGpuAvailable() {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

async function load() {
  const { pipeline } = await import(LIB);
  const gpu = await webGpuAvailable();
  if (!gpu) self.postMessage({ type: 'progress', note: 'No GPU here — running on the CPU.' });

  return pipeline('automatic-speech-recognition', MODEL, {
    ...(gpu ? { device: 'webgpu' } : {}),
    progress_callback: (p) => {
      if (p.status === 'progress' && typeof p.progress === 'number') {
        self.postMessage({ type: 'progress', file: p.file, progress: p.progress, total: p.total });
      }
    },
  });
}

function ready() {
  loading ??= load().then((p) => { pipe = p; return p; });
  return loading;
}

self.addEventListener('message', async (e) => {
  const { type } = e.data;
  try {
    if (type === 'load') {
      await ready();
      self.postMessage({ type: 'ready' });
      return;
    }

    if (type === 'transcribe') {
      const asr = await ready();
      const out = await asr(e.data.pcm, {
        // Whisper's own window is 30s; longer audio has to be chunked or it is
        // silently truncated, which would lose the end of a long voice note.
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      self.postMessage({ type: 'result', text: (out.text || '').trim() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err?.message || String(err) });
  }
});
