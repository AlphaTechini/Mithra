import { z } from 'zod';
import { cycleRunOutcome, cycleStatusesBefore } from './createCycle';
import { messageOf } from './errors';
import { defineTool, failedRun } from './types';

export const runCycleNowTool = defineTool({
  name: 'run_cycle_now',
  description:
    'Start a cycle right now with the policy defaults, the same as the Run cycle now button: the period, record date and amount come from the policy. ' +
    'It prepares a proposal and runs the checks. It does NOT pay anyone by itself and takes no amounts. Use it when the treasurer asks to run the cycle without naming an amount.',
  parameters: z.strictObject({}),
  roles: ['treasurer'],
  async run(_args, ctx) {
    const name = await ctx.names.name(ctx.partyId);
    const before = await cycleStatusesBefore(ctx);
    let started: { cycleId: string };
    try {
      started = await ctx.services.cycles.run({
        trigger: 'manual',
        triggerDetail: `Run cycle now by ${name}`,
        modelFingerprints: ctx.fingerprints,
        actorParty: ctx.partyId,
      });
    } catch (error) {
      return failedRun('run_cycle_now', 'Could not start the cycle', messageOf(error));
    }
    return cycleRunOutcome(
      'run_cycle_now',
      started.cycleId,
      ctx,
      `Started the cycle ${started.cycleId}`,
      before,
    );
  },
});
