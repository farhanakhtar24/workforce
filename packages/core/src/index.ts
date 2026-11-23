/**
 * Public API of @workforce/core: capabilities shared by every Workforce app.
 *
 * `export *` from the memory, agent-composition, work-doc, and delegation
 * barrels is safe here: all four barrels are pure (zod only) and carry no
 * Prisma side effects, so CLI consumers of `@workforce/core` never load the
 * generated client. The Prisma/pgvector/Postgres adapters live only under the
 * dedicated subpaths (`@workforce/core/memory/postgres`,
 * `@workforce/core/work-docs/postgres`, `@workforce/core/delegation/postgres`).
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
