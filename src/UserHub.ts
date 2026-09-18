import { DurableObject } from "cloudflare:workers";
import { shouldSendOfflineEmail } from "./offlineEmailPolicy";
import { isWebhookUrlAllowed } from "./webhookUrlPolicy";
import { completeClose } from "./wsClose";

export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  USER_HUB: DurableObjectNamespace;
  EDGE_CHAT_JWT_SECRET: string;
  DJANGO_WEBHOOK_URL?: string;
  // Shared secret Django requires on every webhook call (X-Webhook-Secret);
  // without it the offline-email callback is rejected with 403 and the
  // recipient silently never hears about the message.
  DJANGO_WEBHOOK_SECRET?: string;
}

// Rooms this user has already been emailed about and has not opened since.
// Persisted (not in-memory) because the whole point is to still be true
// after this DO hibernates — which it will, since nobody is connected to it
// while its user is away.
const EMAIL_NOTIFIED_KEY = "emailNotifiedRooms";

// Body of a /push call from ChatRoom.
interface PushPayload {
  room_id: string;
  sender_id: string;
  // The hub's own user, passed explicitly by ChatRoom (which knows the
  // participant list from the sender's signed token) so the email callback
  // can name a recipient even on a hub that has never been connected to.
  recipient_id?: string;
  preview: string;
  timestamp: number;
  self?: boolean;
}

// Minimum time between accepted WebSocket connections for the same user's
// hub, to blunt reconnect-storm abuse (same rationale/value as ChatRoom's
// per-room reconnect throttle).
const MIN_RECONNECT_INTERVAL_MS = 1_000;

// One instance per user (keyed by idFromName(userId)). Holds the single
// WebSocket a client keeps open across its whole visit instead of one per
// open conversation, AND owns the unread-count state for that user.
//
// Unread state lives here (not in Django) so:
//   - the badge in the nav can update without polling Django on every push,
//   - mark-read round-trips don't need to leave the Worker,
//   - marks/deletes from one device are immediately visible to all other
//     devices sharing this user (same DO).
//
// `unread` is a Set keyed by roomId; `count` is denormalized so we don't
// have to .size the Set on every change. Both are stored on the DO so they
// survive hibernation (`getWebSockets` re-populates the active sockets, but
// the Set/Map persist via `storage.put`).
export class UserHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const userId = url.searchParams.get("userId");
      if (!userId) {
        return new Response("Missing userId", { status: 400 });
      }

      // Known limitation: unlike ChatRoom, this DO is keyed per-user
      // (idFromName(userId)), so it only ever holds a single
      // `lastConnect:<userId>` entry for its own user — no unbounded growth
      // here despite the shared key naming convention.
      const lastConnectKey = `lastConnect:${userId}`;
      const lastConnect = (await this.ctx.storage.get<number>(lastConnectKey)) || 0;
      if (Date.now() - lastConnect < MIN_RECONNECT_INTERVAL_MS) {
        return new Response("Too Many Requests: reconnecting too fast", { status: 429 });
      }
      await this.ctx.storage.put(lastConnectKey, Date.now());

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ userId });
      // Remembered for the offline-email callback, which runs when there is
      // no socket left to read the id off.
      await this.ctx.storage.put("userId", userId);

      const requestedProtocol = request.headers.get("Sec-WebSocket-Protocol");
      const responseHeaders: HeadersInit | undefined = requestedProtocol
        ? { "Sec-WebSocket-Protocol": requestedProtocol.split(",")[0].trim() }
        : undefined;

      // Send a snapshot right after accept so the client can resync the badge
      // without waiting for the next room_update (covers the offline period
      // where missed messages couldn't increment us). This comment used to
      // describe the snapshot while the code only stashed it in the socket
      // attachment and never sent it, so every client fetched it again over
      // REST — an OPTIONS plus a GET, each a Worker request and the GET a DO
      // request too, on every connect and reconnect. Queued now; the runtime
      // delivers it once the handshake completes. /snapshot stays for
      // clients built before this.
      const unread = (await this.ctx.storage.get<string[]>("unread")) || [];
      const lastReadAt = (await this.ctx.storage.get<Record<string, number>>("lastReadAt")) || {};
      server.send(JSON.stringify({ type: "snapshot", unread, lastReadAt, count: unread.length }));

      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    // Internal-only: reached exclusively via a direct DO stub call from
    // ChatRoom (env.USER_HUB.get(id).fetch(...)), never routed through the
    // Worker's public fetch() handler, so it needs no auth of its own.
    // The "sender_id" is the user who just sent the message — we exclude
    // their own hub from increment (their own send doesn't make their inbox
    // unread), and we increment /every other/ participant's unread set.
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      const data = await request.json() as PushPayload;
      const roomUpdateMsg = JSON.stringify({ type: "room_update", ...data });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(roomUpdateMsg);
        } catch (e) {
          console.error("Failed to send room_update to socket", e);
        }
      }
      // `self: true` means the sender's own hub is being notified (so their
      // inbox can show the latest preview). Their own send doesn't make
      // THEIR inbox unread — skip the increment.
      if (!data.self) {
        await this.markUnread(data.room_id);
      }
      // Separate from the unread mark on purpose: unread is per *message*
      // state the badge reflects, this is a one-shot-per-conversation email
      // for a user who has no way to see that badge right now.
      await this.maybeSendOfflineEmail(data);
      return new Response("ok");
    }

    // Reconnect-time sync: a freshly-reconnecting client (or a script) asks
    // the hub for its current unread state in one REST call, instead of
    // having to wait for the snapshot done in attachToSocket to flow on the
    // websocket. Returns { unread: roomId[], lastReadAt: { roomId: ts } }.
    if (request.method === "GET" && url.pathname.endsWith("/snapshot")) {
      const unread = (await this.ctx.storage.get<string[]>("unread")) || [];
      // Make sure the cached `count` matches the Set on disk; cheap to assert.
      const lastReadAt = (await this.ctx.storage.get<Record<string, number>>("lastReadAt")) || {};
      await this.ctx.storage.put("count", unread.length);
      return Response.json({ unread, lastReadAt, count: unread.length });
    }

    // Mark a single room read for this user. POST body: { room_id }.
    // Called from the fronted on conversation open; the Worker route is
    // intentionally NOT reachable from the public internet (only /<app>/
    // <room>/read under the per-room ChatRoom Channel); here for completeness
    // so future admin tooling can hit it.
    if (request.method === "POST" && url.pathname.endsWith("/read")) {
      const { room_id } = await request.json() as { room_id: string };
      if (!room_id) return new Response("Missing room_id", { status: 400 });
      await this.markRead(room_id);
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }

  private async markUnread(roomId: string): Promise<void> {
    const unread = new Set((await this.ctx.storage.get<string[]>("unread")) || []);
    if (unread.has(roomId)) {
      // already counted — don't broadcast again for the same room
      return;
    }
    unread.add(roomId);
    await this.ctx.storage.put("unread", [...unread]);
    await this.ctx.storage.put("count", unread.size);
    const msg = JSON.stringify({ type: "unread_count", count: unread.size, unread: [...unread] });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch (e) {
        console.error("Failed to send unread_count to socket", e);
      }
    }
  }

  private async markRead(roomId: string): Promise<void> {
    // Opening the conversation is what re-arms the email for it: from here on
    // the next message that arrives while this user is away may notify again.
    // Done before the early return below, because a room can be marked
    // notified and then read from another device that had already cleared the
    // unread flag — the mark would otherwise stick forever and silence every
    // future notification for that conversation.
    await this.clearEmailNotified(roomId);

    const unread = new Set((await this.ctx.storage.get<string[]>("unread")) || []);
    if (!unread.delete(roomId)) {
      // already read, no need to re-broadcast
      await this.ctx.storage.put("lastReadAt", {
        ...((await this.ctx.storage.get<Record<string, number>>("lastReadAt")) || {}),
        [roomId]: Date.now(),
      });
      return;
    }
    const lastReadAt = {
      ...((await this.ctx.storage.get<Record<string, number>>("lastReadAt")) || {}),
      [roomId]: Date.now(),
    };
    await this.ctx.storage.put("unread", [...unread]);
    await this.ctx.storage.put("lastReadAt", lastReadAt);
    await this.ctx.storage.put("count", unread.size);
    const msg = JSON.stringify({ type: "unread_count", count: unread.size, unread: [...unread] });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch (e) {
        console.error("Failed to send unread_count to socket", e);
      }
    }
  }

  // Emails the recipient about a message that arrived while they had the site
  // closed — see shouldSendOfflineEmail for the two conditions. The Worker
  // doesn't send mail itself: it calls the same Django webhook ChatRoom uses
  // for the inbox mirror, with an `event` discriminator, and Django owns the
  // templates, the address, and every "should this person be mailed at all"
  // rule (deactivated account, conversation they deleted, ...).
  private async maybeSendOfflineEmail(data: PushPayload): Promise<void> {
    const notifiedRooms = (await this.ctx.storage.get<string[]>(EMAIL_NOTIFIED_KEY)) || [];
    const decision = shouldSendOfflineEmail({
      roomId: data.room_id,
      isSelf: !!data.self,
      // Counts every device/tab this user has open, hibernated ones included.
      activeSocketCount: this.ctx.getWebSockets().length,
      notifiedRooms,
    });
    if (!decision) return;

    const webhookUrl = this.env.DJANGO_WEBHOOK_URL;
    if (!isWebhookUrlAllowed(webhookUrl)) return;

    const recipientId = data.recipient_id || (await this.ctx.storage.get<string>("userId"));
    if (!recipientId) {
      // Nothing to address the mail to. Leaving the room unmarked means a
      // later message (by then carrying recipient_id) can still notify.
      console.error("Offline email skipped: no recipient id for this hub");
      return;
    }

    // Marked before the request goes out, not after: the send is a
    // fire-and-forget waitUntil whose result nobody waits for, and one missed
    // email (Django down) is a better failure than a burst of duplicates from
    // every message that arrives while it is down. The mark clears the next
    // time the recipient opens the conversation either way.
    await this.ctx.storage.put(EMAIL_NOTIFIED_KEY, [...notifiedRooms, data.room_id]);

    this.ctx.waitUntil(
      fetch(webhookUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.env.DJANGO_WEBHOOK_SECRET ? { "X-Webhook-Secret": this.env.DJANGO_WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify({
          // Distinguishes this from the inbox-preview mirror call ChatRoom
          // makes to the same endpoint; Django dispatches on it.
          event: "offline_email",
          room_id: data.room_id,
          recipient_id: recipientId,
          sender_id: data.sender_id,
          preview: data.preview,
          timestamp: data.timestamp,
        }),
      }).catch(e => console.error("Offline email webhook failed", e))
    );
  }

  private async clearEmailNotified(roomId: string): Promise<void> {
    const notifiedRooms = (await this.ctx.storage.get<string[]>(EMAIL_NOTIFIED_KEY)) || [];
    if (!notifiedRooms.includes(roomId)) return;
    await this.ctx.storage.put(EMAIL_NOTIFIED_KEY, notifiedRooms.filter(id => id !== roomId));
  }

  // Client -> server messages aren't part of this protocol (the hub is
  // notify-only); anything received is ignored rather than acted on.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
    completeClose(ws, code, reason);
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {}
}
