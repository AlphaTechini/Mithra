import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { HealthResponseSchema, type HealthResponse } from '@mithra/shared';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { version } from '../package.json';
import type { Config } from './config/env';

/** Body of every API error response. */
export interface ErrorBody {
  error: { code: string; message: string };
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

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function sendNotFound(reply: FastifyReply, method: string, url: string): FastifyReply {
  return reply.code(404).send(errorBody('not_found', `Route ${method} ${url} not found`));
}

function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/api' || path.startsWith('/api/');
}

export function buildApp(config: Config): FastifyInstance {
  const prettyLogs = process.env['NODE_ENV'] !== 'production' && process.stdout.isTTY;
  const app = Fastify({
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
    void app.register(fastifyCors, { origin: config.webOrigin });
  }

  app.setErrorHandler((error: FastifyError | ZodError, request, reply) => {
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
