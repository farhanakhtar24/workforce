/**
 * Public API of @workforce/queue (root). Today: the scheduler bridge — the
 * same surface as `@workforce/queue/scheduler` (future queue packages extend
 * this barrel without breaking `./scheduler` consumers).
 */

export * from './scheduler/index.js';
