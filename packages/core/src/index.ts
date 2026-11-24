/**
 * Public API of @workforce/core: capabilities shared by every Workforce app.
 *
 * `export *` from the memory, agent-composition, work-doc, delegation, and
 * scheduler barrels is safe here: all five barrels are pure (zod + croner
 * only) and carry no Prisma side effects, so CLI consumers of
 * `@workforce/core` never load the generated client. The Prisma/pgvector/
 * Postgres adapters live only under the dedicated subpaths
 * (`@workforce/core/memory/postgres`, `@workforce/core/work-docs/postgres`,
 * `@workforce/core/delegation/postgres`, `@workforce/core/scheduler/postgres`).
 */

export {
  calculateToolName,
  calculateToolDescription,
  calculateInputSchema,
  calculateParametersSchema,
  executeCalculate,
} from './capabilities/calculate/calculate.js';
export { evaluateArithmetic } from './capabilities/calculate/calculator.js';

export * from './memory/index.js';
export * from './agents/index.js';
export * from './work-docs/index.js';
export * from './delegation/index.js';
export * from './scheduler/index.js';
// Pre-Phase 6 auth foundation (pure helpers only — see src/auth/index.ts).
export * from './auth/index.js';
