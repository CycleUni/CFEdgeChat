/**
 * Whether a new message should send the recipient an email.
 *
 * Two rules, both from the product requirement:
 *
 *   1. Only when the recipient is not reachable in the app at all — no
 *      WebSocket on their UserHub, which the frontend opens once per visit
 *      for the whole site (not per conversation). Having a conversation
 *      *closed* is not being away; having the site closed is.
 *   2. At most one email per conversation per "unread streak": once a room
 *      has been emailed about, later messages in that same room stay silent
 *      until the recipient actually opens it (which clears the mark via
 *      UserHub's mark-read path). Otherwise a chatty sender turns into a
 *      dozen identical emails about one conversation.
 *
 * Kept out of UserHub so it can be tested as what it is: a pure decision over
 * a handful of values, with no Durable Object or workerd runtime involved.
 */

export interface OfflineEmailInput {
  /** Room the message landed in. */
  roomId: string | undefined;
  /** True when this hub belongs to the message's own sender. */
  isSelf: boolean;
  /** Live sockets on this user's hub, across all their devices/tabs. */
  activeSocketCount: number;
  /** Rooms already emailed about and not yet opened since. */
  notifiedRooms: readonly string[];
}

export function shouldSendOfflineEmail(input: OfflineEmailInput): boolean {
  const { roomId, isSelf, activeSocketCount, notifiedRooms } = input;
  // Nothing addressable to link to, and nothing to dedupe on.
  if (!roomId) return false;
  // You are never notified about your own message.
  if (isSelf) return false;
  // The site is open somewhere — the in-app badge is the notification.
  if (activeSocketCount > 0) return false;
  // Already told them about this conversation; wait until they open it.
  if (notifiedRooms.includes(roomId)) return false;
  return true;
}
