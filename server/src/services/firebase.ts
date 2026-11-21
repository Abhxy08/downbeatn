import { initializeApp, getApps, App } from 'firebase-admin/app';
import { getAuth as getAdminAuth, Auth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage, Storage } from 'firebase-admin/storage';
import { config } from '../config';
import fs from 'fs';

let appInstance: App | null = null;

export function isFirebaseAdminConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIRESTORE_EMULATOR_HOST ||
    (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) ||
    process.env.K_SERVICE // Google Cloud Run
  );
}

export function initFirebase(): App {
  if (appInstance) return appInstance;

  try {
    const apps = getApps();
    if (apps.length > 0) {
      appInstance = apps[0];
      return appInstance;
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }

    appInstance = initializeApp({
      projectId: config.firebase.projectId,
      storageBucket: config.firebase.storageBucket,
    });

    console.log(`[Firebase] Initialized Admin SDK for project: ${config.firebase.projectId}`);
  } catch (err) {
    const apps = getApps();
    if (apps.length === 0) {
      appInstance = initializeApp({
        projectId: config.firebase.projectId,
      });
    } else {
      appInstance = apps[0];
    }
  }

  return appInstance;
}

// In-Memory Firestore Fallback for offline local dev mode
class MemoryFirestore {
  private collections = new Map<string, Map<string, any>>();

  collection(colName: string) {
    if (!this.collections.has(colName)) {
      this.collections.set(colName, new Map());
    }
    const col = this.collections.get(colName)!;

    return {
      doc: (docId: string) => ({
        set: async (data: any) => {
          col.set(docId, { ...data });
          return { writeTime: Date.now() };
        },
        get: async () => {
          const data = col.get(docId);
          return {
            exists: Boolean(data),
            data: () => data,
          };
        },
        update: async (data: any) => {
          const existing = col.get(docId) || {};
          col.set(docId, { ...existing, ...data });
          return { writeTime: Date.now() };
        },
        collection: (subCol: string) => this.collection(`${colName}/${docId}/${subCol}`),
      }),
      where: (field: string, op: string, value: any) => ({
        limit: (n: number) => ({
          get: async () => {
            const matches: any[] = [];
            for (const [id, item] of col.entries()) {
              if (item && item[field] === value) {
                matches.push({
                  id,
                  exists: true,
                  data: () => item,
                });
                if (matches.length >= n) break;
              }
            }
            return {
              empty: matches.length === 0,
              docs: matches,
            };
          },
        }),
      }),
    };
  }
}

const memoryDb = new MemoryFirestore();

export function getAuth(): Auth {
  return getAdminAuth(initFirebase());
}

export function getFirestore(): Firestore {
  if (!isFirebaseAdminConfigured()) {
    return memoryDb as unknown as Firestore;
  }
  return getAdminFirestore(initFirebase());
}

export function getStorage(): Storage {
  return getAdminStorage(initFirebase());
}
