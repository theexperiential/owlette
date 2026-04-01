/**
 * Chat image utilities — client-side compression and Firebase Storage upload.
 */

import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { storage } from '@/lib/firebase';

/**
 * Compress an image blob using canvas.
 * Resizes to fit within maxDimension on the longest edge, outputs JPEG at 0.85 quality.
 * Returns the original blob if it's already small enough.
 */
export async function compressImage(
  blob: Blob,
  maxDimension: number = 1536,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const { width, height } = img;

      // Skip compression if already within bounds and reasonably sized (<500KB)
      if (width <= maxDimension && height <= maxDimension && blob.size < 500_000) {
        resolve(blob);
        return;
      }

      // Calculate scaled dimensions
      const scale = Math.min(maxDimension / width, maxDimension / height, 1);
      const newWidth = Math.round(width * scale);
      const newHeight = Math.round(height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = newWidth;
      canvas.height = newHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(blob); // Fallback: return original
        return;
      }

      ctx.drawImage(img, 0, 0, newWidth, newHeight);

      canvas.toBlob(
        (result) => {
          if (result) {
            resolve(result);
          } else {
            resolve(blob); // Fallback: return original
          }
        },
        'image/jpeg',
        0.85,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for compression'));
    };

    img.src = url;
  });
}

/**
 * Upload a chat image to Firebase Storage.
 * Path: chat-images/{userId}/{chatId}/{timestamp}.jpg
 *
 * Returns the download URL and media type.
 */
export async function uploadChatImage(
  userId: string,
  chatId: string,
  blob: Blob,
): Promise<{ url: string; mediaType: string }> {
  if (!storage) {
    throw new Error('Firebase Storage not initialized');
  }

  const compressed = await compressImage(blob);
  const filename = `${Date.now()}.jpg`;
  const storagePath = `chat-images/${userId}/${chatId}/${filename}`;
  const storageRef = ref(storage, storagePath);

  const snapshot = await uploadBytesResumable(storageRef, compressed, {
    contentType: 'image/jpeg',
  });

  const url = await getDownloadURL(snapshot.ref);

  return { url, mediaType: 'image/jpeg' };
}
