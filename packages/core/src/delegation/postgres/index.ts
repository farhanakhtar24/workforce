/**
 * Prisma/Postgres repository for the delegation domain. Exported ONLY from
 * the `@workforce/core/delegation/postgres` subpath: importing this module
 * loads the generated Prisma client, so consumers that don't need Postgres
 * (the CLI, pure domain tests) must use `@workforce/core` or
 * `@workforce/core/delegation` instead.
 *
 * ## Prisma usage
 * The caller constructs the PrismaClient (from `@workforce/core/generated/prisma`
 * or `@prisma/client` configured to the same generated output) and hands it to
 * {@link PrismaDelegationRepository}. All access is the typed Prisma model API;
 * the only raw SQL is one parameterized row-lock probe:
 *
 * - `updateStatus` locks the delegation row FIRST (`SELECT ... FOR UPDATE`),
 *   re-reads the status, and applies the transition table — two concurrent
 *   writers of the same delegation serialize: one transition wins, the stale
 *   one gets a typed `DelegationConflictError`.
 * - `create` relies on the DB-level `childChatId` UNIQUE constraint and maps
 *   the Prisma unique violation (P2002) into `DelegationConflictError`.
 * - `completedAt` is stamped exactly once, at the first terminal write.
 * - `listByParent` orders by createdAt with the id tie-break (see
 *   `../types.js`); pages are bounded by the validated limit.
 *
 * ## Scope with the API layer
 * This repository records hand-offs ONLY: it never creates chats, never
 * touches HTTP/BullMQ, and never talks to agent composition. The API agent
 * owns transport and prompt delivery.
 *
 * ## Ownership
 * `ownerId` is the platform user (Better Auth `User.id`, TEXT) or null for
 * legacy rows. Owner guards/filters match EXACTLY — an expected owner never
 * matches ownerless or other-user rows — and mismatches read as 404/null:
 * no cross-tenant oracle. The authenticated API layer MUST always pass the
 * owner on create and on every owner-scoped read/list/mutation. The claim
 * guard (`expectedFrom`) is untouched: the owner check runs BEFORE the CAS so
 * a wrong owner can never probe statuses.
 */

import { Prisma, PrismaClient } from '@workforce/core/generated/prisma';

import {
  DELEGATION_LIST_LIMIT_MAX,
  delegationIdSchema,
  delegationReadOptionsSchema,
  parseDelegationInput,
  createDelegationInputSchema,
  listDelegationsByParentInputSchema,
  updateDelegationStatusInputSchema,
  type DelegationCreateInput,
  type DelegationListByParentInput,
  type DelegationReadOptions,
  type DelegationUpdateStatusInput,
} from '../schemas.js';
import { canTransitionDelegation, delegationTerminalStatuses, isDelegationStatus } from '../kinds.js';
import {
  DelegationConflictError,
  DelegationNotFoundError,
  DelegationValidationError,
} from '../errors.js';
import { normalizeScope } from '../../memory/paths.js';
import type { DelegationRepository } from '../repository.js';
import type { Delegation } from '../types.js';

type RowDelegation = Prisma.DelegationGetPayload<object>;

function mapDelegation(row: RowDelegation): Delegation {
  return {
    id: row.id,
    scope: row.scope,
    parentChatId: row.parentChatId,
    childChatId: row.childChatId,
    parentMessageId: row.parentMessageId,
    targetAgent: row.targetAgent,
    mode: row.mode,
    status: row.status,
    task: row.task,
    result: row.result,
    error: row.error,
    depth: row.depth,
    // Normalizes absent fields too (fake rows in tests): never `undefined`.
    ownerId: row.ownerId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function asConflictOrOriginal(cause: unknown, message: string): unknown {
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
    return new DelegationConflictError(message, { cause });
  }
  return cause;
}

/**
 * Map a raced P2025 (row vanished between the locked re-read and the write)
 * into the SAME typed 404 the in-memory repository produces for a missing
 * row — identical semantics across adapters.
 */
function asNotFoundOrOriginal(cause: unknown, message: string): unknown {
  if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2025') {
    return new DelegationNotFoundError(message, { cause });
  }
  return cause;
}

/** Validate the owner guard on read options (`get`/`getByChild`). */
function parseReadOptions(options?: DelegationReadOptions): { expectedOwnerId: string | null } {
  const parsed = parseDelegationInput(delegationReadOptionsSchema, options ?? {});
  return { expectedOwnerId: parsed.expectedOwnerId ?? null };
}

export class PrismaDelegationRepository implements DelegationRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    if (!prisma) {
      throw new DelegationValidationError('PrismaDelegationRepository requires an explicit PrismaClient');
    }
    this.prisma = prisma;
  }

  async create(input: DelegationCreateInput): Promise<Delegation> {
    const parsed = parseDelegationInput(createDelegationInputSchema, input);
    const scope = normalizeScope(parsed.scope);

    try {
      const row = await this.prisma.delegation.create({
        data: {
          ...(parsed.id !== undefined ? { id: parsed.id } : {}),
          scope,
          parentChatId: parsed.parentChatId,
          childChatId: parsed.childChatId,
          parentMessageId: parsed.parentMessageId,
          targetAgent: parsed.targetAgent,
          mode: parsed.mode,
          status: 'pending',
          task: parsed.task,
          depth: parsed.depth,
          ownerId: parsed.ownerId ?? null,
          ...(parsed.createdAt !== undefined
            ? { createdAt: parsed.createdAt instanceof Date ? parsed.createdAt : new Date(parsed.createdAt) }
            : {}),
        },
      });
      return mapDelegation(row);
    } catch (cause) {
      throw asConflictOrOriginal(
        cause,
        `child chat ${parsed.childChatId} is already delegated`,
      );
    }
  }

  async get(id: string, options?: DelegationReadOptions): Promise<Delegation | null> {
    const parsedId = delegationIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw new DelegationValidationError('delegation id must be a valid UUID');
    }
    const parsedOptions = parseReadOptions(options);
    const row = await this.prisma.delegation.findUnique({ where: { id } });
    if (!row) {
      return null;
    }
    // Owner guard: foreign/ownerless rows read as absent — never an oracle.
    if (parsedOptions.expectedOwnerId !== null && (row.ownerId ?? null) !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return mapDelegation(row);
  }

  async listByParent(input: DelegationListByParentInput): Promise<readonly Delegation[]> {
    const parsed = parseDelegationInput(listDelegationsByParentInputSchema, input);
    if (parsed.limit > DELEGATION_LIST_LIMIT_MAX) {
      throw new DelegationValidationError(`list limit must be <= ${DELEGATION_LIST_LIMIT_MAX}`);
    }
    const rows = await this.prisma.delegation.findMany({
      where: {
        parentChatId: parsed.parentChatId,
        ...(parsed.ownerId !== undefined ? { ownerId: parsed.ownerId } : {}),
      },
      orderBy: parsed.order === 'newest'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'asc' }, { id: 'asc' }],
      take: parsed.limit,
    });
    return rows.map((row) => mapDelegation(row));
  }

  async getByChild(childChatId: string, options?: DelegationReadOptions): Promise<Delegation | null> {
    const parsedChild = validateChildChatId(childChatId);
    const parsedOptions = parseReadOptions(options);
    const row = await this.prisma.delegation.findUnique({ where: { childChatId: parsedChild } });
    if (!row) {
      return null;
    }
    if (parsedOptions.expectedOwnerId !== null && (row.ownerId ?? null) !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return mapDelegation(row);
  }

  async updateStatus(input: DelegationUpdateStatusInput): Promise<Delegation> {
    const parsed = parseDelegationInput(updateDelegationStatusInputSchema, input);
    if (!isDelegationStatus(parsed.status)) {
      throw new DelegationValidationError(
        'delegation status must be one of pending, running, completed, failed, timeout',
      );
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent status writers on the delegation row.
        await tx.$queryRaw`SELECT "id" FROM "Delegation" WHERE "id" = ${parsed.id}::uuid FOR UPDATE`;
        const row = await tx.delegation.findUnique({ where: { id: parsed.id } });
        if (!row) {
          throw new DelegationNotFoundError(`delegation ${parsed.id} not found`);
        }
        // Owner guard FIRST: a wrong owner reads as 404 (no status/existence
        // oracle); ownerless legacy rows never satisfy any expected owner.
        if (parsed.expectedOwnerId !== undefined && (row.ownerId ?? null) !== parsed.expectedOwnerId) {
          throw new DelegationNotFoundError(`delegation ${parsed.id} not found for owner`);
        }
        // Atomic claim guard: the row lock above serializes concurrent writers,
        // so this compare-and-set is linearizable — exactly one candidate for
        // `expectedFrom: 'pending'` wins; every loser gets a typed conflict.
        if (parsed.expectedFrom !== undefined && row.status !== parsed.expectedFrom) {
          throw new DelegationConflictError(
            `delegation ${parsed.id} was expected to be ${parsed.expectedFrom} but is ${row.status}`,
          );
        }
        if (!canTransitionDelegation(row.status, parsed.status)) {
          throw new DelegationConflictError(
            `delegation ${parsed.id} cannot move from ${row.status} to ${parsed.status}`,
          );
        }

        const now = new Date();
        const firstTerminal = (delegationTerminalStatuses as readonly string[]).includes(parsed.status) &&
          row.completedAt === null;
        const updated = await tx.delegation.update({
          where: { id: parsed.id },
          data: {
            status: parsed.status,
            result: parsed.result ?? row.result,
            error: parsed.error ?? row.error,
            updatedAt: now,
            ...(firstTerminal ? { completedAt: now } : {}),
          },
        });
        return mapDelegation(updated);
      });
    } catch (cause) {
      throw asNotFoundOrOriginal(
        asConflictOrOriginal(cause, `delegation ${parsed.id} concurrent status write conflict`),
        `delegation ${parsed.id} not found`,
      );
    }
  }
}

/** Factory kept for symmetry with the work-docs adapter. */
export function createPrismaDelegationRepository(prisma: PrismaClient): PrismaDelegationRepository {
  return new PrismaDelegationRepository(prisma);
}

function validateChildChatId(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new DelegationValidationError('childChatId must be a 1..128 character identifier');
  }
  return value;
}
