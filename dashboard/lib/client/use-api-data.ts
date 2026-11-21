'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from './api';

interface State<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
}

/**
 * Loads a BFF path whenever `path` or `deps` change, and cancels the previous request. Previous data stays on
 * screen while the next request runs, so filters and date ranges do not flash empty states.
 */
export function useApiData<T>(path: string | null, deps: readonly unknown[] = []) {
  const [state, setState] = useState<State<T>>({ data: undefined, error: undefined, loading: path !== null });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (path === null) {
      setState({ data: undefined, error: undefined, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ data: previous.data, error: undefined, loading: true }));
    apiFetch<T>(path, { signal: controller.signal }).then(
      (data) => setState({ data, error: undefined, loading: false }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError = error instanceof ApiError ? error : new ApiError('Could not load this data.', 0, 'load_failed');
        setState((previous) => ({ data: previous.data, error: apiError, loading: false }));
      },
    );
    return () => controller.abort();
    // The caller controls the dependency list (mode, filters, revision).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, revision, ...deps]);

  return { ...state, reload };
}
