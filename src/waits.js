export function untilAbort(value, signal) {
  const promise = Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Operation cancelled"),
      );
    };
    promise.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
export async function within(value, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(value).then(
        (result) => ({ settled: true, result }),
        (error) => ({ settled: true, error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
