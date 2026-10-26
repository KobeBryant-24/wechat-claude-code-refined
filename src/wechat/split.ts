/**
 * Message splitting — turn one blob of text into the chunks WeChat accepts.
 *
 * WeChat's single-message limit is 4000 characters. Every chunk this
 * produces is one `sendmessage` call, and one `sendmessage` call is one unit
 * of the user's per-turn outbound quota — so the split point is not a
 * formatting detail, it is a budget decision.
 *
 * Lives in its own module because two places need to agree on where the
 * boundaries are: the sender's queue worker (which sends the chunks) and the
 * compact-mode collector (which counts them and writes them into a markdown
 * file). If they disagreed, "the reply was 4 messages" would mean one thing
 * to the budget check and another to the file.
 */

/** Maximum characters in a single outbound message. */
export const MAX_CHUNK = 4000;

/**
 * Hard ceiling on the UTF-8 byte size of one outbound message.
 *
 * iLink rejects an oversized payload with `ret:-2` — the same return code it
 * uses for an exhausted quota and an expired token, so the three are
 * indistinguishable at the call site. 4000 *characters* can be 12000 bytes in
 * Chinese or 16000 bytes in emoji-heavy text; the server's limit is 16384
 * bytes. A chunk that crossed it would be silently undeliverable.
 */
export const MAX_CHUNK_BYTES = 16_384;

/**
 * Split `text` into chunks of at most `MAX_CHUNK` characters, preferring
 * paragraph, line, then sentence boundaries.
 */
export function splitMessage(text: string, maxChunk: number = MAX_CHUNK): string[] {
  if (text.length <= maxChunk) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChunk) {
    let cut = rest.lastIndexOf('\n\n', maxChunk);
    if (cut < maxChunk / 2) cut = rest.lastIndexOf('\n', maxChunk);
    if (cut < maxChunk / 2) cut = rest.lastIndexOf('。', maxChunk);
    if (cut < maxChunk / 2) cut = rest.lastIndexOf('. ', maxChunk);
    if (cut < maxChunk / 2) cut = maxChunk;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Split `text` so that every chunk is within both the character limit and
 * the UTF-8 byte limit.
 *
 * The character-based split alone is not enough: 4000 emoji are 16000 bytes,
 * and 4000 characters of 4-byte code points plus a decoration can cross the
 * server's byte ceiling. Chunks that would cross it are cut further at a
 * character boundary — deliberately *not* a word boundary, because at this
 * point the constraint is bytes, and there may be no word boundary to find.
 */
export function splitMessageByBytes(
  text: string,
  maxChars: number = MAX_CHUNK,
  maxBytes: number = MAX_CHUNK_BYTES,
): string[] {
  const chunks = splitMessage(text, maxChars);
  const out: string[] = [];
  for (const chunk of chunks) {
    if (Buffer.byteLength(chunk, 'utf8') <= maxBytes) {
      out.push(chunk);
      continue;
    }
    // Hard byte-boundary cut. Walk the string accumulating bytes until the
    // next code point would overflow, then cut there.
    let start = 0;
    let bytes = 0;
    for (let i = 0; i < chunk.length; i++) {
      const cp = chunk.codePointAt(i)!;
      const size = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
      const step = cp > 0xffff ? 2 : 1; // surrogate pair occupies two UTF-16 units
      if (bytes + size > maxBytes) {
        out.push(chunk.slice(start, i));
        start = i;
        bytes = 0;
      }
      bytes += size;
      i += step - 1;
    }
    if (start < chunk.length) out.push(chunk.slice(start));
  }
  return out.filter(c => c.length > 0);
}
