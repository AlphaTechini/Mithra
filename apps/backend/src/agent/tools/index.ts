import type { Role } from '@mithra/shared';
import { z } from 'zod';
import type { LlmTool } from '../../llm/client';
import { createCycleTool } from './createCycle';
import { draftPolicyTool, proposeMandateChangeTool } from './draftPolicy';
import { explainProposalTool } from './explainProposal';
import { inviteHolderTool, issueUnitsTool, listHoldersTool } from './holders';
import { closeExpiredGrantsTool, draftAuditScopeTool, getBalanceTool } from './misc';
import { queryHistoryTool } from './queryHistory';
import { runCycleNowTool } from './runCycleNow';
import type { AgentTool } from './types';

export * from './types';

/** Every tool the agent has. Nothing here can sign, approve, grant access or execute a payment. */
export const ALL_TOOLS: readonly AgentTool[] = [
  draftPolicyTool,
  proposeMandateChangeTool,
  listHoldersTool,
  issueUnitsTool,
  inviteHolderTool,
  getBalanceTool,
  createCycleTool,
  runCycleNowTool,
  explainProposalTool,
  queryHistoryTool,
  draftAuditScopeTool,
  closeExpiredGrantsTool,
];

/** The tools a party with `roles` may use. */
export function toolsForRoles(roles: readonly Role[]): AgentTool[] {
  return ALL_TOOLS.filter((t) => t.roles.some((r) => roles.includes(r)));
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Closes every object schema; in strict mode every property is required and optional ones accept null. */
function normalize(node: unknown, strict: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => normalize(n, strict));
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (strict && key === 'default') continue;
    out[key] = normalize(value, strict);
  }
  if (out['type'] === 'object' && isObject(out['properties'])) {
    out['additionalProperties'] = false;
    if (strict) {
      const required = new Set(Array.isArray(out['required']) ? (out['required'] as string[]) : []);
      const properties: JsonObject = {};
      for (const [name, schema] of Object.entries(out['properties'])) {
        properties[name] = required.has(name) ? schema : { anyOf: [schema, { type: 'null' }] };
      }
      out['properties'] = properties;
      out['required'] = Object.keys(properties);
    }
  }
  return out;
}

/** JSON Schema of a tool's Zod parameters, as the model provider wants it. */
export function jsonSchemaOf(tool: AgentTool, strict: boolean): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.parameters, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonObject;
  delete schema['$schema'];
  const normalized = normalize(schema, strict) as JsonObject;
  if (normalized['type'] !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  return normalized;
}

export function llmToolOf(tool: AgentTool, strict: boolean): LlmTool {
  return { name: tool.name, description: tool.description, parameters: jsonSchemaOf(tool, strict) };
}
