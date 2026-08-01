import { DurableObject } from "cloudflare:workers";

export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  USER_HUB: DurableObjectNamespace;
  EDGE_CHAT_JWT_SECRET: string;
  DJANGO_WEBHOOK_URL?: string;
  // Shared secret Django's EdgeChatWebhookView requires on every call from
  // here (X-Webhook-Secret header) — without it Django now rejects the
  // request with 403, so the offline-message webhook silently no-ops.
  DJANGO_WEBHOOK_SECRET?: string;
}

interface Message {
  id: string;
  user_id: string;
  content: string;
  timestamp: number;
  message_type?: "text" | "image";
  metadata?: Record<string, unknown>;
}

const MAX_MESSAGE_LENGTH = 4000;
// Per-connection send rate limit: messages allowed per window.
const SEND_RATE_LIMIT = 20;
const SEND_RATE_WINDOW_MS = 10_000;
// Minimum time between accepted WebSocket connections for the same user in
// this room, to blunt reconnect-storm abuse.
const MIN_RECONNECT_INTERVAL_MS = 1_000;

// System message prefixes that only 'system' role tokens can send
const SYSTEM_MESSAGE_PREFIXES = [
  "[SYSTEM:",
  "[MEETUP_REQUEST]",
  "[MEETUP_ACCEPT]",
  "[MEETUP_DECLINE]",
  "[MEETUP_CANCEL]",
] as const;

// Inbox-preview placeholder for an image message, sent to Django's inbox
// mirror and to both participants' hubs. Carries an i18n key rather than
// literal text: this preview is persisted server-side and shown to *both*
// participants, who may be reading in different languages, so it can't be
// resolved at write time. Same [SYSTEM:<key>] convention the backend uses for
// order notifications; the frontend resolves it per viewer.
//
// Note this is only ever a *derived preview*, never inbound message content,
// so it does not trip the isSystemMessage() guard below (which rejects
// user-role senders using system prefixes) — the message body itself stays
// the image URL.
const IMAGE_PREVIEW_TOKEN = "[SYSTEM:msg.imagePlaceholder]";

function isSystemMessage(content: string): boolean {
  return SYSTEM_MESSAGE_PREFIXES.some(prefix => content.startsWith(prefix));
}

interface ConnectionState {
  userId: string;
  role: "user" | "system"; // Track role from JWT
  // Sliding count of messages sent within the current rate-limit window.
  windowStart: number;
  windowCount: number;
}

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        content TEXT,
        timestamp INTEGER,
        message_type TEXT DEFAULT 'text',
        metadata TEXT
      )
    `);

    // Per-user "delete for me" marks. A message is only purged from
    // `messages` once both participants of the (2-party) room have marked
    // it deleted here.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS message_deletions (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id)
      )
    `);
  }

  private restRateLimits = new Map<string, { windowStart: number, windowCount: number }>();

  private isRestRateLimited(userId: string): boolean {
    let state = this.restRateLimits.get(userId);
    if (!state) {
      state = { windowStart: Date.now(), windowCount: 0 };
      this.restRateLimits.set(userId, state);
    }
    const now = Date.now();
    if (now - state.windowStart > SEND_RATE_WINDOW_MS) {
      state.windowStart = now;
      state.windowCount = 1;
      return false;
    }
    state.windowCount += 1;
    return state.windowCount > SEND_RATE_LIMIT;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const userId = url.searchParams.get("userId");
      if (!userId) {
        return new Response("Missing userId", { status: 400 });
      }

      // Known limitation: `lastConnect:<userId>` keys accumulate in this DO's
      // storage forever (one per distinct userId ever seen), with no expiry
      // or cleanup job. Low priority: a ChatRoom is per-room (usually 2
      // participants), so the number of distinct keys is naturally bounded
      // by room membership rather than unbounded users.
      const lastConnectKey = `lastConnect:${userId}`;
      const lastConnect = (await this.ctx.storage.get<number>(lastConnectKey)) || 0;
      if (Date.now() - lastConnect < MIN_RECONNECT_INTERVAL_MS) {
        return new Response("Too Many Requests: reconnecting too fast", { status: 429 });
      }
      await this.ctx.storage.put(lastConnectKey, Date.now());

      // Cached from the connecting client's signed token so new-message
      // notifications can be pushed to both participants' hubs even when
      // one of them isn't currently connected to this room (persisted, so
      // it survives hibernation and is available on the very first message
      // sent after this connect).
      const roomId = url.pathname.split("/").filter(Boolean)[2];
      const participantIdsParam = url.searchParams.get("participantIds");
      if (roomId) {
        await this.ctx.storage.put("roomId", roomId);
      }
      if (participantIdsParam) {
        await this.ctx.storage.put("participantIds", participantIdsParam.split(","));
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // acceptWebSocket() enables hibernation: this DO instance (and any
      // in-memory fields) can be evicted and reconstructed between events
      // while the socket itself stays open at the edge. serializeAttachment
      // survives that eviction; a plain instance Map would silently lose
      // entries. See webSocketMessage() for the matching read side.
      this.ctx.acceptWebSocket(server);
      const role = (url.searchParams.get("role") as "user" | "system") || "user";
      const state: ConnectionState = { userId, role, windowStart: Date.now(), windowCount: 0 };
      server.serializeAttachment(state);

      // Echo back the negotiated subprotocol (the token, sent by the
      // browser via `new WebSocket(url, [token])` since the WebSocket API
      // has no way to attach a custom Authorization header). Some clients
      // require the server to confirm one of the offered subprotocols to
      // consider the handshake valid.
      const requestedProtocol = request.headers.get("Sec-WebSocket-Protocol");
      const responseHeaders: HeadersInit | undefined = requestedProtocol
        ? { "Sec-WebSocket-Protocol": requestedProtocol.split(",")[0].trim() }
        : undefined;

      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      // Fetch historical messages, excluding ones this user has deleted for themselves
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const userId = url.searchParams.get("userId") || "";

      const cursor = this.ctx.storage.sql.exec(
        `SELECT m.* FROM messages m
         WHERE NOT EXISTS (
           SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ?
         )
         ORDER BY timestamp DESC LIMIT ?`,
        userId, limit
      );

      const messages = [...cursor].map(row => ({
        ...row,
        message_type: row.message_type || "text",
        metadata: row.metadata ? JSON.parse(row.metadata as string) : null
      })).reverse(); // Output in chronological order
      return Response.json(messages);
    }

    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      const userId = url.searchParams.get("userId") || "";
      const role = url.searchParams.get("role") || "user";
      let bodyData: any = {};
      try {
        bodyData = await request.json();
      } catch (e) {}

      const content = bodyData.content;
      const messageType = bodyData.message_type || "text";
      const metadata = bodyData.metadata || null;

      if (!content || typeof content !== "string") {
        return new Response("Missing content", { status: 400 });
      }

      if (messageType === "text" && content.length > MAX_MESSAGE_LENGTH) {
        return new Response(`Message too long (max ${MAX_MESSAGE_LENGTH} chars)`, { status: 400 });
      }

      if (messageType === "image") {
        try {
          new URL(content);
        } catch {
          return new Response("Image content must be a valid URL", { status: 400 });
        }
        if (metadata && typeof metadata !== "object") {
          return new Response("Metadata must be an object", { status: 400 });
        }
      }

      if (this.isRestRateLimited(userId)) {
        return new Response("Too Many Requests", { status: 429 });
      }

      if (role === "user" && isSystemMessage(content)) {
        return new Response(JSON.stringify({ code: "FORBIDDEN_SYSTEM_MESSAGE", message: "Users cannot send system messages" }), { status: 403 });
      }

      const msgId = crypto.randomUUID();
      const timestamp = Date.now();

      this.ctx.storage.sql.exec(
        `INSERT INTO messages (id, user_id, content, timestamp, message_type, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        msgId, userId, content, timestamp, messageType, metadata ? JSON.stringify(metadata) : null
      );

      const broadcastMsg = JSON.stringify({
        type: "message",
        message: {
          id: msgId,
          user_id: userId,
          content,
          message_type: messageType,
          metadata,
          timestamp
        }
      });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(broadcastMsg);
        } catch (e) {}
      }

      // Notify UserHub for room_update. roomId/participantIds are signed
      // into the caller's token and forwarded here as query params by
      // index.ts on every request (not just websocket upgrades) — prefer
      // those over DO storage, which is only seeded once someone has
      // actually opened a websocket to this room. Without this, a system/
      // order message posted into a brand-new conversation (nobody has ever
      // opened the chat page for it yet) silently never reaches either
      // participant's hub, so the inbox never live-updates until a refresh.
      const pathParts = url.pathname.split("/").filter(Boolean);
      const participantIdsParam = url.searchParams.get("participantIds");
      const roomId =
        (pathParts.length >= 3 ? pathParts[2] : "") ||
        (await this.ctx.storage.get<string>("roomId")) ||
        "";
      const participantIds = participantIdsParam
        ? participantIdsParam.split(",").filter(Boolean)
        : await this.ctx.storage.get<string[]>("participantIds");

      // Seed storage from this request's own signed params so later calls
      // (including the user-message path, which only reads from storage)
      // benefit too.
      if (roomId) await this.ctx.storage.put("roomId", roomId);
      if (participantIdsParam) await this.ctx.storage.put("participantIds", participantIds);

      if (roomId && participantIds && Array.isArray(participantIds)) {
        await this.pushToHubs(roomId, userId, content, timestamp, messageType);
      }

      return Response.json({ id: msgId, timestamp });
    }

    // Mark a room read for the requesting user. Auth is already done by
    // index.ts (token.user_id == caller; token.room_id == roomId), so
    // here we just resolve the user's UserHub DO and ask it to drop the
    // roomId from its unread set. The hub broadcasts the new `unread_count`
    // to every socket on that DO, so every device for that user reflects
    // the change.
    if (request.method === "POST" && url.pathname.endsWith("/read")) {
      const userId = url.searchParams.get("userId");
      if (!userId) return new Response("Missing userId", { status: 400 });

      // pathParts is the per-room path: ["api", "<appId>", "<roomId>", "read"].
      // We re-extract roomId here directly so we don't rely on cached storage.
      const pathParts = url.pathname.split("/").filter(Boolean);
      const roomId = pathParts[2];

      // Push to the user's own UserHub DO, which is the source of truth
      // for that user's unread state. The hub key is per-user, not per-room,
      // so a single fetch resolves it.
      const hubId = this.env.USER_HUB.idFromName(userId);
      const hubStub = this.env.USER_HUB.get(hubId);
      await hubStub.fetch(
        new Request("http://internal/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_id: roomId }),
        })
      );
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const state = ws.deserializeAttachment() as ConnectionState | undefined;
    if (!state?.userId || typeof message !== "string") return;
    const userId = state.userId;

    if (this.isRateLimited(ws, state)) {
      this.sendToSender(ws, { type: "error", message: "Rate limit exceeded, slow down" });
      return;
    }

    try {
      const data = JSON.parse(message);

      if (data.type === "message" && data.content) {
        const messageType = data.message_type || "text";
        const metadata = data.metadata || null;

        if (messageType === "text") {
          if (typeof data.content !== "string" || data.content.length > MAX_MESSAGE_LENGTH) {
            this.sendToSender(ws, { type: "error", message: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
            return;
          }
        } else if (messageType === "image") {
          if (typeof data.content !== "string") {
            this.sendToSender(ws, { type: "error", message: "Image content must be a string URL" });
            return;
          }
          try {
            new URL(data.content);
          } catch {
            this.sendToSender(ws, { type: "error", message: "Image content must be a valid URL" });
            return;
          }
          if (metadata && typeof metadata !== "object") {
            this.sendToSender(ws, { type: "error", message: "Metadata must be an object" });
            return;
          }
        } else {
          this.sendToSender(ws, { type: "error", message: "Invalid message_type" });
          return;
        }

        // Block system message prefixes for non-system roles
        if (state.role === "user" && isSystemMessage(data.content)) {
          this.sendToSender(ws, { type: "error", code: "FORBIDDEN_SYSTEM_MESSAGE", message: "Users cannot send system messages" });
          return;
        }

        const msgId = crypto.randomUUID();
        const timestamp = Date.now();

        this.ctx.storage.sql.exec(
          `INSERT INTO messages (id, user_id, content, timestamp, message_type, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
          msgId, userId, data.content, timestamp, messageType, metadata ? JSON.stringify(metadata) : null
        );

        const broadcastMsg = JSON.stringify({
          type: "message",
          message: {
            id: msgId,
            user_id: userId,
            content: data.content,
            message_type: messageType,
            metadata,
            timestamp: timestamp
          }
        });

        // Broadcast to all other sessions. getWebSockets() reflects every
        // currently-attached socket, including ones accepted before this DO
        // instance was last hibernated/recreated.
        let otherUsersConnected = false;
        for (const peer of this.ctx.getWebSockets()) {
          if (peer !== ws) {
            otherUsersConnected = true;
            try {
              peer.send(broadcastMsg);
            } catch (e) {
              console.error("Failed to send broadcast to peer socket", e);
            }
          }
        }

        this.sendToSender(ws, { type: "ack", id: msgId, timestamp });

        // The conversation UUID cached from the connecting client's URL —
        // NOT this.ctx.id (the Durable Object's own internal id, which
        // looks nothing like it and doesn't match any Conversation row).
        const roomId = await this.ctx.storage.get<string>("roomId");

        // Trigger Webhook for Django to update Inbox Preview and optionally send push notifications
        if (roomId && this.env.DJANGO_WEBHOOK_URL && this.isWebhookUrlAllowed(this.env.DJANGO_WEBHOOK_URL)) {
          const webhookContent = messageType === "image" ? IMAGE_PREVIEW_TOKEN : data.content;
          this.triggerOfflineWebhook(roomId, userId, webhookContent, !otherUsersConnected);
        }

        // Notify both participants' single per-user hub connections (not
        // just the one other socket in *this* room) so the inbox sidebar
        // can show a live preview/unread badge for a conversation the
        // recipient doesn't currently have open.
        await this.pushToHubs(roomId, userId, data.content, timestamp, messageType);
      } else if (data.type === "delete" && data.id) {
        this.deleteMessageForUser(ws, userId, data.id);
      }
    } catch (e) {
      console.error("Error processing websocket message", e);
      this.sendToSender(ws, { type: "error", message: "Malformed message, failed to send" });
    }
  }

  // Sends a structured response back to the originating socket only (never
  // broadcast). Wrapped in its own try/catch so a bad/closing sender socket
  // can't throw an unhandled rejection inside the async webSocketMessage
  // handler.
  private sendToSender(ws: WebSocket, payload: Record<string, unknown>) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      console.error("Failed to send response to sender socket", e);
    }
  }

  // Fixed-window counter stored on the socket's serialized attachment so it
  // survives hibernation eviction (see the constructor comment above).
  private isRateLimited(ws: WebSocket, state: ConnectionState): boolean {
    const now = Date.now();
    if (now - state.windowStart > SEND_RATE_WINDOW_MS) {
      state.windowStart = now;
      state.windowCount = 1;
      ws.serializeAttachment(state);
      return false;
    }
    state.windowCount += 1;
    ws.serializeAttachment(state);
    return state.windowCount > SEND_RATE_LIMIT;
  }

  // Pushes a lightweight "something happened in this room" event to each
  // participant's UserHub DO (a DO-to-DO call within the same Worker, never
  // exposed to the internet). Participant ids came from the connecting
  // client's signed token, so this can't be steered by a client to notify
  // an arbitrary user about an arbitrary room.
  //
  // The sender's own hub gets the room_update (so their inbox can show the
  // latest preview) but is told `self: true` so the hub knows to skip the
  // unread increment — sending a message doesn't mark YOUR inbox as
  // having something new to read.
  private async pushToHubs(roomId: string | undefined, senderId: string, content: string, timestamp: number, messageType: string = "text") {
    const participantIds = await this.ctx.storage.get<string[]>("participantIds");
    if (!roomId || !participantIds) return;

    let preview: string;
    if (messageType === "image") {
      preview = IMAGE_PREVIEW_TOKEN;
    } else {
      preview = content.length > 200 ? content.slice(0, 200) : content;
    }
    await Promise.all(participantIds.map(participantId => {
      const hubId = this.env.USER_HUB.idFromName(participantId);
      const hubStub = this.env.USER_HUB.get(hubId);
      const isSelf = participantId === senderId;
      return hubStub.fetch("https://internal/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_id: roomId,
          sender_id: senderId,
          preview,
          timestamp,
          self: isSelf,
        }),
      }).catch(e => console.error("Hub push failed", e));
    }));
  }

  // DJANGO_WEBHOOK_URL is operator-set config, not attacker-controlled input,
  // but this still guards against a typo'd/misconfigured value turning into
  // an SSRF vector — only allow https, or http to localhost for local dev.
  private isWebhookUrlAllowed(rawUrl: string): boolean {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:") return true;
      if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private deleteMessageForUser(ws: WebSocket, userId: string, messageId: string) {
    const exists = [...this.ctx.storage.sql.exec(
      `SELECT id FROM messages WHERE id = ?`, messageId
    )].length > 0;
    if (!exists) return;

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO message_deletions (message_id, user_id) VALUES (?, ?)`,
      messageId, userId
    );

    const [{ cnt }] = [...this.ctx.storage.sql.exec(
      `SELECT COUNT(DISTINCT user_id) as cnt FROM message_deletions WHERE message_id = ?`,
      messageId
    )] as { cnt: number }[];

    if (cnt >= 2) {
      // Both parties have now deleted it — purge for real and tell everyone
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE id = ?`, messageId);
      this.ctx.storage.sql.exec(`DELETE FROM message_deletions WHERE message_id = ?`, messageId);

      const purgedMsg = JSON.stringify({ type: "message_deleted", id: messageId });
      for (const peer of this.ctx.getWebSockets()) {
        try {
          peer.send(purgedMsg);
        } catch (e) {
          console.error("Failed to send message_deleted to peer socket", e);
        }
      }
    } else {
      // Only this user has deleted it so far: hide it on their side only,
      // it still exists for the other party until they delete it too.
      ws.send(JSON.stringify({ type: "delete_ack", id: messageId }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // No in-memory session map to clean up; the runtime drops closed
    // sockets from getWebSockets() on its own.
  }

  async webSocketError(ws: WebSocket, error: unknown) {}

  private triggerOfflineWebhook(roomId: string, senderId: string, content: string, isOffline: boolean) {
    this.ctx.waitUntil(
      fetch(this.env.DJANGO_WEBHOOK_URL!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.env.DJANGO_WEBHOOK_SECRET ? { "X-Webhook-Secret": this.env.DJANGO_WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify({
          room_id: roomId,
          sender_id: senderId,
          content: content,
          timestamp: Date.now(),
          is_offline: isOffline
        })
      }).catch(e => console.error("Webhook failed", e))
    );
  }
}
