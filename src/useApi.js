import { useCallback, useEffect, useState } from 'react';

// Loads data in an effect and exposes reload(). State is only set from the promise callbacks.
export function useApi(fetcher, deps) {
  const [state, setState] = useState({ data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetcher().then(
      (data) => { if (alive) setState({ data, error: null }); },
      (error) => { if (alive) setState((s) => ({ ...s, error })); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass the fetcher's inputs as deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
