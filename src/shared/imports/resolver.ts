/**
 * Source resolution — re-exported from the internal service.
 *
 * This file exists for backward compatibility; new code should
 * import directly from `./services/source-resolver.service.js` or
 * from the barrel `./index.js`.
 */

export { resolveSource, extractRepoName } from './services/source-resolver.service.js';
