/**
 * Document ids minted on the device (SPEC §3.5): a ULID — 48 bits of milliseconds, then
 * 80 random bits, in Crockford base 32. The server accepts them as they are, which is
 * what lets a note made offline keep its id when it reaches the server.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function mintUlid(now: number = Date.now()): string {
  let time = "";
  let ms = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[bytes[i]! % 32];
  return time + random;
}
