import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';
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

function toolChoiceParam(choice: LlmToolChoice): ChatCompletionToolChoiceOption {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
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
      let completion;
      try {
        completion = await client.chat.completions.create({
          model: config.model,
          messages: input.messages,
          ...(tools
            ? {
                tools,
                tool_choice: toolChoiceParam(input.toolChoice ?? 'auto'),
                parallel_tool_calls: false,
              }
            : {}),
        });
      } catch (error) {
        throw new LlmUnavailableError(describeLlmFailure(error, config.timeoutMs), {
          cause: error,
        });
      }
      const raw = completion.choices?.[0]?.message;
      if (!raw) {
        throw new LlmUnavailableError('the model provider returned no answer');
      }
      const toolCalls: LlmToolCall[] = [];
      for (const call of raw.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      const message: LlmAssistantMessage = {
        role: 'assistant',
        content: typeof raw.content === 'string' ? raw.content : null,
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
