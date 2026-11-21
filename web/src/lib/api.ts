import type { AppUser } from './auth-context';

export const SERVER_URL = (process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:8088').replace(/\/$/, '');

export function wsUrl(): string {
  return SERVER_URL.replace(/^http/, 'ws') + '/ws';
}

export interface SessionData {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  ownerName: string;
  bpm: number;
  keySignature: string;
  members: string[];
  memberNames: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface PresenceEntry {
  connectionId: string;
  userId: string;
  userName: string;
  client: 'plugin' | 'web';
  daw: string;
  joinedAt: number;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Calls the DownBeat backend with the user's Firebase ID token. */
export async function api<T>(user: AppUser, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await user.getIdToken();
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(`Can't reach the DownBeat server at ${SERVER_URL}`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

export const listSessions = (user: AppUser) =>
  api<{ sessions: SessionData[] }>(user, '/sessions').then((r) => r.sessions);

export const createSession = (user: AppUser, body: { name: string; bpm: number; keySignature: string }) =>
  api<{ session: SessionData }>(user, '/sessions', { method: 'POST', body }).then((r) => r.session);

export const joinSession = (user: AppUser, inviteCode: string) =>
  api<{ session: SessionData }>(user, '/sessions/join', { method: 'POST', body: { inviteCode } }).then((r) => r.session);

export const getSession = (user: AppUser, id: string) =>
  api<{ session: SessionData }>(user, `/sessions/${encodeURIComponent(id)}`).then((r) => r.session);

export interface SessionEvent {
  id: string;
  type: string;
  userId: string;
  userName: string;
  timestamp: number;
  source: 'plugin' | 'web' | 'server';
  payload: Record<string, any>;
}

export interface UserContribution {
  userId: string;
  userName: string;
  count: number;
  types: Record<string, number>;
  audioActiveSeconds: number;
  midiNotes: number;
  clipNotesAdded?: number;
  tempoChanges: number;
  notes: string[];
  firstSeen: number;
  lastSeen: number;
}

export const getEvents = (user: AppUser, id: string, limit = 200) =>
  api<{ events: SessionEvent[]; total: number }>(user, `/sessions/${encodeURIComponent(id)}/events?limit=${limit}`);

export const getContributions = (user: AppUser, id: string) =>
  api<{ contributions: UserContribution[] }>(user, `/sessions/${encodeURIComponent(id)}/contributions`).then((r) => r.contributions);

// ---------------------------------------------------------------------------
// AI agents
// ---------------------------------------------------------------------------
export type CheckStatus = 'ok' | 'warning' | 'problem';
export interface MixCheck { status: CheckStatus; finding: string; fix: string }
export interface MixReport {
  id: string;
  kind: 'mix_doctor';
  createdAt: number;
  createdBy: { uid: string; name: string };
  fileName: string;
  model: string;
  metricsError?: string;
  metrics: null | {
    durationSec: number;
    integratedLufs: number;
    maxShortTermLufs: number;
    truePeakDbfs: number;
    samplePeakDbfs: number;
    clippedRegions: number;
    stereoCorrelation: number | null;
    lowEndCorrelation: number | null;
    crestFactorDb: number;
    spectralBalanceDb: Record<string, number>;
  };
  diagnosis: {
    summary: string;
    overallScore: number;
    checks: { clipping: MixCheck; loudness: MixCheck; frequencyMasking: MixCheck; stereo: MixCheck };
    otherIssues: Array<{ title: string; severity: 'low' | 'medium' | 'high'; timestamp?: string; finding: string; fix: string }>;
    strengths: string[];
  };
}

export interface CreditsProposal {
  id: string;
  kind: 'credits';
  createdAt: number;
  createdBy: { uid: string; name: string };
  status: 'pending' | 'changes_requested' | 'final' | 'superseded';
  sessionOverview: string;
  splits: Array<{ userId: string; userName: string; role: string; percentage: number; reasoning: string }>;
  caveats: string[];
  aiDisclosure: string;
  model: string;
  approvals: Record<string, { approvedAt: number; name: string }>;
  changeRequests: Array<{ uid: string; name: string; comment: string; at: number }>;
  finalizedAt?: number;
}

export const getAgentStatus = (user: AppUser) =>
  api<{ geminiConfigured: boolean; model: string; lyriaModel: string; maxUploadMb: number }>(user, '/agents/status');

export const listReports = <T,>(user: AppUser, sessionId: string, kind: 'mix_doctor' | 'credits') =>
  api<{ reports: T[] }>(user, `/agents/reports?sessionId=${encodeURIComponent(sessionId)}&kind=${kind}`).then((r) => r.reports);

export async function uploadMix(user: AppUser, sessionId: string, file: File): Promise<MixReport> {
  const token = await user.getIdToken();
  const qs = `sessionId=${encodeURIComponent(sessionId)}&fileName=${encodeURIComponent(file.name)}`;
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/agents/mix-doctor?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new ApiError(`Can't reach the DownBeat server at ${SERVER_URL}`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Upload failed (${res.status})`, res.status);
  return data.report;
}

export const proposeCredits = (user: AppUser, sessionId: string, guidance?: string) =>
  api<{ proposal: CreditsProposal }>(user, '/agents/credits/propose', { method: 'POST', body: { sessionId, guidance } }).then((r) => r.proposal);

export const approveCredits = (user: AppUser, sessionId: string, id: string) =>
  api<{ proposal: CreditsProposal }>(user, `/agents/credits/${id}/approve`, { method: 'POST', body: { sessionId } }).then((r) => r.proposal);

export const requestCreditChanges = (user: AppUser, sessionId: string, id: string, comment: string) =>
  api<{ proposal: CreditsProposal }>(user, `/agents/credits/${id}/request-changes`, { method: 'POST', body: { sessionId, comment } }).then((r) => r.proposal);

/** Downloads the split-sheet PDF (auth header needed, so fetch + blob instead of a plain link). */
export async function downloadSplitSheet(user: AppUser, sessionId: string, id: string, draft = false) {
  const token = await user.getIdToken();
  const res = await fetch(`${SERVER_URL}/agents/credits/${id}/pdf?sessionId=${encodeURIComponent(sessionId)}${draft ? '&draft=1' : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || `Download failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'split-sheet.pdf';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Paired plugins (devices)
// ---------------------------------------------------------------------------
export interface Device {
  deviceId: string;
  label: string;
  pairedAt: number;
  lastUsedAt: number;
  revokedAt?: number;
}

export const listDevices = (user: AppUser) => api<{ devices: Device[] }>(user, '/auth/devices').then((r) => r.devices);
export const revokeDevice = (user: AppUser, id: string) =>
  api<{ success: boolean }>(user, `/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
