import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Packs } from './packs.js';
// Only operator configuration imports code. No API or Agent tool accepts module paths.
export async function loadCapabilityPacks() {
  const files = JSON.parse(process.env.GOALLOOP_PACK_MODULES || '[]');
  if (!Array.isArray(files) || files.some((p) => typeof p !== 'string'))
    throw new Error('GOALLOOP_PACK_MODULES must be a JSON array of module paths');
  for (const file of files) {
    const module = await import(pathToFileURL(path.resolve(file)).href);
    if (typeof module.default !== 'function')
      throw new Error(`Pack ${file} must export a default factory`);
    Packs.factories.push(module.default);
  }
}
