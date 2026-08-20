/**
 * Client-side image utilities for avatar uploads.
 * No external dependencies — uses browser canvas APIs.
 */

export interface ProcessedImage {
  blob: Blob;
  dataUrl: string;
}

/**
 * Center-crop to a square and resize to `edge`, returning a JPEG blob + data
 * URL for preview and upload. Center-crop rather than a cropper UI: it gives a
 * predictable square from any aspect ratio with no extra dependency.
 */
export async function cropAndResizeSquare(
  file: File,
  edge = 256,
  quality = 0.9
): Promise<ProcessedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Selected file is not an image.');
  }

  const sourceUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(sourceUrl);

    const sourceSize = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - sourceSize) / 2;
    const sy = (img.naturalHeight - sourceSize) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable.');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sourceSize, sourceSize, 0, 0, edge, edge);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    );
    if (!blob) {
      throw new Error('Failed to encode image.');
    }

    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return { blob, dataUrl };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image.'));
    img.src = src;
  });
}
