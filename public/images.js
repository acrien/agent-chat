/**
 * images.js — pasted images, normalised and kept in a numbered tray.
 *
 * The tray's order is the send order, independent of where an image was pasted
 * in the typing: "image 2" means the same thing here, in the request, and to
 * the model.
 */
import { add, el, els, notice } from './dom.js';

/** Long edge of the current high-resolution vision tier. */
const MAX_EDGE = 2576;
const MAX_BYTES = 3_500_000;
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 10;

let pending = [];                  // the numbered tray, in send order

export function pendingImages() { return pending; }
export function clearPending() { pending = []; drawTray(); }

// --- images: normalize ------------------------------------------------------

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Bring an arbitrary pasted blob into something the API accepts.
 *
 * Two independent reasons to re-encode: the type may not be one of the four
 * the API takes, or the image may be larger than the model can use — anything
 * past the vision tier's long edge is downscaled server-side anyway, so
 * sending it whole just costs upload time and tokens.
 */
export async function normalize(blob) {
  const oversize = blob.size > MAX_BYTES;
  if (SENDABLE.has(blob.type) && !oversize) {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE) {
      bitmap.close?.();
      return { mediaType: blob.type, data: await toBase64(blob) };
    }
    bitmap?.close?.();
  }

  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // PNG keeps screenshot text crisp; photos would balloon, so fall back.
  let out = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!out || out.size > MAX_BYTES) {
    out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  }
  return { mediaType: out.type, data: await toBase64(out) };
}

// --- images: the numbered tray ---------------------------------------------

let dragFrom = null;

export function drawTray() {
  els.tray.hidden = pending.length === 0;
  els.trayItems.textContent = '';

  pending.forEach((img, index) => {
    const chip = el('div', 'chip');
    chip.draggable = true;

    const thumb = el('img');
    thumb.src = `data:${img.mediaType};base64,${img.data}`;
    thumb.alt = `image ${index + 1}`;
    chip.append(thumb);
    chip.append(el('span', 'num', String(index + 1)));

    const remove = el('button', 'x', '×');
    remove.title = 'remove';
    remove.addEventListener('click', () => {
      pending.splice(index, 1);
      drawTray();
    });
    chip.append(remove);

    chip.addEventListener('dragstart', (e) => {
      dragFrom = index;
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without payload.
      e.dataTransfer.setData('text/plain', String(index));
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => {
      dragFrom = null;
      chip.classList.remove('dragging');
    });
    chip.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      chip.classList.add('over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('over'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();          // do not let the composer treat this as a file drop
      chip.classList.remove('over');
      if (dragFrom === null || dragFrom === index) return;
      const [moved] = pending.splice(dragFrom, 1);
      pending.splice(index, 0, moved);
      drawTray();                   // renumbering falls out of redrawing from the array
    });

    els.trayItems.append(chip);
  });
}

export async function addImages(blobs) {
  for (const blob of blobs) {
    if (pending.length >= MAX_IMAGES) {
      notice(`at most ${MAX_IMAGES} images per message`, true);
      break;
    }
    try {
      pending.push(await normalize(blob));
      drawTray();
    } catch (err) {
      notice(`could not read that image: ${err.message}`, true);
    }
  }
}


