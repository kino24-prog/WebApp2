const databaseName = 'gemini-grading-notebook';
const databaseVersion = 1;
const stores = {
  records: 'records',
  usage: 'usage',
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not supported.'));
      return;
    }

    const request = indexedDB.open(databaseName, databaseVersion);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(stores.records)) {
        const records = database.createObjectStore(stores.records, { keyPath: 'id' });
        records.createIndex('updatedAt', 'updatedAt');
      }

      if (!database.objectStoreNames.contains(stores.usage)) {
        database.createObjectStore(stores.usage, { keyPath: 'usageDate' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(storeName, mode, callback) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = callback(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      }),
  );
}

export async function getAllRecords() {
  const records = await runTransaction(stores.records, 'readonly', (store) => store.getAll());
  return records.sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
}

export function saveRecord(record) {
  return runTransaction(stores.records, 'readwrite', (store) => store.put(record));
}

export function deleteRecord(id) {
  return runTransaction(stores.records, 'readwrite', (store) => store.delete(id));
}

export function getUsage(usageDate) {
  return runTransaction(stores.usage, 'readonly', (store) => store.get(usageDate));
}

export function saveUsage(usage) {
  return runTransaction(stores.usage, 'readwrite', (store) => store.put(usage));
}
