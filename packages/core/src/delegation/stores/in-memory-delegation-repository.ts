/**
 * {@link DelegationRepository} implementation for fast unit tests — same
 * contract, typed errors, and ordering guarantees as the Prisma adapter,
 * backed by plain Maps.
 *
 * Concurrency model (mirrors `InMemoryMemoryStore`): JavaScript is
 * single-threaded and every write runs without an intervening `await` between
 * check and mutation, so the transition check + write is atomic and two
 * concurrent status writes serialize deterministically.
 */

import { randomUUID } from 'node:crypto';

import {
  DELEGATION_LIST_LIMIT_MAX,
  DELEGATION_MAX_EXTERNAL_ID_LENGTH,
  createDelegationInputSchema,
  delegationDepthSchema,
  listDelegationsByParentInputSchema,
  parseDelegationInput,
  updateDelegationStatusInputSchema,
  delegationReadOptionsSchema,
  type DelegationCreateInput,
  type DelegationListByParentInput,
  type DelegationReadOptions,
  type DelegationUpdateStatusInput,
} from '../schemas.js';
import {
  canTransitionDelegation,
  delegationTerminalStatuses,
  isDelegationMode,
  isDelegationStatus,
  isDelegationTargetAgent,
  type DelegationStatus,
} from '../kinds.js';
import {
  DelegationConflictError,
  DelegationNotFoundError,
  DelegationValidationError,
} from '../errors.js';
import { normalizeScope } from '../../memory/paths.js';
import type { DelegationRepository } from '../repository.js';
import type { Delegation } from '../types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function toIso(): string {
  return new Date().toISOString();
}

function validateExternalId(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DelegationValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > DELEGATION_MAX_EXTERNAL_ID_LENGTH) {
    throw new DelegationValidationError(`${label} must be at most ${DELEGATION_MAX_EXTERNAL_ID_LENGTH} characters`);
  }
}

export class InMemoryDelegationRepository implements DelegationRepository {
  private readonly delegations = new Map<string, Delegation>();
  private readonly childIndex = new Map<string, string>();

  async create(input: DelegationCreateInput): Promise<Delegation> {
    return this.createSync(input);
  }

  private createSync(input: DelegationCreateInput): Delegation {
    // Defense in depth: re-validate the full parsed shape.
    const parsed = parseDelegationInput(createDelegationInputSchema, input);
    const scope = normalizeScope(parsed.scope);
    validateExternalId(parsed.parentChatId, 'parentChatId');
    validateExternalId(parsed.childChatId, 'childChatId');
    validateExternalId(parsed.parentMessageId, 'parentMessageId');
    if (!isDelegationTargetAgent(parsed.targetAgent)) {
      throw new DelegationValidationError('delegation targetAgent must be analyst or researcher');
    }
    if (!isDelegationMode(parsed.mode)) {
      throw new DelegationValidationError('delegation mode must be sync or async');
    }
    parseDelegationInput(delegationDepthSchema, parsed.depth);

    const existingChild = this.childIndex.get(parsed.childChatId);
    if (existingChild !== undefined) {
      throw new DelegationConflictError(
        `child chat ${parsed.childChatId} is already delegated (delegation ${existingChild})`,
      );
    }

    const id = parsed.id ?? randomUUID();
    if (this.delegations.has(id)) {
      throw new DelegationConflictError(`delegation ${id} already exists`);
    }

    let createdAtIso = toIso();
    if (parsed.createdAt !== undefined) {
      const asDate = parsed.createdAt instanceof Date ? parsed.createdAt : new Date(parsed.createdAt);
      if (!Number.isFinite(asDate.getTime())) {
        throw new DelegationValidationError('createdAt must be a valid date or ISO string');
      }
      createdAtIso = asDate.toISOString();
    }
    const delegation: Delegation = {
      id,
      scope,
      parentChatId: parsed.parentChatId,
      childChatId: parsed.childChatId,
      parentMessageId: parsed.parentMessageId,
      targetAgent: parsed.targetAgent,
      mode: parsed.mode,
      status: 'pending',
      task: parsed.task,
      result: null,
      error: null,
      depth: parsed.depth,
      ownerId: parsed.ownerId ?? null,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
      completedAt: null,
    };

    // Atomic in one synchronous section.
    this.delegations.set(id, delegation);
    this.childIndex.set(parsed.childChatId, id);
    return clone(delegation);
  }

  async get(id: string, options?: DelegationReadOptions): Promise<Delegation | null> {
    const parsedOptions = parseDelegationInput(delegationReadOptionsSchema, options ?? {});
    const delegation = this.delegations.get(id);
    if (!delegation) {
      return null;
    }
    // Owner guard: foreign/ownerless rows read as absent — never an oracle.
    if (parsedOptions.expectedOwnerId !== undefined && delegation.ownerId !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return clone(delegation);
  }

  async listByParent(input: DelegationListByParentInput): Promise<readonly Delegation[]> {
    const parsed = parseDelegationInput(listDelegationsByParentInputSchema, input);
    validateExternalId(parsed.parentChatId, 'parentChatId');
    if (parsed.limit > DELEGATION_LIST_LIMIT_MAX || !Number.isInteger(parsed.limit)) {
      throw new DelegationValidationError(`list limit must be an integer <= ${DELEGATION_LIST_LIMIT_MAX}`);
    }

    const matches = [...this.delegations.values()]
      .filter((delegation) => {
        if (delegation.parentChatId !== parsed.parentChatId) {
          return false;
        }
        if (parsed.ownerId !== undefined && delegation.ownerId !== parsed.ownerId) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aMs = Date.parse(a.createdAt);
        const bMs = Date.parse(b.createdAt);
        if (aMs !== bMs) {
          return parsed.order === 'newest' ? bMs - aMs : aMs - bMs;
        }
        if (a.id !== b.id) {
          return parsed.order === 'newest' ? (a.id > b.id ? -1 : 1) : a.id < b.id ? -1 : 1;
        }
        return 0;
      })
      .slice(0, parsed.limit);

    return matches.map((delegation) => clone(delegation));
  }

  async getByChild(childChatId: string, options?: DelegationReadOptions): Promise<Delegation | null> {
    validateExternalId(childChatId, 'childChatId');
    const parsedOptions = parseDelegationInput(delegationReadOptionsSchema, options ?? {});
    const id = this.childIndex.get(childChatId);
    if (id === undefined) {
      return null;
    }
    const delegation = this.delegations.get(id);
    if (!delegation) {
      return null;
    }
    if (parsedOptions.expectedOwnerId !== undefined && delegation.ownerId !== parsedOptions.expectedOwnerId) {
      return null;
    }
    return clone(delegation);
  }

  async updateStatus(input: DelegationUpdateStatusInput): Promise<Delegation> {
    return this.updateStatusSync(input);
  }

  private updateStatusSync(input: DelegationUpdateStatusInput): Delegation {
    return this.applyStatus(parseDelegationInput(updateDelegationStatusInputSchema, input));
  }

  private applyStatus(parsed: {
    id: string;
    status: DelegationStatus;
    result?: string;
    error?: string;
    expectedFrom?: DelegationStatus;
    expectedOwnerId?: string;
  }): Delegation {
    if (!isDelegationStatus(parsed.status)) {
      throw new DelegationValidationError('delegation status must be one of pending, running, completed, failed, timeout');
    }

    const delegation = this.delegations.get(parsed.id);
    if (!delegation) {
      throw new DelegationNotFoundError(`delegation ${parsed.id} not found`);
    }
    // Owner guard FIRST: a wrong owner reads as 404 (no status/existence
    // oracle). Ownerless legacy rows never satisfy any expected owner.
    if (parsed.expectedOwnerId !== undefined && delegation.ownerId !== parsed.expectedOwnerId) {
      throw new DelegationNotFoundError(`delegation ${parsed.id} not found for owner`);
    }
    // Atomic claim guard: one synchronous compare-and-set (single-threaded
    // event loop, no await between check and write) — exactly one concurrent
    // candidate wins the transition, every other loser gets a typed conflict.
    if (parsed.expectedFrom !== undefined && delegation.status !== parsed.expectedFrom) {
      throw new DelegationConflictError(
        `delegation ${parsed.id} was expected to be ${parsed.expectedFrom} but is ${delegation.status}`,
      );
    }
    if (!canTransitionDelegation(delegation.status, parsed.status)) {
      throw new DelegationConflictError(
        `delegation ${parsed.id} cannot move from ${delegation.status} to ${parsed.status}`,
      );
    }

    const nowIso = toIso();
    const becameTerminal = (delegationTerminalStatuses as readonly string[]).includes(parsed.status) &&
      delegation.status !== parsed.status;
    const updated: Delegation = {
      ...delegation,
      status: parsed.status,
      result: parsed.result ?? delegation.result,
      error: parsed.error ?? delegation.error,
      updatedAt: nowIso,
      completedAt: becameTerminal && delegation.completedAt === null ? nowIso : delegation.completedAt,
    };

    this.delegations.set(parsed.id, updated);
    return clone(updated);
  }
}
