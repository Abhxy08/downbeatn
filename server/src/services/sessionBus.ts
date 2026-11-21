import crypto from 'crypto';
import { crdtManager, EventType, SessionEvent } from './crdt';

/**
 * Lets HTTP routes / agents record server-observed events in a session's log.
 * The WebSocket server registers a publisher so events are also broadcast live.
 */
export interface Actor {
  uid: string;
  name: string;
}

type Publisher = (sessionId: string, event: SessionEvent) => void;
let publisher: Publisher | null = null;

export function setEventPublisher(p: Publisher | null) {
  publisher = p;
}

export function publishServerEvent(sessionId: string, actor: Actor, type: EventType, payload: Record<string, unknown>): SessionEvent {
  const event: SessionEvent = {
    id: `srv_${crypto.randomUUID()}`,
    type,
    userId: actor.uid,
    userName: actor.name,
    timestamp: Date.now(),
    source: 'server',
    payload,
  };
  if (publisher) publisher(sessionId, event);
  else crdtManager.appendEvent(sessionId, event);
  return event;
}
