import { fileURLToPath } from 'node:url';

/** Directory with the plain SQL migrations. Resolves the same from src/ (tests) and dist/src/ (runtime). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
