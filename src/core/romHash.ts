/** Content-hash identity for ROMs (SHA-256, first 16 hex chars is plenty). */

export async function hashRom(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}
