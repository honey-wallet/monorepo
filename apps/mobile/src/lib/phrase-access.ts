import { confirmOwner } from '@/lib/auth';
import { draftMnemonic, readPrimaryMnemonic } from '@/lib/vault';

/** The phrase's provenance is fixed for the lifetime of a screen, never a live URL flag. */
export function createPhraseAccess(isDraft: boolean) {
  const draft = isDraft ? draftMnemonic() : undefined;
  let generation = 0;
  return {
    isDraft,
    draft,
    cancel() {
      generation++;
    },
    async read(): Promise<{ phrase: string | null } | null> {
      const current = generation;
      if (!isDraft && !(await confirmOwner('Show your recovery phrase'))) return null;
      if (current !== generation) return null;
      const phrase = isDraft ? (draft ?? null) : await readPrimaryMnemonic();
      return current === generation ? { phrase } : null;
    },
  };
}
