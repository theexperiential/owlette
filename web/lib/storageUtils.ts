import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage';
import { storage } from './firebase';

/** Firebase Storage helpers for agent installer binaries. */

/** Uploads to both `versions/{version}/` and `latest/`; onProgress is 0-100. */
export async function uploadInstaller(
  file: File,
  version: string,
  onProgress?: (progress: number) => void
): Promise<{ downloadUrl: string; checksum: string; fileSize: number }> {
  if (!storage) {
    throw new Error('Firebase Storage is not configured');
  }

  if (!file.name.endsWith('.exe')) {
    throw new Error('Only .exe files are allowed');
  }

  const checksum = await calculateChecksum(file);

  const versionPath = `agent-installers/versions/${version}/Owlette-Installer-v${version}.exe`;
  const latestPath = `agent-installers/latest/Owlette-Installer.exe`;

  const versionRef = ref(storage, versionPath);
  const versionUploadTask = uploadBytesResumable(versionRef, file);

  const downloadUrl = await new Promise<string>((resolve, reject) => {
    versionUploadTask.on(
      'state_changed',
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        if (onProgress) {
          onProgress(Math.round(progress));
        }
      },
      (error) => {
        console.error('Upload error:', error);
        reject(new Error(`Upload failed: ${error.message}`));
      },
      async () => {
        try {
          const url = await getDownloadURL(versionUploadTask.snapshot.ref);
          resolve(url);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`Failed to get download URL: ${message}`));
        }
      }
    );
  });

  // Overwrites the previous latest.
  const latestRef = ref(storage, latestPath);
  const latestUploadTask = uploadBytesResumable(latestRef, file);

  await new Promise<void>((resolve, reject) => {
    latestUploadTask.on(
      'state_changed',
      () => {},
      (error) => reject(error),
      () => resolve()
    );
  });

  return {
    downloadUrl,
    checksum,
    fileSize: file.size,
  };
}

/** `version` may be a semver string or "latest". */
export async function getInstallerDownloadUrl(version: string): Promise<string> {
  if (!storage) {
    throw new Error('Firebase Storage is not configured');
  }

  const path =
    version === 'latest'
      ? 'agent-installers/latest/Owlette-Installer.exe'
      : `agent-installers/versions/${version}/Owlette-Installer-v${version}.exe`;

  const fileRef = ref(storage, path);

  try {
    return await getDownloadURL(fileRef);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get download URL: ${message}`);
  }
}

/** Refuses "latest" — delete a concrete version instead. */
export async function deleteInstallerVersion(version: string): Promise<void> {
  if (!storage) {
    throw new Error('Firebase Storage is not configured');
  }

  if (version === 'latest') {
    throw new Error('Cannot delete the latest version directly');
  }

  const path = `agent-installers/versions/${version}/Owlette-Installer-v${version}.exe`;
  const fileRef = ref(storage, path);

  try {
    await deleteObject(fileRef);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to delete installer: ${message}`);
  }
}

/** SHA-256 of the file, lowercase hex. */
export async function calculateChecksum(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/** Bytes → "95.8 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** Strict `major.minor.patch` — no prerelease or build metadata. */
export function isValidVersion(version: string): boolean {
  const semverRegex = /^\d+\.\d+\.\d+$/;
  return semverRegex.test(version);
}

/** Gigabytes in, "512.5 GB" or "1.2 TB" out (switches at 1000). */
export function formatStorage(gb: number): string {
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${tb.toFixed(1)} TB`;
  }
  return `${gb.toFixed(1)} GB`;
}

/** "512.5 / 1024.0 GB" — both values share the unit chosen from the total. */
export function formatStorageRange(usedGb: number, totalGb: number): string {
  if (totalGb >= 1000) {
    const usedTb = usedGb / 1000;
    const totalTb = totalGb / 1000;
    return `${usedTb.toFixed(1)} / ${totalTb.toFixed(1)} TB`;
  }
  return `${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB`;
}
