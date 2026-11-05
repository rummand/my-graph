/** A fresh UUID, in the browser and on the server (both have Web Crypto). */
export function randomUUIDish(): string {
  return globalThis.crypto.randomUUID();
}
