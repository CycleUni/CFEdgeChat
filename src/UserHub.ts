import { DurableObject } from "cloudflare:workers";

export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  USER_HUB: DurableObjectNamespace;
  EDGE_CHAT_JWT_SECRET: string;
  DJANGO_WEBHOOK_URL?: string;
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

      const requestedProtocol = request.headers.get("Sec-WebSocket-Protocol");
      const responseHeaders: HeadersInit | undefined = requestedProtocol
        ? { "Sec-WebSocket-Protocol": requestedProtocol.split(",")[0].trim() }
        : undefined;

      // Send a snapshot right after accept so the client can resync the badge
      // without waiting for the next room_update (covers the offline period
      // where missed messages couldn't increment us).
      server.serializeAttachment({
        userId,
        unread: await this.ctx.storage.get<string[]>("unread") || [],
        lastReadAt: await this.ctx.storage.get<Record<string, number>>("lastReadAt") || {},
      });

      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    // Internal-only: reached exclusively via a direct DO stub call from
    // ChatRoom (env.USER_HUB.get(id).fetch(...)), never routed through the
    // Worker's public fetch() handler, so it needs no auth of its own.
    // The "sender_id" is the user who just sent the message — we exclude
    // their own hub from increment (their own send doesn't make their inbox
    // unread), and we increment /every other/ participant's unread set.
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      const data = await request.json() as {
        room_id: string;
        sender_id: string;
        preview: string;
        timestamp: number;
        self?: boolean;
      };
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
    const msg = JSON.stringify({ type: "unread_count", count: unread.size });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch (e) {
        console.error("Failed to send unread_count to socket", e);
      }
    }
  }

  private async markRead(roomId: string): Promise<void> {
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
    const msg = JSON.stringify({ type: "unread_count", count: unread.size });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch (e) {
        console.error("Failed to send unread_count to socket", e);
      }
    }
  }

  // Client -> server messages aren't part of this protocol (the hub is
  // notify-only); anything received is ignored rather than acted on.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {}

  async webSocketError(_ws: WebSocket, _error: unknown) {}
}
