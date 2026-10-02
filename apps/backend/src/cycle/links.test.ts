import { describe, expect, it } from 'vitest';
import { localnetTestConfig, mainnetTestConfig } from '../testConfig';
import { txLinkFor } from './links';

describe('payment links (P3)', () => {
  it('MainNet links to the explorer in a new tab', () => {
    expect(txLinkFor(mainnetTestConfig(), '1220abc')).toEqual({
      updateId: '1220abc',
      href: 'https://explorer.example/tx/1220abc',
      external: true,
    });
  });

  it('LocalNet links to the in-app transaction page', () => {
    expect(txLinkFor(localnetTestConfig(), '1220abc')).toEqual({
      updateId: '1220abc',
      href: '/app/tx/1220abc',
      external: false,
    });
  });
});
