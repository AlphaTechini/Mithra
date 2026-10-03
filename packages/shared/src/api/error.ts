import { z } from 'zod';

/** Body of every API error response. `message` says what happened and what to do next. */
export const ApiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
