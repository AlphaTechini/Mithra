import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny OpenAI-compatible server for tests: `POST /v1/chat/completions`. Each test scripts the
 * answers in order (tool calls, text, malformed arguments, errors, slow answers); the stub records
 * every request body so tests can assert on what the model was shown. No network access needed.
 */

export interface StubToolCall {
  name: string;
  /** An object is sent as JSON; a string is sent as it is (to script malformed arguments). */
  arguments: unknown;
  id?: string;
}

export type StubStep =
  | { text: string }
  | { toolCalls: StubToolCall[]; text?: string }
  | { status: number; body?: unknown }
  | { delayMs: number; then: StubStep }
  | { empty: true }
  | { destroy: true };

export interface StubRequest {
  model: string;
  messages: StubMessage[];
  tools?: {
    type: string;
    function: { name: string; description?: string; parameters?: unknown; strict?: boolean };
  }[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
}

export interface StubMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

export type StubScript = StubStep | ((request: StubRequest, index: number) => StubStep);

export interface LlmStub {
  /** `http://127.0.0.1:<port>/v1`, for `LLM_BASE_URL`. */
  baseUrl: string;
  port: number;
  /** Every request body received, in order. */
  requests: StubRequest[];
  /** Replaces the script; each request consumes one entry. After the end the last entry repeats. */
  script(...steps: StubScript[]): void;
  /** Answers every request with `step` from now on. */
  always(step: StubScript): void;
  close(): Promise<void>;
}

let counter = 0;

function completion(
  model: string,
  step: StubStep & ({ text: string } | { toolCalls: StubToolCall[] }),
) {
  const toolCalls = 'toolCalls' in step ? step.toolCalls : [];
  counter += 1;
  return {
    id: `chatcmpl-stub-${counter}`,
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: 'text' in step && step.text !== undefined ? step.text : null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((c, i) => ({
                  id: c.id ?? `call_${counter}_${i}`,
                  type: 'function',
                  function: {
                    name: c.name,
                    arguments:
                      typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
                  },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function respond(
  model: string,
  step: StubStep,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ('delayMs' in step) {
    await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (res.destroyed) return;
    return respond(model, step.then, req, res);
  }
  if ('destroy' in step) {
    req.socket.destroy();
    return;
  }
  if ('status' in step) {
    res.writeHead(step.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(step.body ?? { error: { message: 'stub error', type: 'stub' } }));
    return;
  }
  if ('empty' in step) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model, choices: [] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(completion(model, step)));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Starts the stub on an ephemeral port. */
export async function startLlmStub(): Promise<LlmStub> {
  const requests: StubRequest[] = [];
  let steps: StubScript[] = [{ text: 'OK' }];
  let served = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const body = JSON.parse(await readBody(req)) as StubRequest;
      requests.push(body);
      const index = served;
      served += 1;
      const entry = steps[Math.min(index, steps.length - 1)] ?? { text: 'OK' };
      const step = typeof entry === 'function' ? entry(body, index) : entry;
      await respond(body.model, step, req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    script(...next) {
      steps = next.length > 0 ? next : [{ text: 'OK' }];
      served = 0;
    },
    always(step) {
      steps = [step];
      served = 0;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
