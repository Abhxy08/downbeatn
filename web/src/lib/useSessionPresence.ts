'use client';

import { useEffect, useRef, useState } from 'react';
import type { AppUser } from './auth-context';
import { wsUrl, type PresenceEntry, type SessionEvent } from './api';

export type SocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface BeatJamState {
  active: boolean;
  status: 'idle' | 'connecting' | 'playing' | 'error';
  prompts: Array<{ text: string; by: string }>;
  bpm?: number;
  startedBy?: string;
  error?: string;
}

/**
 * Joins a session room over WebSocket and returns who is online.
 * Reconnects with backoff and fetches a fresh Firebase ID token each time.
 */
export function useSessionPresence(
  user: AppUser | null,
  sessionId: string | null,
  onEvent?: (event: SessionEvent) => void
) {
  const [online, setOnline] = useState<PresenceEntry[]>([]);
  const [beatJam, setBeatJam] = useState<BeatJamState>({ active: false, status: 'idle', prompts: [] });
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    if (!user || !sessionId) return;

    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const open = async () => {
      setStatus(attempt.current === 0 ? 'connecting' : 'reconnecting');
      let token: string;
      try {
        token = await user.getIdToken();
      } catch {
        setStatus('error');
        setError('Could not get a sign-in token');
        return;
      }
      if (stopped) return;

      ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        ws!.send(JSON.stringify({ type: 'auth', token, client: 'web' }));
        ws!.send(JSON.stringify({ type: 'join_session', sessionId }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'session_joined') {
          attempt.current = 0;
          setStatus('connected');
          setError(null);
        } else if (msg.type === 'presence') {
          setOnline(msg.online);
        } else if (msg.type === 'beatjam_state') {
          setBeatJam(msg.state);
        } else if (msg.type === 'error' && msg.code === 'beatjam') {
          setBeatJam((b) => ({ ...b, error: msg.message }));
        } else if (msg.type === 'crdt_event') {
          onEventRef.current?.(msg.event);
        } else if (msg.type === 'event_rejected') {
          setError(`Log entry rejected: ${msg.error}`);
        } else if (msg.type === 'error' && (msg.code === 'not_a_member' || msg.code === 'session_not_found')) {
          stopped = true; // permanent — don't retry
          setStatus('error');
          setError(msg.message);
          ws?.close();
        }
      };
      ws.onclose = () => {
        setOnline([]);
        if (stopped) return;
        const delay = Math.min(5000, 500 * 2 ** attempt.current++);
        setStatus('reconnecting');
        retryTimer = setTimeout(open, delay);
      };
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, [user, sessionId]);

  /** Sends a client event (e.g. a contribution note). The server acks it and broadcasts to others. */
  const sendEvent = (eventType: string, payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const id = `web_${crypto.randomUUID().replace(/-/g, '')}`;
    ws.send(JSON.stringify({ type: 'crdt_event', id, eventType, payload, clientTimestamp: Date.now() }));
    return id;
  };

  /** Sends a raw control message (e.g. beatjam_start). */
  const send = (msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  return { online, status, error, sendEvent, beatJam, send };
}
