import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentPanel from './AgentPanel.svelte';

describe('AgentPanel', () => {
  it('is closed until opened and opens with Ctrl+K', async () => {
    render(AgentPanel);
    expect(screen.queryByRole('dialog')).toBeNull();
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Agent' })).toBeInTheDocument();
  });

  it('opens with Cmd+K too', async () => {
    render(AgentPanel);
    await fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Ask the agent';
    document.body.append(opener);
    opener.focus();

    const { rerender } = render(AgentPanel, { open: false });
    await rerender({ open: true });
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it('keeps Tab inside the panel', async () => {
    render(AgentPanel, { open: true });
    const dialog = await screen.findByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])'),
    );
    const last = focusable[focusable.length - 1];
    const first = focusable[0];
    expect(first && last).toBeTruthy();
    last?.focus();
    await fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first?.focus();
    await fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('sends a suggested prompt as a button press', async () => {
    const onsend = vi.fn();
    render(AgentPanel, { open: true, onsend });
    await fireEvent.click(screen.getByRole('button', { name: 'Why was last cycle flagged?' }));
    expect(onsend).toHaveBeenCalledWith('Why was last cycle flagged?');
  });

  it('sends typed text with Enter and renders tool cards inline', async () => {
    const onsend = vi.fn();
    render(AgentPanel, {
      open: true,
      onsend,
      messages: [
        { id: '1', role: 'user', text: 'Distribute 1,200 CC for September.' },
        {
          id: '2',
          role: 'tool',
          action: {
            id: 'a',
            title: 'Created proposal for September',
            status: 'done',
            summary: '4 payees, 1,200 CC',
          },
        },
      ],
    });
    expect(screen.getByText('Created proposal for September')).toBeInTheDocument();
    const box = screen.getByLabelText('Message to the agent');
    await fireEvent.input(box, { target: { value: 'Hello' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(onsend).toHaveBeenCalledWith('Hello');
  });

  describe('following a link', () => {
    const messages = [
      {
        id: '2',
        role: 'tool' as const,
        action: {
          id: 'a',
          title: 'Created proposal for September',
          status: 'done' as const,
          summary: '4 payees, 1,200 CC',
          href: '/app/cycles/2026-09',
        },
      },
    ];
    // jsdom cannot navigate; the router is not under test here.
    const stopNavigation = (event: Event) => event.preventDefault();
    beforeEach(() => document.addEventListener('click', stopNavigation));
    afterEach(() => document.removeEventListener('click', stopNavigation));

    it('closes the panel when an action card link is followed', async () => {
      const onclose = vi.fn();
      render(AgentPanel, { open: true, messages, onclose });
      await fireEvent.click(screen.getByRole('link', { name: 'Open' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(onclose).toHaveBeenCalledTimes(1);
    });

    it('stays open for a modified click (a new tab) and for buttons', async () => {
      render(AgentPanel, { open: true, messages });
      await fireEvent.click(screen.getByRole('link', { name: 'Open' }), { ctrlKey: true });
      await fireEvent.click(screen.getByRole('button', { name: 'Why was last cycle flagged?' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('disables the prompt box and says why when unavailable', () => {
    render(AgentPanel, { open: true, unavailableReason: 'Not connected yet.' });
    expect(screen.getByLabelText('Message to the agent')).toBeDisabled();
    expect(screen.getByText('Not connected yet.')).toBeInTheDocument();
  });
});
