import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
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

  it('disables the prompt box and says why when unavailable', () => {
    render(AgentPanel, { open: true, unavailableReason: 'Not connected yet.' });
    expect(screen.getByLabelText('Message to the agent')).toBeDisabled();
    expect(screen.getByText('Not connected yet.')).toBeInTheDocument();
  });
});
