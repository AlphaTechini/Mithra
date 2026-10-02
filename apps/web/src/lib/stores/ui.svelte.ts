/** Small shell state shared between the layout header and pages: the agent panel. */
const ui = $state({ agentOpen: false });

export const shell = {
  get agentOpen(): boolean {
    return ui.agentOpen;
  },
  set agentOpen(value: boolean) {
    ui.agentOpen = value;
  },
  openAgent(): void {
    ui.agentOpen = true;
  },
};
