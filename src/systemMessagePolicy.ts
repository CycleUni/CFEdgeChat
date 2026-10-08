// Control tokens only 'system' role tokens may send: the order notices and
// the meetup-card markers the app draws as official cards.
const SYSTEM_MESSAGE_TOKENS = [
  "[SYSTEM:",
  "[MEETUP_REQUEST]",
  "[MEETUP_ACCEPT]",
  "[MEETUP_DECLINE]",
  "[MEETUP_CANCEL]",
] as const;

/**
 * Whether `content` carries a control token anywhere in it.
 *
 * Anywhere, not just at the start: app versions before the fix drew a card
 * for a token found at any position, so "ok [SYSTEM:order.notify.
 * seller_approved]" from the other party showed an official "seller
 * approved" card. Those versions can stay cached in a service worker for a
 * while; refusing the message here protects them too.
 */
export function isSystemMessage(content: string): boolean {
  return SYSTEM_MESSAGE_TOKENS.some(token => content.includes(token));
}
