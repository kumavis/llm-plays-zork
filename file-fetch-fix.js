import fs from 'fs';

const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, ...args) => {
  if (url.startsWith('file://')) {
    console.warn('file fetch fix:', url);
    const buffer = await fs.promises.readFile(url.slice(7));
    return {
      status: 200,
      ok: true,
      headers: { get: () => undefined },
      arrayBuffer: async () => buffer,
    }
  }
  return oldFetch(url, ...args);
};
