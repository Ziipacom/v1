import { useCallback, useEffect, useRef } from 'react';

// Async work may finish after navigation, an account switch, or a different
// source selection. A captured guard applies only to its original UI scope.
export function useOperationScope(identity: string, active = true) {
  const state = useRef({ identity, active, mounted: true, version: 0 });
  if (state.current.identity !== identity || state.current.active !== active) {
    state.current = { ...state.current, identity, active, version: state.current.version + 1 };
  }
  useEffect(() => {
    state.current.mounted = true;
    return () => { state.current.mounted = false; state.current.version++; };
  }, []);
  return useCallback(() => {
    const version = state.current.version;
    return () => state.current.mounted && state.current.active && state.current.version === version;
  }, []);
}
