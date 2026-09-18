// Answers a client's close frame from a Durable Object's webSocketClose.
//
// Under this Worker's compatibility date the runtime does not reply to a
// close frame on its own (that became the default only with
// `web_socket_auto_reply_to_close`), so a handler that does nothing leaves the
// handshake half-done: the browser waits it out and reports 1006, an abnormal
// close, for a disconnect it asked for itself.
//
// 1005 ("no status received") and 1006 ("abnormal closure") describe how a
// close was observed and may not be sent in a close frame, so they are
// answered with a plain 1000. A socket already past closing throws, which
// only means there is nothing left to answer.
export function completeClose(ws: WebSocket, code: number, reason: string): void {
  const sendable = code === 1005 || code === 1006 || code < 1000 ? 1000 : code;
  try {
    ws.close(sendable, reason);
  } catch {
    // Already closed.
  }
}
