import fs from 'fs';

const oldFetch = globalThis.fetch;
globalThis.fetch = async (requestObj, ...args) => {
  if (typeof requestObj === 'string' && requestObj.startsWith('file://')) {
    const url = requestObj;
    console.warn('file fetch fix:', url);
    const buffer = await fs.promises.readFile(url.slice(7));
    return {
      status: 200,
      ok: true,
      headers: { get: () => undefined },
      arrayBuffer: async () => buffer,
    }
  }
  return oldFetch(requestObj, ...args);
};
