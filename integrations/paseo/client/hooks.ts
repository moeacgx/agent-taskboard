import { useCallback, useEffect, useState } from "react";

type AsyncFn<TInput, TOutput> = (input: TInput) => Promise<TOutput>;

interface RpcQueryState<TOutput> {
  data: TOutput | null;
  loading: boolean;
  error: string | null;
}

/**
 * Small local replacement for a data-fetching library: calls an RPC function
 * (as returned by `useRpc(contract)`) whenever `input` changes, tracks
 * loading/error, and exposes `refetch` for use after a mutation.
 */
export function useRpcQuery<TInput, TOutput>(
  call: AsyncFn<TInput, TOutput>,
  input: TInput,
  options: { enabled?: boolean } = {},
): RpcQueryState<TOutput> & { refetch: () => void } {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<RpcQueryState<TOutput>>({
    data: null,
    loading: enabled,
    error: null,
  });
  const [generation, setGeneration] = useState(0);
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((previous) => ({ data: previous.data, loading: true, error: null }));
    call(JSON.parse(inputKey) as TInput)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ data: null, loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
    // `call` is intentionally excluded: useRpc() returns a fresh function each
    // render, and inputKey already captures every value that should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, generation, enabled]);

  const refetch = useCallback(() => setGeneration((value) => value + 1), []);
  return { ...state, refetch };
}
