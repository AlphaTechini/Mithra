import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@mithra/shared';
import AgentPanel from '$lib/components/AgentPanel.svelte';
import { agentStore, toUiMessages } from './agent.svelte';
import { live } from './live.svelte';
import { sessionStore } from './session.svelte';
import { sessionRoutes } from '../../test/treasury/fixtures';
import {
  FakeEventSource,
  deferred,
  installFakeEventSource,
  stubApi,
} from '../../test/treasury/stub';

const CARD = {
  id: 'act-1',
  tool: 'create_cycle',
  title: 'Created proposal for September, 4 payees, 1,200 CC',
  status: 'done' as const,
  summary: 'Needs 2 of 3 approvals',
  details: [{ label: 'Total', value: '1,200 CC' }],
  link: '/app/cycles/2026-09',
};

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return {
    id: 'm1',
    role: 'assistant',
    text: '',
    actions: [],
    at: '2026-10-01T09:00:00Z',
    degraded: false,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  agentStore.reset();
  installFakeEventSource();
});

afterEach(() => {
  agentStore.reset();
  live.reset();
  vi.unstubAllGlobals();
});

describe('agent conversation', () => {
  it('turns API messages into rows: your text, then each tool call as a card, then the reply', () => {
    const rows = toUiMessages([
      message({ id: 'u1', role: 'user', text: 'Distribute 1,200 CC for September.' }),
      message({ id: 'a1', text: '5,000 CC is your cap. This needs approval.', actions: [CARD] }),
    ]);
    expect(rows.map((r) => r.role)).toEqual(['user', 'tool', 'agent']);
    const tool = rows[1];
    expect(tool?.role === 'tool' && tool.action.href).toBe('/app/cycles/2026-09');
  });

  it('renders action cards inline with their links in the agent panel (A10)', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/agent/messages': {
        suggestions: ['Why was last cycle flagged?'],
        messages: [
          message({ id: 'u1', role: 'user', text: 'Distribute 1,200 CC for September.' }),
          message({ id: 'a1', text: 'I prepared a proposal.', actions: [CARD] }),
        ],
      },
    });
    await sessionStore.load();
    await agentStore.load();
    render(AgentPanel, {
      open: true,
      messages: agentStore.rows,
      suggestions: agentStore.suggestions,
    });

    expect(screen.getByText(CARD.title)).toBeInTheDocument();
    expect(screen.getByText('I prepared a proposal.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/app/cycles/2026-09',
    );
    expect(screen.getByRole('button', { name: 'Why was last cycle flagged?' })).toBeInTheDocument();
    // The card expands to show what the tool did.
    await fireEvent.click(screen.getByRole('button', { name: new RegExp(CARD.title) }));
    expect(screen.getByText('1,200 CC')).toBeInTheDocument();
  });

  it('renders a degraded reply as an error state with its text', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/agent/messages': {
        suggestions: [],
        messages: [
          message({
            id: 'a1',
            degraded: true,
            text: 'The language model is unavailable. I ran the checks, but I can’t write a memo.',
          }),
        ],
      },
    });
    await sessionStore.load();
    await agentStore.load();
    const { container } = render(AgentPanel, { open: true, messages: agentStore.rows });
    const degraded = container.querySelector('[data-degraded="true"]');
    expect(degraded).not.toBeNull();
    expect(
      within(degraded as HTMLElement).getByText(/language model is unavailable/),
    ).toBeInTheDocument();
    expect(
      within(degraded as HTMLElement).getByText('Agent, limited reply:', { exact: false }),
    ).toBeInTheDocument();
  });

  it('shows Working… and live action cards while the reply is on its way', async () => {
    const reply = deferred<unknown>();
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/agent/messages': { suggestions: [], messages: [] },
      'POST /api/agent/messages': () => reply.promise,
    });
    await sessionStore.load();
    await agentStore.load();

    const Harness = AgentPanel;
    const view = render(Harness, {
      open: true,
      messages: agentStore.rows,
      busy: agentStore.busy,
      onsend: (text: string) => void agentStore.send(text),
    });

    await fireEvent.input(screen.getByLabelText('Message to the agent'), {
      target: { value: 'Distribute 1,200 CC for September.' },
    });
    await fireEvent.keyDown(screen.getByLabelText('Message to the agent'), { key: 'Enter' });
    await waitFor(() => expect(agentStore.busy).toBe(true));
    await view.rerender({ open: true, messages: agentStore.rows, busy: agentStore.busy });
    expect(screen.getByText('Working…')).toBeInTheDocument();
    const log = within(screen.getByRole('log'));
    expect(log.getByText('Distribute 1,200 CC for September.')).toBeInTheDocument();

    // The agent's first tool call shows up before its reply.
    FakeEventSource.latest.emit({ type: 'agent', messageId: 'a1', action: CARD });
    await waitFor(() => expect(agentStore.rows.some((r) => r.role === 'tool')).toBe(true));
    await view.rerender({ open: true, messages: agentStore.rows, busy: agentStore.busy });
    expect(screen.getByText(CARD.title)).toBeInTheDocument();

    reply.resolve({
      user: message({ id: 'u1', role: 'user', text: 'Distribute 1,200 CC for September.' }),
      reply: message({ id: 'a1', text: 'Done.', actions: [CARD] }),
    });
    await waitFor(() => expect(agentStore.busy).toBe(false));
    await view.rerender({ open: true, messages: agentStore.rows, busy: agentStore.busy });
    // The final reply replaces the live card: still exactly one.
    expect(screen.getAllByText(CARD.title)).toHaveLength(1);
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.queryByText('Working…')).toBeNull();
    expect(api.callsTo('POST /api/agent/messages')[0]?.body).toEqual({
      text: 'Distribute 1,200 CC for September.',
    });
  });

  it('says what failed when the agent cannot answer', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/agent/messages': { suggestions: [], messages: [] },
      'POST /api/agent/messages': () =>
        new Response(
          JSON.stringify({
            error: { code: 'agent_failed', message: 'The agent stopped. Try again.' },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
    });
    await sessionStore.load();
    await agentStore.load();
    await agentStore.send('hello');
    expect(agentStore.error).toEqual({
      title: "The agent couldn't answer.",
      message: 'The agent stopped. Try again.',
    });
    expect(agentStore.busy).toBe(false);
  });
});
