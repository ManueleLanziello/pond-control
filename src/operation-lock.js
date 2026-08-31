export function createOperationLock() {
  let tail = Promise.resolve();

  return {
    runExclusive(operation) {
      const result = tail.then(operation, operation);
      tail = result.catch(() => {});
      return result;
    },
  };
}
