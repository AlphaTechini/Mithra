import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { HealthResponseSchema, type HealthResponse } from '@mithra/shared';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
} from 'fastify';
import { ZodError } from 'zod';
import { version } from '../package.json';
import { sessionPlugin } from './auth/plugin';
import { createRoleResolver } from './auth/roles';
import { SessionService } from './auth/sessions';
import type { Config } from './config/env';
import type { DatabaseHandle } from './db';
import type { EventBus } from './events/bus';
import { ApiError, errorBody, upstreamErrorResponse } from './http/errors';
import type { Ledger } from './ledger';
import { agentRoutes, type AgentRouteOptions } from './routes/agent';
import { configRoutes } from './routes/config';
import { eventsRoute } from './routes/events';
import { sessionRoutes, type SessionRouteOptions } from './routes/session';
import { statusRoutes } from './routes/status';
import { treasuryRoutes, type TreasuryRoutesDeps } from './routes/treasury';

export type { ErrorBody } from './http/errors';

/**
 * The route modules of the product. They are built once by `createBackend` (src/wiring) from one
 * event bus, one party-name lookup and one activity log, and registered after the session plugin.
 */
export interface AppModules {
  /** Live updates (`GET /api/events`). */
  bus: EventBus;
  /** The cycle module's routes: cycles, approvals, the Mandate and its sealing, policy drafts. */
  cycle: { routes: FastifyPluginAsync };
  /** Everything the treasury routes need besides the configuration, the ledger and the database. */
  treasury: Omit<TreasuryRoutesDeps, 'config' | 'ledger' | 'db'>;
  /** The agent chat, the policy drafter and the audit scope drafter. */
  agent: AgentRouteOptions;
  /** The audit flow: requests, grants, the evidence room. */
  audit?: { routes: FastifyPluginAsync };
}

/** What the API routes need besides the configuration. Without it only health and config routes exist. */
export interface AppDeps {
  database: DatabaseHandle;
  ledger: Ledger;
  /** Overrides for tests, such as the sign-in rate limit. */
  session?: SessionRouteOptions;
  /** The product's route modules; without them only the session and status routes exist. */
  modules?: AppModules;
}

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
};

function sendNotFound(reply: FastifyReply, method: string, url: string): FastifyReply {
  return reply.code(404).send(errorBody('not_found', `Route ${method} ${url} not found`));
}

function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/api' || path.startsWith('/api/');
}

export function buildApp(config: Config, deps?: AppDeps): FastifyInstance {
  const prettyLogs = process.env['NODE_ENV'] !== 'production' && process.stdout.isTTY;
  const app = Fastify({
    // Contract ids travel in URL parameters; the default limit of 100 characters is too short.
    routerOptions: { maxParamLength: 300 },
    logger: {
      level: config.logLevel,
      ...(prettyLogs ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  const webDistDir = config.webDistDir ? resolve(config.webDistDir) : undefined;
  if (webDistDir && !existsSync(join(webDistDir, 'index.html'))) {
    throw new Error(
      `WEB_DIST_DIR ${webDistDir} does not contain index.html; build the web app first`,
    );
  }

  // In production the backend serves the web app itself (same origin), so CORS is only needed in
  // development, when the web dev server runs on WEB_ORIGIN.
  if (!webDistDir) {
    void app.register(fastifyCors, { origin: config.webOrigin, credentials: true });
  }

  app.setErrorHandler((error: FastifyError | ZodError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send(errorBody(error.code, error.message));
    }
    const upstream = upstreamErrorResponse(error);
    if (upstream) {
      request.log.warn({ err: error }, 'upstream request failed');
      return reply.code(upstream.status).send(upstream.body);
    }
    if (error instanceof ZodError) {
      const message = error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(errorBody('validation_error', message));
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // Log the details server side; the client only gets a generic message.
      request.log.error({ err: error }, 'request failed');
      return reply.code(status).send(errorBody('internal_error', 'Internal server error'));
    }
    const code = error.validation ? 'validation_error' : (STATUS_CODES[status] ?? 'bad_request');
    return reply.code(status).send(errorBody(code, error.message));
  });

  app.get('/api/health', (): HealthResponse => {
    return HealthResponseSchema.parse({ status: 'ok', network: config.network, version });
  });

  configRoutes(app, config);

  void app.register(fastifyCookie, { secret: config.sessionSecret });
  if (deps) {
    const { database, ledger } = deps;
    void app.register(sessionPlugin, {
      sessions: new SessionService(database.db),
      roleResolver: createRoleResolver({ reader: ledger.reader, db: database.db }),
    });
    // A child scope: it is loaded after the session plugin, so it sees its hook and decorators.
    void app.register((scope, _options, done) => {
      sessionRoutes(scope, config, deps.session);
      statusRoutes(scope, config, { ledger, pool: database.pool });
      const { modules } = deps;
      if (modules) {
        void scope.register(modules.cycle.routes);
        if (modules.audit) void scope.register(modules.audit.routes);
        treasuryRoutes(scope, { ...modules.treasury, config, ledger, db: database.db });
        agentRoutes(scope, modules.agent);
        eventsRoute(scope, { bus: modules.bus });
      }
      done();
    });
  }

  if (webDistDir) {
    void app.register(fastifyStatic, {
      root: webDistDir,
      setHeaders(reply, path) {
        // SvelteKit fingerprints everything under _app/immutable, so it can be cached forever.
        if (path.includes('/_app/immutable/')) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    // Unknown API routes always get a JSON 404. Other GET requests fall back to the SPA shell
    // when the web app is served, so client-side routes like /treasurer/overview work on reload.
    if (webDistDir && request.method === 'GET' && !isApiPath(request.url)) {
      return reply.sendFile('index.html');
    }
    return sendNotFound(reply, request.method, request.url);
  });

  return app;
}
