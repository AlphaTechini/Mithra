import { z } from 'zod';

/** The two networks Mithra runs on, selected by the NETWORK environment variable. */
export const NetworkSchema = z.enum(['localnet', 'mainnet']);
export type Network = z.infer<typeof NetworkSchema>;
