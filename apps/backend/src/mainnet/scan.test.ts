import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoReceiveStatus } from '../holders/autoReceive';
import { createMainnetAutoReceive } from './autoReceive';
import { lookupPreapproval } from './scan';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A stub Scan: parties with a preapproval answer 200, others 404, "broken" answers 500. */
async function stubScan(onRequest?: (url: string) => void): Promise<string> {
  server = createServer((request, response) => {
    onRequest?.(request.url ?? '');
    const prefix = '/v0/transfer-preapprovals/by-party/';
    const party = decodeURIComponent((request.url ?? '').slice(prefix.length));
    if (!(request.url ?? '').startsWith(prefix)) {
      response.writeHead(404).end();
    } else if (party === 'on::1220aa') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"contract":{}}');
    } else if (party === 'broken::1220aa') {
      response.writeHead(500).end('boom');
    } else {
      response.writeHead(404).end('{}');
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('lookupPreapproval', () => {
  it('200 means on, 404 means off, anything else is unknown', async () => {
    const urls: string[] = [];
    const scan = await stubScan((u) => urls.push(u));
    expect(await lookupPreapproval(scan, 'on::1220aa')).toBe(true);
    expect(await lookupPreapproval(scan, 'off::1220aa')).toBe(false);
    expect(await lookupPreapproval(scan, 'broken::1220aa')).toBeNull();
    expect(urls[0]).toBe('/v0/transfer-preapprovals/by-party/on%3A%3A1220aa');
    // A trailing slash on the base URL does not double up.
    expect(await lookupPreapproval(`${scan}/`, 'on::1220aa')).toBe(true);
  });

  it('is unknown when the Scan cannot be reached', async () => {
    expect(await lookupPreapproval('http://127.0.0.1:1', 'on::1220aa', fetch, 500)).toBeNull();
  });
});

describe('MainNet auto-receive', () => {
  const wallets = {
    get: (holder: string) =>
      Promise.resolve(
        holder === 'holder-on'
          ? { partyId: 'on::1220aa' }
          : holder === 'holder-off'
            ? { partyId: 'off::1220aa' }
            : null,
      ),
  };

  it('looks the holder up through their connected wallet, null without a wallet', async () => {
    const scan = await stubScan();
    const status = createMainnetAutoReceive({ scanUrl: scan, wallets });
    expect(status).toBeInstanceOf(AutoReceiveStatus);
    expect(await status.get('holder-on')).toBe(true);
    expect(await status.get('holder-off')).toBe(false);
    expect(await status.get('holder-new')).toBeNull();
    expect([...(await status.getMany(['holder-on', 'holder-new']))]).toEqual([
      ['holder-on', true],
      ['holder-new', null],
    ]);
  });

  it('is null for everyone when no Scan URL is set', async () => {
    const status = createMainnetAutoReceive({ scanUrl: undefined, wallets });
    expect(await status.get('holder-on')).toBeNull();
  });

  it('forgets a cached answer on invalidate (Check again)', async () => {
    const scan = await stubScan();
    let party = 'off::1220aa';
    const status = createMainnetAutoReceive({
      scanUrl: scan,
      wallets: { get: () => Promise.resolve({ partyId: party }) },
    });
    expect(await status.get('h')).toBe(false);
    party = 'on::1220aa';
    expect(await status.get('h')).toBe(false); // cached
    status.invalidate('h');
    expect(await status.get('h')).toBe(true);
  });
});
