/**
 * The project root: the directory above whichever file this is running from.
 *
 * Its own file at this level because the answer depends on WHERE the code doing the
 * asking lives. Bundled, every module shares one `import.meta.url` — `dist/main.mjs` —
 * so `..` is the root from anywhere. Run from source by tsx, each file has its own, and
 * from `src/main/` the same `..` would be `src/`. A module one level down, like this one
 * and like `dist/main.mjs`, is right both ways.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
