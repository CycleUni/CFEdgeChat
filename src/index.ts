import { jwtVerify } from "jose";
import { ChatRoom } from "./ChatRoom";
import { UserHub } from "./UserHub";

export { ChatRoom, UserHub };

export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  USER_HUB: DurableObjectNamespace;
  EDGE_CHAT_JWT_SECRET: string;
  DJANGO_WEBHOOK_URL?: string;
  // Comma-separated list of allowed frontend origins, e.g.
  // "https://cycleuni.example.com,https://staging.cycleuni.example.com".
  // Required in any deployed environment. May be left unset only when
  // ENVIRONMENT=development (see corsHeaders below), which permits a
  // wildcard fallback for local dev.
  APP_ORIGINS?: string;
  // Set to "development" (e.g. in .dev.vars) to allow the wildcard CORS
  // fallback when APP_ORIGINS is unset. Any other value (including unset,
  // which is what a real deploy will be unless someone explicitly sets it)
  // is treated as production and requires APP_ORIGINS to be configured.
  ENVIRONMENT?: string;
}

const ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

class CorsConfigError extends Error {}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowlist = (env.APP_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);

  if (allowlist.length === 0) {
    // Only local dev may run without an allowlist. Anything else (including
    // simply forgetting to set APP_ORIGINS in a real deployment) is refused
    // rather than silently falling back to a wildcard origin.
    if (env.ENVIRONMENT !== "development") {
      throw new CorsConfigError(
        "APP_ORIGINS is not configured. Set it (comma-separated allowed origins) " +
        "or set ENVIRONMENT=development for local dev."
      );
    }
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
  if (origin && allowlist.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  let headers: Record<string, string>;
  try {
    headers = corsHeaders(request, env);
  } catch (e) {
    if (e instanceof CorsConfigError) {
      console.error(e.message);
      // Include the variable name in the client-visible body (not a secret
      // value, just which check failed) so a misconfiguration is diagnosable
      // straight from a browser's Network tab, without needing Worker logs.
      return new Response("Chat service misconfigured: APP_ORIGINS not set", { status: 500 });
    }
    throw e;
  }
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    merged.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

// Token arrives as an `Authorization: Bearer <token>` header (REST calls) or
// as a `Sec-WebSocket-Protocol` subprotocol (the only way a browser's native
// WebSocket API can attach anything auth-like to the handshake, since it has
// no API for custom headers). Never accepted via `?token=` query param —
// that would land in access logs, Referer headers, and browser history.
function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  if (protocolHeader) {
    // Browsers send the offered subprotocol list as a comma-separated string.
    return protocolHeader.split(",")[0].trim();
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Preflight for the REST history endpoint (the frontend's Authorization
    // header makes it a non-simple request). WebSocket upgrades never
    // trigger a CORS preflight, so this only matters for /api/... calls.
    if (request.method === "OPTIONS") {
      try {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      } catch (e) {
        if (e instanceof CorsConfigError) {
          console.error(e.message);
          return new Response("Chat service misconfigured: APP_ORIGINS not set", { status: 500 });
        }
        throw e;
      }
    }

    if (!env.EDGE_CHAT_JWT_SECRET || env.EDGE_CHAT_JWT_SECRET.length < 32) {
      console.error("EDGE_CHAT_JWT_SECRET is missing or too short (need >= 32 chars)");
      return withCors(new Response("Chat service misconfigured: EDGE_CHAT_JWT_SECRET missing or invalid", { status: 500 }), request, env);
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    // Expected format: /ws/user/<user_id> or /api/internal/users/<user_id>/...
    // The single per-user notification hub.
    const isUserHubWs = pathParts.length === 3 && pathParts[0] === "ws" && pathParts[1] === "user";
    const isUserHubApi = pathParts.length >= 4 && pathParts[0] === "api" && pathParts[1] === "internal" && pathParts[2] === "users";

    if (isUserHubWs || isUserHubApi) {
      if (isUserHubWs && request.headers.get("Upgrade") !== "websocket") {
        return withCors(new Response("Expected WebSocket upgrade", { status: 400 }), request, env);
      }

      const pathUserId = isUserHubWs ? pathParts[2] : pathParts[3];
      if (!ID_SEGMENT.test(pathUserId)) {
        return withCors(new Response("Bad Request: invalid user id", { status: 400 }), request, env);
      }

      const token = extractToken(request);
      if (!token) {
        return withCors(new Response("Unauthorized: Missing token", { status: 401 }), request, env);
      }

      try {
        const secret = new TextEncoder().encode(env.EDGE_CHAT_JWT_SECRET);
        const { payload } = await jwtVerify(token, secret);
        const userId = payload.user_id as string;

        if (!userId) {
          return withCors(new Response("Unauthorized: Invalid token payload", { status: 401 }), request, env);
        }

        // A hub token proves identity only — it must match the hub being
        // connected to, or any authenticated user could listen in on
        // another user's notification stream.
        if (String(userId) !== String(pathUserId)) {
          return withCors(new Response(`Forbidden: Token not valid for this user (userId: ${userId}, path: ${pathUserId})`, { status: 403 }), request, env);
        }

        const id = env.USER_HUB.idFromName(userId);
        const stub = env.USER_HUB.get(id);

        const doUrl = new URL(request.url);
        doUrl.searchParams.set("userId", userId);

        const doResponse = await stub.fetch(new Request(doUrl.toString(), request));
        return doResponse.status === 101 ? doResponse : withCors(doResponse, request, env);
      } catch (e) {
        console.error("JWT Verification failed", e);
        return withCors(new Response("Unauthorized: Invalid token", { status: 401 }), request, env);
      }
    }

    // Expected format: /ws/<app_id>/<room_id> or /api/<app_id>/<room_id>/messages
    if (pathParts.length >= 3 && (pathParts[0] === "ws" || pathParts[0] === "api")) {
      const appId = pathParts[1];
      const roomId = pathParts[2];

      if (!ID_SEGMENT.test(appId) || !ID_SEGMENT.test(roomId)) {
        return withCors(new Response("Bad Request: invalid app_id or room_id", { status: 400 }), request, env);
      }

      const token = extractToken(request);
      if (!token) {
        return withCors(new Response("Unauthorized: Missing token", { status: 401 }), request, env);
      }

      try {
        const secret = new TextEncoder().encode(env.EDGE_CHAT_JWT_SECRET);
        const { payload } = await jwtVerify(token, secret);
        const userId = payload.user_id as string;
        const tokenRoomId = payload.room_id as string | undefined;
        const tokenAppId = payload.app_id as string | undefined;

        if (!userId) {
          return withCors(new Response("Unauthorized: Invalid token payload", { status: 401 }), request, env);
        }

        // The token is scoped to one app's room by the issuer (Django verifies
        // room membership before minting it). Without the app_id check, a
        // token minted for one app's room "X" would also authorize access to
        // a different app's room also named "X", since the DO key
        // (`${appId}:${roomId}`) is per-app but the room_id claim alone
        // isn't. Both claims must match the path.
        if (tokenAppId !== appId) {
          return withCors(new Response("Forbidden: Token not valid for this app", { status: 403 }), request, env);
        }
        if (tokenRoomId !== roomId) {
          return withCors(new Response("Forbidden: Token not valid for this room", { status: 403 }), request, env);
        }

        const id = env.CHAT_ROOM.idFromName(`${appId}:${roomId}`);
        const stub = env.CHAT_ROOM.get(id);

        // Forward request to Durable Object. This is a server-to-server call
        // the browser never sees, so passing userId via query string here
        // doesn't reintroduce the "token in URL" problem the client-facing
        // side was just fixed for.
        const doUrl = new URL(request.url);
        doUrl.searchParams.set("userId", userId);
        const role = (payload.role as string) || "user";
        doUrl.searchParams.set("role", role);
        // participant_ids comes from the signed token, not the client, so
        // ChatRoom can trust it to know who to notify on their hub — see
        // ChatRoom's use of it in webSocketMessage.
        const participantIds = payload.participant_ids as string[] | undefined;
        if (Array.isArray(participantIds)) {
          doUrl.searchParams.set("participantIds", participantIds.join(","));
        }

        const doResponse = await stub.fetch(new Request(doUrl.toString(), request));
        // A 101 Switching Protocols response carries a non-standard
        // `webSocket` field that reconstructing the Response would drop;
        // only the plain REST responses (history fetch, DO-side 404s/429s)
        // need CORS headers added.
        return doResponse.status === 101 ? doResponse : withCors(doResponse, request, env);
      } catch (e) {
        console.error("JWT Verification failed", e);
        return withCors(new Response("Unauthorized: Invalid token", { status: 401 }), request, env);
      }
    }

    return withCors(
      new Response("CFEdgeChat OK. Use /ws/<app_id>/<room_id> to connect.", { status: 200 }),
      request,
      env
    );
  }
};
