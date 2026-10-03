import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Saffron is reserved for seal moments (U2): only the Seal component and the token file may
// reference the colour. The needles are built from parts so this file does not contain them.
const HEX = '#' + 'd99a' + '1e';
const TOKEN = '--color-' + 'seal';
const ALLOWED = new Set(['lib/components/Seal.svelte', 'lib/styles/tokens.css']);
const SRC = resolve(import.meta.dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('saffron usage', () => {
  it('appears only in Seal.svelte and tokens.css', () => {
    const offenders = files(SRC)
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        const text = readFileSync(join(SRC, rel), 'utf8').toLowerCase();
        return text.includes(HEX) || text.includes(TOKEN);
      });
    expect(offenders).toEqual([]);
  });

  it('is actually used by the files that are allowed to use it', () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(SRC, rel), 'utf8').toLowerCase();
      expect(text.includes(HEX) || text.includes(TOKEN)).toBe(true);
    }
  });
});
