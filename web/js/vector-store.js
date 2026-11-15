const DATABASE = 'magicshell-vectors';
const VERSION = 1;
const RECORDS = 'records';
const OWNER_KEY = 'owner';

export function memoryVectorStore() {
  let owner;
  const records = new Map();
  return {
    async claim(nextOwner) {
      if (owner !== nextOwner) records.clear();
      owner = nextOwner;
    },
    async all() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    async put(record) {
      records.set(record.key, structuredClone(record));
    },
    async remove(keys) {
      for (const key of keys) records.delete(key);
    },
    async clear() {
      records.clear();
      owner = undefined;
    },
  };
}

function request(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

function completion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const idbRequest = indexedDB.open(DATABASE, VERSION);
    idbRequest.onupgradeneeded = () => {
      try {
        idbRequest.result.createObjectStore(RECORDS, { keyPath: 'key' });
      } catch (error) {
        failed = true;
        reject(error);
        idbRequest.transaction.abort();
      }
    };
    idbRequest.onsuccess = () => {
      if (failed) {
        idbRequest.result.close();
        return;
      }
      resolve(idbRequest.result);
    };
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

async function write(database, operation) {
  const transaction = database.transaction(RECORDS, 'readwrite');
  const done = completion(transaction);
  try {
    await operation(transaction.objectStore(RECORDS));
  } catch (error) {
    done.catch(() => {});
    throw error;
  }
  await done;
}

function indexedDBVectorStore(database) {
  return {
    async claim(owner) {
      await write(database, async (records) => {
        const stored = await request(records.get(OWNER_KEY));
        if (stored?.owner !== owner) records.clear();
        records.put({ key: OWNER_KEY, owner });
      });
    },
    async all() {
      const transaction = database.transaction(RECORDS, 'readonly');
      const records = await request(transaction.objectStore(RECORDS).getAll());
      return records.filter((record) => record.key !== OWNER_KEY);
    },
    async put(record) {
      await write(database, (records) => records.put(record));
    },
    async remove(keys) {
      await write(database, (records) => {
        for (const key of keys) records.delete(key);
      });
    },
    async clear() {
      await write(database, (records) => records.clear());
    },
  };
}

export async function openVectorStore(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return memoryVectorStore();
  try {
    return indexedDBVectorStore(await openDatabase(indexedDB));
  } catch {
    return memoryVectorStore();
  }
}
