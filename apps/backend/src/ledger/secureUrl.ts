/**
 * Where credentials may be sent. A ledger token or an OIDC client secret must not cross the
 * network in cleartext, so a URL that carries one must be `https:`. The exception is the same
 * machine: loopback hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), which is how every
 * LocalNet URL looks (`localnet/nodes.env`, `.env.example`).
 */

/** True for `localhost`, `*.localhost`, an IPv4 address in 127.0.0.0/8 and `::1`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((o) => o <= 255) && octets[0] === 127;
}

/** True when a credential may be sent to `url`: https, or a loopback host. False for a URL that does not parse. */
export function isSecureForCredentials(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || isLoopbackHost(parsed.hostname);
}

/** `origin` of `url` (resolved against `base`) for messages, without path, query or credentials. */
export function originOf(url: string, base?: string): string {
  try {
    return new URL(url, base).origin;
  } catch {
    return url;
  }
}
