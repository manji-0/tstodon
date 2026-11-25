import { useMemo, useCallback } from 'react';

import { useLocation, useNavigate } from 'react-router';

export function useSearchParams() {
  const { search } = useLocation();

  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useSearchParam(name: string, defaultValue?: string) {
  const searchParams = useSearchParams();
  const navigate = useNavigate();

  const value = searchParams.get(name) ?? defaultValue;

  const setValue = useCallback(
    (value: string | null) => {
      if (value === null) {
        searchParams.delete(name);
      } else {
        searchParams.set(name, value);
      }

      void navigate({ search: searchParams.toString() });
    },
    [navigate, name, searchParams],
  );

  return [value, setValue] as const;
}
