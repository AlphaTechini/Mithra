import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { describeError } from './errors';

describe('describeError', () => {
  const unreachable = {
    title: "Mithra can't reach its server.",
    message: 'Check that the backend is running on port 8787, then retry.',
  };

  it('explains an unreachable backend', () => {
    expect(describeError(new ApiError(0, 'network_error', 'x'))).toEqual(unreachable);
    expect(describeError(new ApiError(502, 'http_error', 'x'))).toEqual(unreachable);
    expect(describeError(new ApiError(200, 'invalid_json', 'x'))).toEqual(unreachable);
  });

  it('passes through the API message for API errors', () => {
    expect(
      describeError(
        new ApiError(409, 'conflict', 'Already sealed. Refresh to see it.'),
        'Could not seal.',
      ),
    ).toEqual({
      title: 'Could not seal.',
      message: 'Already sealed. Refresh to see it.',
    });
  });

  it('never returns a bare code for unknown errors', () => {
    const copy = describeError(new Error('boom'));
    expect(copy.title).not.toBe('');
    expect(copy.message).not.toMatch(/boom/);
  });
});
