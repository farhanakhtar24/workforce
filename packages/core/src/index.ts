/**
 * Public API of @workforce/core: capabilities shared by every Workforce app.
 *
 * `export *` from the memory domain is safe here: the memory barrel is pure
 * (zod only) and carries no Prisma side effects, so CLI consumers of
 * `@workforce/core` never load the generated client. The Prisma/pgvector
 * adapter lives only under `@workforce/core/memory/postgres`.
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
