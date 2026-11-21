import { getStorage, isFirebaseAdminConfigured } from './firebase';

/**
 * Best-effort upload to Cloud Storage for Firebase. Returns the object path, or null
 * when storage isn't configured (local dev) or the upload failed — callers keep working.
 */
export async function saveObject(path: string, data: Buffer, contentType: string): Promise<string | null> {
  if (!isFirebaseAdminConfigured()) return null;
  try {
    await getStorage().bucket().file(path).save(data, { contentType, resumable: false });
    return path;
  } catch (e: any) {
    console.warn(`[Storage] upload of ${path} failed: ${e.message}`);
    return null;
  }
}
