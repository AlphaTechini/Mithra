# OpenAI SDK tool calling (verified 2026-10-01)

Source: npm `openai@7.25.0` package contents (`resources/chat/completions/completions.d.ts`, `helpers/zod.d.ts`, `package.json`). api.openai.com is blocked from this session, so no live call was made.

## What Mithra uses

```ts
import OpenAI from 'openai'
const client = new OpenAI({ baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, timeout: 30_000, maxRetries: 1 })
const res = await client.chat.completions.create({
  model: env.LLM_MODEL,
  messages,                       // system, user, assistant (with tool_calls), tool
  tools: [{ type: 'function', function: { name, description, parameters /* JSON Schema */, strict: true } }],
  tool_choice: 'auto',
  parallel_tool_calls: false,
})
const msg = res.choices[0].message
for (const call of msg.tool_calls ?? []) {
  if (call.type !== 'function') continue
  const args = schema.safeParse(JSON.parse(call.function.arguments))   // Zod; never trust the model
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
}
```
- `ChatCompletionMessageFunctionToolCall { id, type: 'function', function: { name, arguments: string } }`. The SDK docs warn the model "may hallucinate parameters"; validate in code.
- Request params exist: `tools?: ChatCompletionTool[]`, `tool_choice?`, `parallel_tool_calls?: boolean`.
- Structured output for non-tool answers: `response_format: zodResponseFormat(schema, name)` with `client.chat.completions.parse(...)` (`helpers/zod`). Zod peer range `^3.25 || ^4.0`.
- `zodFunction({ name, parameters, description })` builds strict tools for `.parse()`/`.runTools()`.

**Decision:** Mithra uses a manual loop with `chat.completions.create` and JSON Schema generated from Zod (`z.toJSONSchema`, Zod 4). The manual loop gives one place for guardrails (tool allow-list, per-call validation, fingerprinting every prompt/response, timeout and fail-safe) and works with OpenAI-compatible providers that do not support `.parse()` or `strict`. `strict` is sent only when `LLM_STRICT_TOOLS=true`.

## Fail-safe

Any thrown error (network, 401, 429, timeout) or invalid tool arguments → the agent records an `llm_unavailable` / `llm_invalid_output` event, executes nothing, and the deterministic checks are still computed and shown (A11). Memo field reads "AI review unavailable: <reason>. Deterministic checks below are complete."
