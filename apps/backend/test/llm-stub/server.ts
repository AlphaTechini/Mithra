import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny OpenAI-compatible server for tests: `POST /v1/responses`. Each test scripts the
 * answers in order (tool calls, text, malformed arguments, errors, slow answers); the stub records
 * every request body so tests can assert on what the model was shown. No network access needed.
 * `requests` holds each Responses body translated back to the Chat Completions shape the tests
 * were written against; `rawRequests` holds the body exactly as the client sent it.
 */

export interface StubToolCall {
  name: string;
  /** An object is sent as JSON; a string is sent as it is (to script malformed arguments). */
  arguments: unknown;
  id?: string;
  /** The tool call type; default `function`. Another value scripts a call the client cannot use. */
  type?: string;
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

export interface ResponsesBody {
  model: string;
  input: Record<string, unknown>[];
  tools?: {
    type: string;
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  }[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  store?: boolean;
}

export type StubScript = StubStep | ((request: StubRequest, index: number) => StubStep);

export interface LlmStub {
  /** `http://127.0.0.1:<port>/v1`, for `LLM_BASE_URL`. */
  baseUrl: string;
  port: number;
  /** Every request received, in order, in Chat Completions shape. */
  requests: StubRequest[];
  /** Every request body received, in order, exactly as sent to `/responses`. */
  rawRequests: ResponsesBody[];
  /** Replaces the script; each request consumes one entry. After the end the last entry repeats. */
  script(...steps: StubScript[]): void;
  /** Answers every request with `step` from now on. */
  always(step: StubScript): void;
  close(): Promise<void>;
}

let counter = 0;

function response(
  model: string,
  step: StubStep & ({ text: string } | { toolCalls: StubToolCall[] }),
) {
  const toolCalls = 'toolCalls' in step ? step.toolCalls : [];
  counter += 1;
  const output: unknown[] = [{ id: `rs_stub_${counter}`, type: 'reasoning', summary: [] }];
  if ('text' in step && step.text !== undefined) {
    output.push({
      id: `msg_stub_${counter}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: step.text, annotations: [] }],
    });
  }
  toolCalls.forEach((c, i) => {
    output.push({
      id: `fc_stub_${counter}_${i}`,
      type: c.type ?? 'function_call',
      status: 'completed',
      call_id: c.id ?? `call_${counter}_${i}`,
      name: c.name,
      arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
    });
  });
  return {
    id: `resp_stub_${counter}`,
    object: 'response',
    created_at: 1_700_000_000,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model,
    output,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

/** Maps a Responses body back to the Chat Completions shape the tests assert on. */
function toChatShape(body: ResponsesBody): StubRequest {
  const messages: StubMessage[] = [];
  let open: StubMessage | undefined;
  for (const item of body.input) {
    if (item.type === 'function_call') {
      if (!open) {
        open = { role: 'assistant', content: null, tool_calls: [] };
        messages.push(open);
      }
      open.tool_calls?.push({
        id: String(item.call_id),
        function: { name: String(item.name), arguments: String(item.arguments) },
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      open = undefined;
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id),
        content: String(item.output),
      });
      continue;
    }
    const role = item.role === 'developer' ? 'system' : String(item.role);
    if (role === 'assistant') {
      open = { role, content: String(item.content), tool_calls: [] };
      messages.push(open);
    } else {
      open = undefined;
      messages.push({ role, content: String(item.content) });
    }
  }
  for (const m of messages) if (m.tool_calls?.length === 0) delete m.tool_calls;
  const choice = body.tool_choice as { type?: string; name?: string } | string | undefined;
  return {
    model: body.model,
    messages,
    ...(body.tools
      ? {
          tools: body.tools.map((t) => ({
            type: t.type,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              ...(t.strict ? { strict: true } : {}),
            },
          })),
        }
      : {}),
    ...(choice !== undefined
      ? {
          tool_choice:
            typeof choice === 'string'
              ? choice
              : { type: 'function', function: { name: choice.name } },
        }
      : {}),
    ...(body.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
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
    res.end(
      JSON.stringify({
        id: 'x',
        object: 'response',
        model,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [],
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response(model, step)));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Starts the stub on an ephemeral port. */
export async function startLlmStub(): Promise<LlmStub> {
  const requests: StubRequest[] = [];
  const rawRequests: ResponsesBody[] = [];
  let steps: StubScript[] = [{ text: 'OK' }];
  let served = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const raw = JSON.parse(await readBody(req)) as ResponsesBody;
      const body = toChatShape(raw);
      rawRequests.push(raw);
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
    rawRequests,
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
