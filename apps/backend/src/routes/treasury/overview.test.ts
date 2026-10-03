import type { CycleSummary, Role } from '@mithra/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import '../../auth/plugin';
import { ApiError, errorBody } from '../../http/errors';
import { localnetTestConfig } from '../../testConfig';
import { treasuryRoutes, type CycleQueries, type TreasuryRoutesDeps } from './index';

const ROLES: Record<string, Role[]> = { 'treasurer::1': ['treasurer'] };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function cycle(over: Partial<CycleSummary>): CycleSummary {
  return {
    cycleId: '2026-09',
    label: 'September 2026',
    status: 'paid-automatically',
    total: '300.0000000000',
    recordDate: '2026-08-31',
    approvals: null,
    flagCount: 0,
    trigger: 'schedule',
    createdAt: '2026-10-01T10:00:00.000Z',
    seeded: false,
    ...over,
  };
}

function build(cycles: CycleQueries): { app: FastifyInstance; warnings: string[] } {
  const warnings: string[] = [];
  const instance = Fastify({
    logger: {
      level: 'warn',
      stream: { write: (line: string) => void warnings.push(line) },
    },
  });
  app = instance;
  instance.decorateRequest('session', null);
  instance.decorate('roleResolver', {
    resolveRoles: (id: string) =>
      Promise.resolve({ roles: ROLES[id] ?? [], primaryRole: ROLES[id]?.[0] ?? null }),
    resolveMany: () => Promise.resolve(new Map()),
  });
  instance.addHook('onRequest', (request, _reply, done) => {
    const party = request.headers['x-party'];
    request.session = typeof party === 'string' ? { id: 's', partyId: party } : null;
    done();
  });
  instance.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.status).send(errorBody(error.code, error.message));
    return reply.code(500).send(errorBody('internal_error', 'Internal server error'));
  });
  const deps = {
    config: localnetTestConfig(),
    ledger: {
      reader: { mandate: () => Promise.resolve(null) },
      client: {},
      commands: {},
    },
    asset: { balance: () => Promise.resolve('1000.0000000000') },
    names: {},
    activity: { list: () => Promise.resolve([]) },
    bus: {},
    db: {},
    cycles,
    funding: {},
    options: { autoReceive: {}, infrastructure: {} },
  } as unknown as TreasuryRoutesDeps;
  treasuryRoutes(instance, deps);
  return { app: instance, warnings };
}

describe('GET /api/overview', () => {
  const overview = (a: FastifyInstance) =>
    a.inject({ method: 'GET', url: '/api/overview', headers: { 'x-party': 'treasurer::1' } });

  it('shows the cycles it can read', async () => {
    const { app: a } = build({
      listCycles: () => Promise.resolve([cycle({})]),
      nextCycle: () => Promise.resolve(null),
    });
    const res = await overview(a);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ expectedNextTotal: string }>().expectedNextTotal).toBe('300.0000000000');
  });

  it('still answers, with no cycles, when the cycle list cannot be read', async () => {
    const { app: a, warnings } = build({
      listCycles: () => Promise.reject(new Error('ledger down')),
      nextCycle: () => Promise.resolve(null),
    });
    const res = await overview(a);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ recentCycles: unknown[]; expectedNextTotal: string | null }>();
    expect(body.recentCycles).toEqual([]);
    expect(body.expectedNextTotal).toBeNull();
    expect(warnings.some((w) => w.includes('could not read the cycles for the overview'))).toBe(
      true,
    );
  });
});
