import { z } from 'zod';
import { NetworkSchema } from '../network';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  network: NetworkSchema,
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
