/**
 * Reading what the owner attaches: building plans, and their own quote
 * documents.
 *
 * The previous version of this file did not work on PDFs, which is the format
 * both of those actually arrive in. It called `file.text()` on them — which
 * returns the raw bytes as a string — stripped that to printable ASCII, and,
 * because any real PDF leaves well over 200 characters of operators and
 * compressed-stream residue behind, handed the result to the model as though it
 * were the text of the quote. A PDF that was a drawing rather than text became
 * the literal string "[PDF Plan attached: name (123 KB)]", so the model never
 * saw the plan at all.
 *
 * PDFs are now read with PDF.js, which does the two things that are actually
 * needed:
 *
 *   - `getTextContent()` for a typed document — a quote, a spec, a schedule of
 *     works. Real words, in reading order.
 *   - `render()` to a canvas for a drawing. Elevations and sections are
 *     geometry, not prose, so they go to the vision model as images.
 *
 * Most real plans need both: a title block and dimension strings that are text,
 * over a drawing that is not. So both are extracted and both are sent.
 */

/** Max edge for anything going to a vision model. Matches the photo pipeline. */
const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** Plans are read at a higher scale than they display: dimension text is small. */
const PDF_RENDER_SCALE = 2;

/** Enough pages to cover a plan set or a quote, without sending a whole folder. */
const MAX_PDF_PAGES = 4;

/** Model context is finite, and a quote's words are at the front of it. */
const MAX_TEXT = 8000;

const PDF_LIB = new URL('../vendor/pdf.min.mjs', import.meta.url);
const PDF_WORKER = new URL('../vendor/pdf.worker.min.mjs', import.meta.url);

let pdfjs = null;

async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import(PDF_LIB);
    // Parsing a large plan set blocks whatever thread it is on, so PDF.js gets
    // its own. Vendored rather than fetched, so an attachment can be read on a
    // site with no signal.
    pdfjs.GlobalWorkerOptions.workerSrc = String(PDF_WORKER);
  }
  return pdfjs;
}

/**
 * What an attachment is for, decided by what it contains rather than what it is
 * called. The old version sniffed filenames for /plan|blueprint|drawing/, which
 * made "scan001.pdf" a quote and "my-plan-prices.pdf" a drawing.
 */
function classify({ text, pages }) {
  const words = (text || '').trim();
  // A quote or spec is mostly prose and numbers in sentences. A drawing's text
  // layer, if it has one, is short strings: room names, dimensions, a title
  // block. The ratio of words to pages separates them more reliably than any
  // keyword.
  const density = words.length / Math.max(1, pages);
  return density > 400 ? 'document' : 'plan';
}

/**
 * Read an attachment.
 *
 * @param {File} file
 * @returns {Promise<{name, kind, mime, text, images, pages, note}>}
 *   `kind` is 'document' (their own quote, a spec) or 'plan' (a drawing).
 *   `images` are base64 JPEGs for the vision model; `text` is real extracted
 *   text, or '' — never binary residue dressed up as text.
 */
export async function processDocument(file) {
  const name = file.name || 'attachment';
  const lower = name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || lower.endsWith('.pdf');
  const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(lower);
  const isText = file.type.startsWith('text/') || /\.(txt|csv|md|json)$/i.test(lower);

  if (isPdf) return readPdf(file, name);

  if (isImage) {
    const img = await downscaleImage(file);
    return {
      name, kind: 'plan', mime: img.mime, text: '', pages: 1,
      images: [{ mime: img.mime, b64: img.b64 }],
      note: `${img.width}×${img.height}`,
    };
  }

  if (isText) {
    const text = (await file.text()).slice(0, MAX_TEXT);
    return { name, kind: 'document', mime: 'text/plain', text, images: [], pages: 1, note: `${text.length} characters` };
  }

  throw new Error(`Cannot read ${name}. Attach a PDF, a photo, or a text file.`);
}

async function readPdf(file, name) {
  const lib = await loadPdfJs();
  // The loading task owns the worker's resources, so that is what gets torn
  // down — the document proxy itself has no destroy().
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pageCount = doc.numPages;
  const take = Math.min(pageCount, MAX_PDF_PAGES);

  const parts = [];
  for (let i = 1; i <= take; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // `items` carry their own positions; joining on whitespace keeps reading
    // order without pretending to reconstruct layout.
    const text = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    parts.push({ page, text });
  }

  const text = parts.map((p) => p.text).filter(Boolean).join('\n\n').slice(0, MAX_TEXT);
  const kind = classify({ text, pages: take });

  // A drawing has to be seen. A typed document does not — its words are the
  // content, and rendering it as well would spend vision tokens on a picture of
  // text we already have.
  const images = [];
  if (kind === 'plan') {
    for (const { page } of parts) {
      images.push(await renderPage(page));
    }
  }

  await task.destroy();
  return {
    name,
    kind,
    mime: 'application/pdf',
    text,
    images,
    pages: pageCount,
    note: pageCount > take
      ? `${take} of ${pageCount} pages read`
      : `${pageCount} page${pageCount === 1 ? '' : 's'}`,
  };
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(PDF_RENDER_SCALE, MAX_EDGE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  // Plans are line drawings on nothing. Without a white ground they render as
  // dark lines on transparent, which flattens to black when encoded as JPEG.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

  return { mime: 'image/jpeg', b64: await canvasToBase64(canvas) };
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

  return { mime: 'image/jpeg', b64: await canvasToBase64(canvas), width, height };
}

async function canvasToBase64(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not process that image.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
