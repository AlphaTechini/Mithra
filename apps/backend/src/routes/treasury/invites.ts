import { randomInt } from 'node:crypto';

/**
 * Letters A to Z and digits 2 to 9 without the look-alikes: no I, L or O (they read as 1 and 0),
 * and no 0 or 1. 31 characters, so 8 of them give about 8.5e11 codes.
 */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;

/** A random invite code. `randomInt` draws without modulo bias. */
export function newInviteCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += INVITE_ALPHABET.charAt(random(INVITE_ALPHABET.length));
  }
  return code;
}

/** Normalizes what a person typed or pasted: trims and upper-cases. */
export function normalizeInviteCode(input: string): string {
  return input.trim().toUpperCase();
}

const CODE_SHAPE = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

/** True for a string shaped like an invite code. */
export function isInviteCode(code: string): boolean {
  return CODE_SHAPE.test(code);
}
