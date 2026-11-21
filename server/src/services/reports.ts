import { getFirestore } from './firebase';

/** AI agent outputs (Mix Doctor reports, Credits proposals), stored under sessions/{id}/reports/{reportId}. */
export interface StoredReport {
  id: string;
  sessionId: string;
  kind: 'mix_doctor' | 'credits';
  createdAt: number;
  createdBy: { uid: string; name: string };
  [key: string]: unknown;
}

class ReportStore {
  private cache = new Map<string, Map<string, StoredReport>>();
  private loaded = new Map<string, Promise<void>>();

  private bucket(sessionId: string) {
    let m = this.cache.get(sessionId);
    if (!m) this.cache.set(sessionId, (m = new Map()));
    return m;
  }

  private ensureLoaded(sessionId: string) {
    let p = this.loaded.get(sessionId);
    if (!p) {
      p = (async () => {
        try {
          const snap = await (getFirestore().collection('sessions').doc(sessionId).collection('reports') as any).get();
          for (const d of snap.docs) {
            const r = d.data() as StoredReport;
            if (!this.bucket(sessionId).has(r.id)) this.bucket(sessionId).set(r.id, r);
          }
        } catch {
          /* local dev without Firestore */
        }
      })();
      this.loaded.set(sessionId, p);
    }
    return p;
  }

  async list(sessionId: string, kind?: StoredReport['kind']): Promise<StoredReport[]> {
    await this.ensureLoaded(sessionId);
    return Array.from(this.bucket(sessionId).values())
      .filter((r) => !kind || r.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(sessionId: string, id: string): Promise<StoredReport | undefined> {
    await this.ensureLoaded(sessionId);
    return this.bucket(sessionId).get(id);
  }

  async save(report: StoredReport): Promise<void> {
    this.bucket(report.sessionId).set(report.id, report);
    try {
      await getFirestore().collection('sessions').doc(report.sessionId).collection('reports').doc(report.id).set(
        JSON.parse(JSON.stringify(report)) // strip undefined (Firestore rejects it)
      );
    } catch (e: any) {
      console.warn(`[Reports] Firestore save skipped: ${e.message}`);
    }
  }

  /** Tests only */
  clear() {
    this.cache.clear();
    this.loaded.clear();
  }
}

export const reportStore = new ReportStore();
