import crypto from 'crypto';
import { getFirestore, isFirebaseAdminConfigured } from './firebase';

/**
 * Paired plugin instances ("devices"). Each pairing creates one; its refresh credential is
 * stored only as a SHA-256 hash in Firestore (users/{uid}/devices/{deviceId}). Revoking a
 * device makes its refresh token and session tokens stop working immediately.
 */
export interface DeviceRecord {
  deviceId: string;
  uid: string;
  tokenHash: string;
  label: string;
  pairedAt: number;
  lastUsedAt: number;
  revokedAt?: number;
}

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

type RevokeListener = (uid: string, deviceId: string) => void;

class DeviceStore {
  private cache = new Map<string, { record: DeviceRecord | null; at: number }>();
  private listeners: RevokeListener[] = [];
  private static TTL_MS = 30_000;

  private key(uid: string, id: string) {
    return `${uid}/${id}`;
  }

  private doc(uid: string, id: string) {
    return getFirestore().collection('users').doc(uid).collection('devices').doc(id);
  }

  onRevoked(listener: RevokeListener) {
    this.listeners.push(listener);
  }

  async register(uid: string, deviceId: string, refreshToken: string, label: string): Promise<DeviceRecord> {
    const record: DeviceRecord = { deviceId, uid, tokenHash: hashToken(refreshToken), label, pairedAt: Date.now(), lastUsedAt: Date.now() };
    this.cache.set(this.key(uid, deviceId), { record, at: Date.now() });
    try {
      await this.doc(uid, deviceId).set(record);
    } catch (e: any) {
      console.warn(`[Devices] Firestore save skipped: ${e.message}`);
    }
    return record;
  }

  async get(uid: string, deviceId: string, fresh = false): Promise<DeviceRecord | null> {
    const k = this.key(uid, deviceId);
    const hit = this.cache.get(k);
    if (hit && !fresh && Date.now() - hit.at < DeviceStore.TTL_MS) return hit.record;
    try {
      const snap = await this.doc(uid, deviceId).get();
      const record = snap.exists ? (snap.data() as DeviceRecord) : null;
      // Keep a locally known record if storage doesn't have it (in-memory dev mode)
      const merged = record ?? hit?.record ?? null;
      this.cache.set(k, { record: merged, at: Date.now() });
      return merged;
    } catch {
      return hit?.record ?? null;
    }
  }

  /**
   * True if the device may be used. Unknown devices are rejected when Firestore is configured;
   * in local in-memory mode (records vanish on restart) unknown devices are allowed, but a
   * device revoked during this process is always rejected.
   */
  async isActive(uid: string, deviceId: string | undefined, refreshToken?: string): Promise<boolean> {
    if (!deviceId) return !isFirebaseAdminConfigured(); // legacy token without device id
    const record = await this.get(uid, deviceId, Boolean(refreshToken));
    if (!record) return !isFirebaseAdminConfigured();
    if (record.revokedAt) return false;
    if (refreshToken && record.tokenHash !== hashToken(refreshToken)) return false;
    return true;
  }

  async touch(uid: string, deviceId: string) {
    const hit = this.cache.get(this.key(uid, deviceId));
    if (hit?.record) hit.record.lastUsedAt = Date.now();
    try {
      await this.doc(uid, deviceId).update({ lastUsedAt: Date.now() });
    } catch {
      /* ignore */
    }
  }

  async list(uid: string): Promise<DeviceRecord[]> {
    const local = Array.from(this.cache.entries())
      .filter(([k, v]) => k.startsWith(`${uid}/`) && v.record)
      .map(([, v]) => v.record!);
    const byId = new Map(local.map((r) => [r.deviceId, r]));
    try {
      const snap = await (getFirestore().collection('users').doc(uid).collection('devices') as any).get();
      for (const d of snap.docs) {
        const r = d.data() as DeviceRecord;
        byId.set(r.deviceId, r);
      }
    } catch {
      /* in-memory dev mode */
    }
    return Array.from(byId.values()).sort((a, b) => b.pairedAt - a.pairedAt);
  }

  async revoke(uid: string, deviceId: string): Promise<boolean> {
    const record = await this.get(uid, deviceId, true);
    if (!record) return false;
    record.revokedAt = Date.now();
    this.cache.set(this.key(uid, deviceId), { record, at: Date.now() });
    try {
      await this.doc(uid, deviceId).update({ revokedAt: record.revokedAt });
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(uid, deviceId);
    return true;
  }

  /** Tests only */
  clear() {
    this.cache.clear();
  }
}

export const deviceStore = new DeviceStore();
