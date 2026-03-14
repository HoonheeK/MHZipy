export const saveToIndexedDB = (id: string, data: Uint8Array | ArrayBuffer) => {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('PDFViewerDB', 1);

    request.onupgradeneeded = (event: any) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files');
      }
    };

    request.onsuccess = (event: any) => {
      const db = event.target.result;
      const transaction = db.transaction(['files'], 'readwrite');
      const store = transaction.objectStore('files');
      const putRequest = store.put(data, id);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };

    request.onerror = () => reject(request.error);
  });
};