/** Result of an operation that can fail in an expected way. Never throw across a message boundary. */
export type Result<T, E extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E extends string>(error: E): Result<never, E> => ({ ok: false, error });
