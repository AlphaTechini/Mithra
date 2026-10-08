import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';
import { fingerprintOf } from './fingerprint';

/**
 * The only module that talks to the language model (T5). Everything else gets an `Llm`, so tests
 * can hand in a stub and the rest of the code never sees a provider error.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Send `strict: true` on function tools. Default false (many compatible providers reject it). */
  strictTools?: boolean;
  /** Retries of the SDK on transient errors. Default 1. */
  maxRetries?: number;
}

export type LlmMessage = ChatCompletionMessageParam;

/** A function the model may call. `parameters` is a JSON Schema object. */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LlmToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface LlmChatInput {
  messages: LlmMessage[];
  tools?: LlmTool[];
  toolChoice?: LlmToolChoice;
  /** What the call is for, e.g. "agent.chat" or "memo". Logged by callers, never sent to the model. */
  purpose: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** The raw JSON text the model produced. Never trusted: callers validate it with Zod. */
  arguments: string;
}

export interface LlmAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
}

export interface LlmTurn {
  message: LlmAssistantMessage;
  toolCalls: LlmToolCall[];
  /** SHA-256 of the canonical JSON of the request body (model, messages, tools). */
  requestFingerprint: string;
  /** SHA-256 of the canonical JSON of the response message. */
  responseFingerprint: string;
}

export interface Llm {
  chat(input: LlmChatInput): Promise<LlmTurn>;
}

/** The model could not be used: the call failed, timed out or answered nothing. Fail safe (A11). */
export class LlmUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(`The language model is unavailable: ${reason}`, options);
    this.name = 'LlmUnavailableError';
    this.reason = reason;
  }
}

/** The model answered, but not in the shape the caller needs (wrong tool, bad arguments). */
export class LlmInvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmInvalidOutputError';
  }
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

/** A short, plain reason for a failed model call. */
export function describeLlmFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return `timed out after ${seconds(timeoutMs)} s`;
  }
  if (error instanceof OpenAI.APIConnectionError) return 'model provider unreachable';
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    return `${error.status} from the model provider`;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return `timed out after ${seconds(timeoutMs)} s`;
  }
  return 'model provider unreachable';
}

// Chat Completions shape, kept only so request fingerprints stay stable across the API switch.
function toolDefinitions(tools: LlmTool[], strict: boolean): ChatCompletionTool[] {
  return tools.map((t): ChatCompletionTool => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(strict ? { strict: true } : {}),
    },
  }));
}

/** The Responses API wants `strict` set explicitly on every function tool. */
function responseTools(tools: LlmTool[], strict: boolean): FunctionTool[] {
  return tools.map((t): FunctionTool => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict,
  }));
}

function toolChoiceParam(choice: LlmToolChoice): ToolChoiceOptions | ToolChoiceFunction {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}

/** Message content arrives as a string or as parts; only text parts can be forwarded. */
function textOf(content: unknown, role: string): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => {
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        throw new LlmInvalidOutputError(
          `A ${role} message has a "${String(part.type)}" content part; only text is supported.`,
        );
      })
      .join('');
  }
  throw new LlmInvalidOutputError(`A ${role} message has content that is not text.`);
}

/** Chat Completions history in, Responses input items out. Order is kept. */
function responseInput(messages: LlmMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
      case 'developer':
        items.push({ role: 'developer', content: textOf(m.content, m.role) });
        break;
      case 'user':
        items.push({ role: 'user', content: textOf(m.content, m.role) });
        break;
      case 'assistant': {
        const text = textOf(m.content, m.role);
        if (text !== '') items.push({ role: 'assistant', content: text });
        for (const call of m.tool_calls ?? []) {
          if (call.type !== 'function') {
            throw new LlmInvalidOutputError(
              `The history holds a tool call of type "${String(call.type)}"; only function calls are supported.`,
            );
          }
          items.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      }
      case 'tool':
        items.push({
          type: 'function_call_output',
          call_id: m.tool_call_id,
          output: textOf(m.content, m.role),
        });
        break;
      default:
        throw new LlmInvalidOutputError(`A "${m.role}" message cannot be sent to the model.`);
    }
  }
  return items;
}

/** Collects the text and function calls of a response; any other tool item is refused. */
function readOutput(response: Response): { text: string; toolCalls: LlmToolCall[] } {
  const texts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') texts.push(part.text);
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type !== 'reasoning') {
      // Dropping it silently would look like "the model called no tool".
      throw new LlmInvalidOutputError(
        `The model made a tool call of type "${String(item.type)}"; only function calls are supported.`,
      );
    }
  }
  return { text: texts.join(''), toolCalls };
}

export function createLlm(config: LlmConfig): Llm {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries ?? 1,
  });
  const strict = config.strictTools ?? false;

  return {
    async chat(input: LlmChatInput): Promise<LlmTurn> {
      const tools =
        input.tools && input.tools.length > 0 ? toolDefinitions(input.tools, strict) : undefined;
      // The fingerprint covers what the model is shown: model, messages and tools.
      const requestFingerprint = fingerprintOf({
        model: config.model,
        messages: input.messages,
        tools: tools ?? [],
      });
      let response: Response;
      try {
        response = await client.responses.create({
          model: config.model,
          input: responseInput(input.messages),
          store: false,
          ...(tools
            ? {
                tools: responseTools(input.tools ?? [], strict),
                tool_choice: toolChoiceParam(input.toolChoice ?? 'auto'),
                parallel_tool_calls: false,
              }
            : {}),
        });
      } catch (error) {
        // The reason shown to people is short; the provider's own text says what it rejected.
        if (error instanceof OpenAI.APIError) {
          console.error(
            `[mithra-llm] ${input.purpose} (${config.model}) failed: ${error.message.slice(0, 500)}`,
          );
        }
        throw new LlmUnavailableError(describeLlmFailure(error, config.timeoutMs), {
          cause: error,
        });
      }
      if (response.error) {
        console.error(
          `[mithra-llm] ${input.purpose} (${config.model}) failed: ${response.error.message.slice(0, 500)}`,
        );
        throw new LlmUnavailableError('the model provider reported an error');
      }
      if (response.status === 'incomplete' || response.status === 'failed') {
        const why = response.incomplete_details?.reason;
        throw new LlmUnavailableError(
          `the model answer was ${response.status}${why ? ` (${why})` : ''}`,
        );
      }
      const { text, toolCalls } = readOutput(response);
      if (text === '' && toolCalls.length === 0) {
        throw new LlmUnavailableError('the model provider returned no answer');
      }
      const message: LlmAssistantMessage = {
        role: 'assistant',
        content: text === '' ? null : text,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
      return {
        message,
        toolCalls,
        requestFingerprint,
        responseFingerprint: fingerprintOf(message),
      };
    },
  };
}
