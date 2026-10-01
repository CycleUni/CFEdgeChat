/**
 * Whether a connection may mark a room read for its user.
 *
 * An "observer" token can read a room and not write to it. Two kinds of
 * reader hold one: a moderator looking at a reported conversation, who has
 * no unread state in it, and a buyer or seller whose listing was deleted, so
 * the chat is kept read-only. The second still has unread notices in this
 * room (a platform cancel, say), and refusing their read receipt left the
 * badge stuck for good. Tell them apart by the room's participants, which
 * come from the signed token, never from the client.
 */
export function mayMarkRead(
  role: string,
  userId: string,
  participantIds: readonly string[] | undefined,
): boolean {
  if (role !== "observer") return true;
  return Array.isArray(participantIds) && participantIds.includes(userId);
}
