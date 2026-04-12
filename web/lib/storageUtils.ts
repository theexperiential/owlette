import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage';
import { storage } from './firebase';

/**
 * Storage Utilities for Firebase Storage
 *
 * Provides functions for uploading, downloading, and deleting files
 * from Firebase Storage, specifically for agent installer management.
 */

/**
 * Upload an installer file to Firebase Storage
 *
 * @param file - The file to upload
 * @param version - The version number (e.g., "2.0.0")
 * @param onProgress - Callback for upload progress (0-100)
 * @returns Promise with download URL and file metadata
 */
export async function uploadInstaller(
  file: File,
  version: string,
  onProgress?: (progress: number) => void
): Promise<{ downloadUrl: string; checksum: string; fileSize: number }> {
  if (!storage) {
    throw new Error('Firebase Storage is not configured');
  }

  // Validate file type
  if (!file.name.endsWith('.exe')) {
    throw new Error('Only .exe files are allowed');
  }

  // Calculate checksum before upload
  const checksum = await calculateChecksum(file);

  // Upload to both /versions/{version}/ and /latest/
  const versionPath = `agent-installers/versions/${version}/Owlette-Installer-v${version}.exe`;
  const latestPath = `agent-installers/latest/Owlette-Installer.exe`;

  // Upload to version-specific folder
  const versionRef = ref(storage, versionPath);
  const versionUploadTask = uploadBytesResumable(versionRef, file);

  // Track progress
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
        } catch (error: any) {
          reject(new Error(`Failed to get download URL: ${error.message}`));
        }
      }
    );
  });

  // Also upload to /latest/ (overwrites previous latest)
  const latestRef = ref(storage, latestPath);
  const latestUploadTask = uploadBytesResumable(latestRef, file);

  await new Promise<void>((resolve, reject) => {
    latestUploadTask.on(
      'state_changed',
      () => {}, // No progress tracking for latest copy
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

/**
 * Get download URL for a specific version
 *
 * @param version - The version number or "latest"
 * @returns Download URL
 */
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
  } catch (error: any) {
    throw new Error(`Failed to get download URL: ${error.message}`);
  }
}

/**
 * Delete an installer version from storage
 *
 * @param version - The version to delete (not "latest")
 */
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
  } catch (error: any) {
    throw new Error(`Failed to delete installer: ${error.message}`);
  }
}

/**
 * Calculate SHA256 checksum of a file
 *
 * @param file - The file to hash
 * @returns SHA256 checksum as hex string
 */
export async function calculateChecksum(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Format file size for display
 *
 * @param bytes - File size in bytes
 * @returns Formatted string (e.g., "95.8 MB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Validate version string format
 *
 * @param version - Version string to validate
 * @returns true if valid semver format (e.g., "2.0.0")
 */
export function isValidVersion(version: string): boolean {
  const semverRegex = /^\d+\.\d+\.\d+$/;
  return semverRegex.test(version);
}

/**
 * Format storage size with automatic unit selection (GB/TB)
 * Switches to TB when GB > 1000
 *
 * @param gb - Size in gigabytes
 * @returns Formatted string with appropriate unit (e.g., "512.5 GB" or "1.2 TB")
 */
export function formatStorage(gb: number): string {
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${tb.toFixed(1)} TB`;
  }
  return `${gb.toFixed(1)} GB`;
}

/**
 * Format storage range (used/total) with automatic unit selection
 * Both values use the same unit based on the total size
 *
 * @param usedGb - Used storage in gigabytes
 * @param totalGb - Total storage in gigabytes
 * @returns Formatted string (e.g., "512.5 / 1024.0 GB" or "1.2 / 2.5 TB")
 */
export function formatStorageRange(usedGb: number, totalGb: number): string {
  if (totalGb >= 1000) {
    const usedTb = usedGb / 1000;
    const totalTb = totalGb / 1000;
    return `${usedTb.toFixed(1)} / ${totalTb.toFixed(1)} TB`;
  }
  return `${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB`;
}
