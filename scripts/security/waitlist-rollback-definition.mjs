import { createHash } from 'node:crypto';

// Prepare SQL only; never connect, execute, grant, or restore data. The caller
// must pin the exact reviewed pre-migration definition and preserve its ACL.
export function hardenWaitlistClaimRollback(definition, expectedSha256) {
  if (typeof definition !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) {
    throw new Error('Reviewed definition and SHA-256 required');
  }
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  if (hash(definition) !== expectedSha256) throw new Error('Rollback definition drift');
  if (!definition.startsWith('CREATE OR REPLACE FUNCTION public.claim_waitlist_slot(p_claim_token uuid)\n')) {
    throw new Error('Unexpected rollback function signature');
  }
  const anchor = "SET search_path TO 'public'";
  if (definition.split(anchor).length !== 2 || !definition.includes(' SECURITY DEFINER\n')) {
    throw new Error('Unexpected rollback security configuration');
  }
  let hardened = definition.replace(anchor, "SET search_path TO ''");
  for (const [name, count] of Object.entries({ booking_waitlist_entries: 8, salons: 1, services: 3, staff: 1 })) {
    const pattern = new RegExp(`(?<![a-zA-Z0-9_.])${name}(?![a-zA-Z0-9_])`, 'g');
    if ([...hardened.matchAll(pattern)].length !== count) {
      throw new Error(`Rollback qualification anchor mismatch: ${name}`);
    }
    hardened = hardened.replace(pattern, `public.${name}`);
  }
  return Object.freeze({ definition: hardened, sourceSha256: expectedSha256, hardenedSha256: hash(hardened) });
}
