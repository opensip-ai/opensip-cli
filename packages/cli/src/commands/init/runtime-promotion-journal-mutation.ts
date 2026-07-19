import { createHash } from 'node:crypto';

export type JournalObservedRecord =
  | { readonly status: 'absent' }
  | {
      readonly status: 'present';
      readonly content: string;
      readonly sha256: string;
    };

export type JournalMutation =
  | { readonly operation: 'create'; readonly content: string }
  | {
      readonly operation: 'replace';
      readonly content: string;
      readonly expectedContentSha256: string;
    }
  | { readonly operation: 'unlink'; readonly expectedContentSha256: string };

type MutationCheckpoint =
  | 'after-create-mutation'
  | 'after-replace-mutation'
  | 'after-unlink-mutation'
  | 'before-ambiguity-reconciliation'
  | 'after-reconciliation-mutation';

interface JournalMutationCoordinatorDependencies {
  readonly read: () => Promise<JournalObservedRecord>;
  readonly mutate: (mutation: JournalMutation) => Promise<unknown>;
  readonly checkpoint?: (checkpoint: MutationCheckpoint) => void;
  readonly recoveryRequired: (message: string, cause?: unknown) => Error;
}

export interface JournalMutationCoordinator {
  readonly mutateContent: <T>(
    mutation: Extract<JournalMutation, { operation: 'create' | 'replace' }>,
    previousContent: string | undefined,
    desiredContent: string,
    verifyDesired: (desiredContent: string) => Promise<T>,
  ) => Promise<T>;
  readonly unlinkClosed: (
    mutation: Extract<JournalMutation, { operation: 'unlink' }>,
    expectedContent: string,
  ) => Promise<void>;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function isExactJournalContent(
  observed: JournalObservedRecord,
  expected: string,
): observed is Extract<JournalObservedRecord, { status: 'present' }> {
  return (
    observed.status === 'present' &&
    observed.content === expected &&
    observed.sha256 === sha256(expected)
  );
}

export function createJournalMutationCoordinator(
  dependencies: JournalMutationCoordinatorDependencies,
): JournalMutationCoordinator {
  /** @throws {SystemError} When an ambiguous content mutation cannot be reconciled safely. */
  async function retryContentMutation(
    mutation: Extract<JournalMutation, { operation: 'create' | 'replace' }>,
    previousContent: string | undefined,
    desiredContent: string,
    firstError: unknown,
  ): Promise<void> {
    dependencies.checkpoint?.('before-ambiguity-reconciliation');
    let observed: JournalObservedRecord;
    try {
      observed = await dependencies.read();
    } catch (error) {
      throw dependencies.recoveryRequired('The promotion journal could not be reconciled.', error);
    }
    let retry: JournalMutation;
    if (isExactJournalContent(observed, desiredContent)) {
      retry = {
        operation: 'replace',
        content: desiredContent,
        expectedContentSha256: observed.sha256,
      };
    } else if (mutation.operation === 'create' && observed.status === 'absent') {
      retry = mutation;
    } else if (
      mutation.operation === 'replace' &&
      previousContent !== undefined &&
      isExactJournalContent(observed, previousContent)
    ) {
      retry = mutation;
    } else {
      throw dependencies.recoveryRequired(
        'The promotion journal contains unrelated bytes after a failed mutation.',
        firstError,
      );
    }
    try {
      await dependencies.mutate(retry);
      dependencies.checkpoint?.('after-reconciliation-mutation');
    } catch (error) {
      throw dependencies.recoveryRequired(
        'The promotion journal reconciliation retry failed.',
        error,
      );
    }
  }

  const coordinator: JournalMutationCoordinator = {
    mutateContent: async (mutation, previousContent, desiredContent, verifyDesired) => {
      try {
        await dependencies.mutate(mutation);
        dependencies.checkpoint?.(
          mutation.operation === 'create' ? 'after-create-mutation' : 'after-replace-mutation',
        );
      } catch (error) {
        await retryContentMutation(mutation, previousContent, desiredContent, error);
      }
      return verifyDesired(desiredContent);
    },
    /** @throws {SystemError} When a closed-journal unlink cannot be reconciled or verified. */
    unlinkClosed: async (mutation, expectedContent) => {
      try {
        await dependencies.mutate(mutation);
        dependencies.checkpoint?.('after-unlink-mutation');
      } catch (firstError) {
        dependencies.checkpoint?.('before-ambiguity-reconciliation');
        let observed: JournalObservedRecord;
        try {
          observed = await dependencies.read();
        } catch (error) {
          throw dependencies.recoveryRequired(
            'The closed journal unlink could not be reconciled.',
            error,
          );
        }
        if (observed.status !== 'absent' && !isExactJournalContent(observed, expectedContent)) {
          throw dependencies.recoveryRequired(
            'The closed journal contains unrelated bytes after unlink failure.',
            firstError,
          );
        }
        try {
          await dependencies.mutate(mutation);
          dependencies.checkpoint?.('after-reconciliation-mutation');
        } catch (error) {
          throw dependencies.recoveryRequired('The closed journal unlink retry failed.', error);
        }
      }
      let observed: JournalObservedRecord;
      try {
        observed = await dependencies.read();
      } catch (error) {
        throw dependencies.recoveryRequired(
          'The closed journal unlink could not be verified.',
          error,
        );
      }
      if (observed.status !== 'absent') {
        throw dependencies.recoveryRequired('The closed journal remains after unlink.');
      }
    },
  };
  return Object.freeze(coordinator);
}
