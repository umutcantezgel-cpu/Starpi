// @ts-check
// One camera picture for a Live conversation, taken only when the user presses the button (and
// only when Settings -> Voice allows the camera). The camera opens, one frame is drawn into a
// canvas at most MAX_SIDE pixels on its long side, encoded as JPEG, and the camera closes again at
// once. The picture goes to the conversation and is not kept. The page's Permissions-Policy allows
// the camera for this origin only.

/** Long side of the picture in pixels. */
export const MAX_SIDE = 768;
const QUALITY = 0.72;

/** A camera picture could not be taken; `code` names why (dictionary live.camera.<code>). */
export class CameraError extends Error {
  /** @param {'unsupported' | 'denied' | 'no_camera' | 'busy' | 'failed'} code */
  constructor(code) {
    super(code);
    this.name = 'CameraError';
    this.code = code;
  }
}

/**
 * The size a picture is scaled to (never up).
 * @param {number} width
 * @param {number} height
 * @param {number} [maxSide]
 */
export function scaledSize(width, height, maxSide = MAX_SIDE) {
  const long = Math.max(width, height);
  if (!(long > 0)) return { width: 0, height: 0 };
  const factor = Math.min(1, maxSide / long);
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}

/**
 * @param {unknown} err
 */
function codeOf(err) {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  if (name === 'NotReadableError') return 'busy';
  return 'failed';
}

/**
 * Takes one picture.
 * @param {{ mediaDevices?: Pick<MediaDevices, 'getUserMedia'> | null, doc?: Document }} [deps]
 * @returns {Promise<{ mime: 'image/jpeg', data: string }>}
 */
export async function captureStill(deps = {}) {
  const media = deps.mediaDevices === undefined ? (globalThis.navigator?.mediaDevices ?? null) : deps.mediaDevices;
  const doc = deps.doc ?? document;
  if (!media?.getUserMedia) throw new CameraError('unsupported');
  let stream;
  try {
    stream = await media.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
  } catch (err) {
    throw new CameraError(codeOf(err));
  }
  try {
    const video = doc.createElement('video');
    video.muted = true;
    video.playsInline = true;
    // A MediaStream is no URL load, so the CSP's media-src 'none' does not apply to it.
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
    const size = scaledSize(video.videoWidth, video.videoHeight);
    const canvas = doc.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext('2d');
    if (!g || !size.width) throw new CameraError('failed');
    g.drawImage(video, 0, 0, size.width, size.height);
    video.srcObject = null;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!(blob instanceof Blob)) throw new CameraError('failed');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { mime: 'image/jpeg', data: btoa(binary) };
  } catch (err) {
    throw err instanceof CameraError ? err : new CameraError('failed');
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
