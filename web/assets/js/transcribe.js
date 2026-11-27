/**
 * Turning a voice note into text, by whichever rung is available.
 *
 *   1. Groq Whisper, through the AI worker. Best accuracy by a clear margin,
 *      about 0.05p a minute, and needs signal plus a configured worker.
 *   2. Whisper on this device, via assets/js/local/whisper-worker.js. Free,
 *      works with no signal and no key, ~3x real-time on CPU. One ~41MB model
 *      download, cached by the browser, then offline forever.
 *
 * This replaces the Web Speech API, which never worked in Firefox and which
 * nobody could run offline.
 *
 * What neither rung does is decide anything. The transcript lands in the
 * description box for the owner to read and correct before drafting, because a
 * misheard "ten lifts" for "two lifts" would otherwise flow into the quantities
 * and out to a client. Transcription drafts; it does not estimate.
 */

const WORKER_URL = new URL('./local/whisper-worker.js', import.meta.url);

/** Whisper's sample rate. Everything is resampled to this before transcription. */
const SAMPLE_RATE = 16000;

/** Beyond this a voice note is almost certainly a pocket recording. */
const MAX_SECONDS = 300;

let worker = null;
let warmed = false;

/* ------------------------------------------------------------------- audio */

/**
 * Decode a recording to the mono 16kHz float samples Whisper expects.
 *
 * Done here rather than in the Worker because decoding needs an AudioContext,
 * which a Worker has no access to.
 */
async function toPcm(blob) {
  const bytes = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    if (decoded.duration > MAX_SECONDS) {
      throw new Error(`That recording is ${Math.round(decoded.duration)}s long. Keep it under ${MAX_SECONDS / 60} minutes.`);
    }
    // Mix to mono: a phone mic is effectively mono anyway, and Whisper only
    // reads the first channel, so averaging loses nothing and avoids surprises.
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    const mono = channels.length === 1 ? channels[0] : channels[0].map((_, i) =>
      channels.reduce((sum, ch) => sum + ch[i], 0) / channels.length);

    if (decoded.sampleRate === SAMPLE_RATE) return mono;

    // Linear resample. Whisper is not sensitive enough to the interpolation for
    // anything cleverer to be worth the code.
    const ratio = decoded.sampleRate / SAMPLE_RATE;
    const out = new Float32Array(Math.floor(mono.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const at = i * ratio;
      const lo = Math.floor(at);
      const hi = Math.min(lo + 1, mono.length - 1);
      out[i] = mono[lo] + (mono[hi] - mono[lo]) * (at - lo);
    }
    return out;
  } finally {
    ctx.close();
  }
}

/* ------------------------------------------------------- rung 1: the worker */

async function viaAiWorker(blob, aiBase, token) {
  const form = new FormData();
  form.append('audio', blob, `note.${(blob.type.split('/')[1] || 'webm').split(';')[0]}`);

  const res = await fetch(`${aiBase}/transcribe`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) {
    throw new Error(payload?.error || `AI worker returned ${res.status}`);
  }
  return { text: (payload.text || '').trim(), via: 'groq', model: payload.model };
}

/* ------------------------------------------------- rung 2: this device */

function onDevice(pcm, onProgress) {
  worker ??= new Worker(WORKER_URL, { type: 'module' });
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => { worker.removeEventListener('message', handler); fn(arg); };
    const handler = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m);
      else if (m.type === 'result') { warmed = true; done(resolve, { text: m.text, via: 'on-device', model: 'whisper-tiny.en' }); }
      else if (m.type === 'error') done(reject, new Error(m.error));
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'transcribe', pcm }, [pcm.buffer]);
  });
}

/** True once the model is in memory, so the UI can stop warning about the wait. */
export const modelWarmed = () => warmed;

/** Start fetching the model now, so the first voice note is not also a download. */
export function warmUp() {
  if (warmed) return;
  worker ??= new Worker(WORKER_URL, { type: 'module' });
  worker.postMessage({ type: 'load' });
}

/**
 * Transcribe a recording.
 *
 * @param {Blob} blob recorded audio
 * @param {{aiBase?: string, aiToken?: string, onProgress?: Function, onStage?: Function}} opts
 * @returns {Promise<{text: string, via: 'groq'|'on-device', model: string}>}
 */
export async function transcribe(blob, { aiBase = '', aiToken = '', onProgress, onStage } = {}) {
  const problems = [];

  if (aiBase) {
    try {
      onStage?.('groq');
      return await viaAiWorker(blob, aiBase.replace(/\/$/, ''), aiToken);
    } catch (err) {
      // Not fatal: there is a rung below this one. The reason is kept so the
      // owner can be told why the better transcriber was not the one used.
      problems.push(`AI worker: ${err.message}`);
    }
  }

  try {
    onStage?.('on-device');
    const pcm = await toPcm(blob);
    const out = await onDevice(pcm, onProgress);
    return { ...out, fellBackFrom: problems[0] || null };
  } catch (err) {
    problems.push(`on-device: ${err.message}`);
    throw new Error(`Could not transcribe that. ${problems.join('. ')}.`);
  }
}
