/**
 * Whether a MainNet party has a transfer preapproval (auto-receive on), asked of a public Scan.
 *
 * UNVERIFIED (docs/verification.md): the endpoint `GET {scan}/v0/transfer-preapprovals/by-party/{party}`
 * is taken from the Splice Scan API as remembered and could not be reached from the build
 * environment. It is kept in this one function: 200 means on, 404 means off, anything else (or a
 * network failure) is `null`, "could not tell".
 */
export async function lookupPreapproval(
  scanUrl: string,
  partyId: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<boolean | null> {
  const url = `${scanUrl.replace(/\/+$/, '')}/v0/transfer-preapprovals/by-party/${encodeURIComponent(partyId)}`;
  try {
    const response = await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}
