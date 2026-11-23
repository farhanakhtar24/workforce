/**
 * Public API of the Phase 3 memory domain: `@workforce/core/memory`.
 *
 * Pure domain + service only. The Prisma/pgvector adapter is exported ONLY
 * from the `@workforce/core/memory/postgres` subpath, so importing this module
 * never loads Prisma (the CLI stays Prisma-free).
 */

export {
  memoryKinds,
  embeddingStatuses,
  memoryRelationTypes,
  isMemoryKind,
  isEmbeddingStatus,
  isMemoryRelationType,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL,
  COMPACTION_THRESHOLD,
  SEMANTIC_WEIGHT,
  RECENCY_WEIGHT,
  SEMANTIC_SEARCH_CANDIDATE_FETCH_LIMIT,
  type MemoryKind,
  type EmbeddingStatus,
  type MemoryRelationType,
} from './kinds.js';

export { MemoryError, MemoryValidationError, MemoryNotFoundError, MemoryConflictError, MemoryQueueError, MemoryCompactionError, MemoryEmbeddingError, MemoryConfigurationError, type MemoryErrorCode } from './errors.js';

export {
  MAX_MEMORY_PATH_SEGMENTS,
  MAX_MEMORY_PATH_SEGMENT_LENGTH,
  MAX_MEMORY_PATH_LENGTH,
  MAX_SCOPE_LENGTH,
  isValidMemoryPath,
  normalizeMemoryPath,
  normalizeScope,
  isPathWithin,
} from './paths.js';

export type {
  MemoryBlock,
  MemoryRelation,
  MemorySearchResult,
  MemoryRelatedEdge,
  MemoryRelatedResult,
  MemoryMetadata,
} from './types.js';

export { MEMORY_RECENCY_HALF_LIFE_DAYS, recencyDecay, type MemoryDateInput } from './recency.js';

export {
  rankMemoryCandidates,
  clampCosine,
  type MemoryRankCandidate,
  type MemoryRankedCandidate,
} from './ranking.js';

export {
  isBoundedMetadata,
  MAX_METADATA_SERIALIZED_LENGTH,
  memoryIdSchema,
  memoryScopeSchema,
  memoryPathSchema,
  memoryKindSchema,
  memoryContentSchema,
  memoryConfidenceSchema,
  memoryMetadataSchema,
  writeBlockInputSchema,
  queryBlocksInputSchema,
  semanticSearchInputSchema,
  compactPathInputSchema,
  parseMemoryInput,
  type MemoryWriteBlockInput,
  type MemoryQueryBlocksInput,
  type MemorySemanticSearchInput,
  type MemoryCompactPathInput,
  type ParsedWriteBlockInput,
  type ParsedQueryBlocksInput,
  type ParsedSemanticSearchInput,
  type ParsedCompactPathInput,
} from './schemas.js';

export type {
  MemoryStore,
  MemoryStoreTxView,
  MemoryBlockInsert,
  MemoryQueryParams,
  MemoryActiveBlockListOptions,
  MemoryVectorSearchParams,
  MemoryVectorCandidate,
  MemoryEmbeddingReadyUpdate,
  MemoryEmbeddingFailedUpdate,
} from './store.js';

export { MemoryService } from './service.js';
export type {
  EmbeddingProvider,
  MemoryJobQueue,
  MemoryCompactor,
  MemoryLogger,
  MemoryCompactionRequest,
  MemoryCompactionOutcome,
  MemoryEmbeddingOutcome,
  MemoryServiceOptions,
} from './service.js';

export { InMemoryMemoryStore } from './stores/in-memory-memory-store.js';
