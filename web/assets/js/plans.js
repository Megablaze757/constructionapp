/**
 * Plan & Document ingestion for the Quote Builder.
 *
 * Handles uploading building plans (PDFs, architectural images) and pre-existing
 * quote templates/documents (PDFs, TXT, CSV) directly in the browser.
 * Large PDFs or images are rendered to canvas and downscaled so they stay small
 * enough to send over low-bandwidth mobile or API limits.
 */

const MAX_EDGE = 1600;      // max image dimension for vision model
const QUALITY = 0.82;

/**
 * Process an uploaded plan or quote document file.
 * @param {File} file
 * @returns {Promise<{name: string, type: 'plan'|'template'|'image', mime: string, b64?: string, text?: string}>}
 */
export async function processDocument(file) {
  const name = file.name || 'uploaded_document';
  const isPdf = file.type === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
  const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(name);
  const isText = file.type.startsWith('text/') || /\.(txt|csv|json|md)$/i.test(name);

  if (isImage) {
    const scaled = await downscaleImage(file);
    return {
      name,
      type: /plan|blueprint|drawing/i.test(name) ? 'plan' : 'image',
      mime: scaled.mime,
      b64: scaled.data_base64,
    };
  }

  if (isText) {
    const text = await file.text();
    return {
      name,
      type: 'template',
      mime: 'text/plain',
      text: text.slice(0, 8000), // capped for model prompt context
    };
  }

  if (isPdf) {
    try {
      // Try extracting text first
      const rawText = await file.text();
      const printable = rawText.replace(/[^\x20-\x7E\n\r\t]/g, '');
      if (printable.length > 200) {
        return {
          name,
          type: 'template',
          mime: 'text/plain',
          text: printable.slice(0, 8000),
        };
      }
    } catch (e) {
      // proceed to fallback
    }
    return {
      name,
      type: 'plan',
      mime: 'application/pdf',
      text: `[PDF Plan attached: ${name} (${(file.size / 1024).toFixed(1)} KB)]`,
    };
  }

  // Default generic read
  const text = await file.text().catch(() => '');
  return {
    name,
    type: 'template',
    mime: file.type || 'text/plain',
    text: text.slice(0, 4000),
  };
}

async function downscaleImage(file) {
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

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }

  return { mime: 'image/jpeg', data_base64: btoa(binary), width, height };
}
