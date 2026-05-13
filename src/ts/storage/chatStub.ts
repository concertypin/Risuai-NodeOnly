/**
 * Stub-related types and predicates extracted out of `database.svelte.ts` so
 * they can be unit-tested without dragging in the Svelte runtime ($state,
 * etc.). `database.svelte.ts` re-exports these to keep existing imports
 * working unchanged.
 */

/**
 * Minimal stub stored in database.bin — full chat data lives server-side.
 * Only exists in encoded/decoded data; at runtime stubs are converted to
 * placeholder Chats.
 */
export interface ChatStub {
    id: string
    name: string
    lastDate?: number
    folderId?: string
    modules?: string[]
    _stub: true
}

/**
 * A real stub has the `_stub: true` flag AND no `message` array. The two
 * checks are not redundant: legacy v1.4.x disk corruption can produce
 * "hybrid" objects that carry `_stub: true` while still holding the full
 * Chat payload (message etc). Treating those as stubs would either:
 *   - silently strip messages on the next round-trip (chatToStub fast-path
 *     returns input unchanged), or
 *   - cause the patcher to diff stub-vs-Chat and emit chat-internal field
 *     ops, which the chat-data guard then has to swallow.
 *
 * Excluding hybrids from `isChatStub` makes them flow through the normal
 * Chat code paths (stripped to a real stub by chatToStub, kept as Chat by
 * convertStubsToPlaceholders) — the corrupt flag self-heals.
 */
export function isChatStub(chat: unknown): chat is ChatStub {
    if (chat == null || typeof chat !== 'object') return false
    const c = chat as Record<string, unknown>
    return c._stub === true && !Array.isArray(c.message)
}
