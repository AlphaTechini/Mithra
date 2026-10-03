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
  it('retry after a failed send sends the same prompt again and does not reload the conversation', async () => {
    let attempts = 0;
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/agent/messages': { suggestions: [], messages: [] },
      'POST /api/agent/messages': () => {
        attempts += 1;
        return attempts === 1
          ? new Response(
              JSON.stringify({ error: { code: 'agent_failed', message: 'The agent stopped.' } }),
              { status: 500, headers: { 'content-type': 'application/json' } },
            )
          : {
              user: message({ id: 'u1', role: 'user', text: 'Distribute 1,200 CC.' }),
              reply: message({ id: 'a1', text: 'Done.' }),
            };
      },
    });
    await sessionStore.load();
    await agentStore.load();
    await agentStore.send('Distribute 1,200 CC.');
    expect(agentStore.error).not.toBeNull();

    await agentStore.retry();
    expect(api.callsTo('POST /api/agent/messages').map((c) => c.body)).toEqual([
      { text: 'Distribute 1,200 CC.' },
      { text: 'Distribute 1,200 CC.' },
    ]);
    expect(api.callsTo('GET /api/agent/messages')).toHaveLength(1);
    expect(agentStore.error).toBeNull();
    expect(agentStore.messages.map((m) => m.id)).toEqual(['u1', 'a1']);

    // Nothing is left to resend once it worked: the next retry would reload.
    await agentStore.retry();
    expect(api.callsTo('POST /api/agent/messages')).toHaveLength(2);
    expect(api.callsTo('GET /api/agent/messages')).toHaveLength(2);
  });

  it('retry with no failed prompt reloads the conversation, and reset forgets a failed prompt', async () => {
    let fail = true;
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/agent/messages': () =>
        fail
          ? new Response(JSON.stringify({ error: { code: 'internal', message: 'No.' } }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            })
          : { suggestions: [], messages: [] },
      'POST /api/agent/messages': () =>
        new Response(JSON.stringify({ error: { code: 'agent_failed', message: 'Stopped.' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await sessionStore.load();
    await agentStore.load();
    expect(agentStore.error).not.toBeNull();
    fail = false;
    await agentStore.retry();
    expect(agentStore.error).toBeNull();
    expect(api.callsTo('POST /api/agent/messages')).toHaveLength(0);

    await agentStore.send('lost?');
    expect(agentStore.error).not.toBeNull();
    agentStore.reset();
    await agentStore.load();
    await agentStore.retry();
    expect(api.callsTo('POST /api/agent/messages')).toHaveLength(1);
  });

  it('an action for an unknown message is shown only while a send is running', async () => {
    const reply = deferred<unknown>();
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/agent/messages': { suggestions: [], messages: [] },
      'POST /api/agent/messages': () => reply.promise,
    });
    await sessionStore.load();
    await agentStore.load();

    // No send is running: the card would be an orphan, so it is ignored.
    FakeEventSource.latest.emit({ type: 'agent', messageId: 'ghost', action: CARD });
    await Promise.resolve();
    expect(agentStore.rows).toEqual([]);

    const sending = agentStore.send('hello');
    await waitFor(() => expect(agentStore.busy).toBe(true));
    FakeEventSource.latest.emit({ type: 'agent', messageId: 'a1', action: CARD });
    await waitFor(() => expect(agentStore.rows.some((r) => r.role === 'tool')).toBe(true));
    reply.resolve({
      user: message({ id: 'u1', role: 'user', text: 'hello' }),
      reply: message({ id: 'a1', text: 'Done.', actions: [CARD] }),
    });
    await sending;
    expect(agentStore.rows.filter((r) => r.role === 'tool')).toHaveLength(1);

    // Once the send is over, a late event for an unknown message adds nothing.
    FakeEventSource.latest.emit({
      type: 'agent',
      messageId: 'late',
      action: { ...CARD, id: 'act-2' },
    });
    await Promise.resolve();
    expect(agentStore.rows.filter((r) => r.role === 'tool')).toHaveLength(1);
  });
});
