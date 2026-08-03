/**
 * Site photo upload for the Quote Builder.
 *
 * Photos are downscaled and re-encoded in the browser before they leave the
 * phone. A modern handset shoots 4-8MB per frame; on a site with one bar of
 * signal that upload simply does not finish, and it would not fit the API's
 * size cap either. Resizing here turns it into a ~150KB request.
 */

import { api, esc } from './api.js';

const MAX_EDGE = 1600;      // plenty for a quote page, small enough to send
const QUALITY = 0.82;       // JPEG quality; visually clean, roughly 1/20th the bytes

/**
 * @returns {Promise<{mime: string, data_base64: string, width: number, height: number}>}
 */
export async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not process that image.');

  // Chunked so a large photo cannot blow the argument limit of String.fromCharCode.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }

  return { mime: 'image/jpeg', data_base64: btoa(binary), width, height };
}

/** Wire the photo card up to a quote. */
export function initPhotos({ quoteId, onError, onBusy }) {
  const grid = document.getElementById('photo-grid');
  const input = document.getElementById('photo-input');
  const button = document.getElementById('photo-btn');
  if (!grid || !input || !button) return { refresh: () => {} };

  let objectUrls = [];

  async function refresh() {
    try {
      const { photos } = await api.photos(quoteId);
      await render(photos);
    } catch (err) {
      onError?.(err);
    }
  }

  async function render(photos) {
    // Release the previous batch; object URLs live until revoked.
    objectUrls.forEach(URL.revokeObjectURL);
    objectUrls = [];

    if (!photos.length) {
      grid.innerHTML = '<p class="muted" style="margin:0">No photos yet.</p>';
      return;
    }

    const withUrls = await Promise.all(photos.map(async (p) => {
      try {
        const url = await api.photoObjectUrl(quoteId, p.id);
        objectUrls.push(url);
        return { ...p, url };
      } catch {
        return { ...p, url: null };
      }
    }));

    grid.innerHTML = `<div class="photo-grid">${withUrls.map((p) => `
      <figure class="photo-thumb">
        ${p.url
          ? `<img src="${p.url}" alt="${esc(p.caption || 'Site photo')}">`
          : '<div class="muted">Could not load</div>'}
        <button class="btn btn-sm btn-danger" data-remove="${esc(p.id)}" type="button">Remove</button>
      </figure>`).join('')}</div>`;

    grid.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api.deletePhoto(quoteId, b.dataset.remove);
          refresh();
        } catch (err) { onError?.(err); }
      }));
  }

  button.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';                       // let the same file be picked again
    if (!files.length) return;

    onBusy?.(true);
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Uploading…';
    try {
      // Sequential, not parallel: site connections are thin, and a failure part
      // way through leaves the earlier photos safely uploaded.
      for (const file of files) {
        const photo = await downscale(file);
        await api.addPhoto(quoteId, photo);
      }
      await refresh();
    } catch (err) {
      onError?.(err);
    } finally {
      onBusy?.(false);
      button.disabled = false;
      button.textContent = '📷 Add site photo';
    }
  });

  refresh();
  return { refresh };
}
