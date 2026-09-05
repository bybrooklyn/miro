// Every HTTP body the daemon reads from something it does not control - a public web page, a
// stranger's SearXNG node, searx.space's list, an app's API - used to be buffered whole by
// `await res.text()` and only then capped (audit R1). This reads at most `maxBytes` off the wire
// and cancels the rest, so a hostile or merely huge response cannot grow the daemon's heap.

export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  // A multi-byte character cut at the cap decodes as U+FFFD; that is the boundary, not content.
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}
