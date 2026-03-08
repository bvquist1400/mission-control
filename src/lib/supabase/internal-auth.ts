const INTERNAL_AUTH_CONTEXT_SYMBOL = Symbol.for('mission-control.internal-auth-context');

type RequestWithInternalAuth<T> = Request & {
  [INTERNAL_AUTH_CONTEXT_SYMBOL]?: T;
};

export { INTERNAL_AUTH_CONTEXT_SYMBOL };

export function readInternalAuthContext<T>(request: Request): T | null {
  const context = (request as RequestWithInternalAuth<T>)[INTERNAL_AUTH_CONTEXT_SYMBOL];
  return context ?? null;
}

export function writeInternalAuthContext<T, TRequest extends Request>(
  request: TRequest,
  context: T
): TRequest {
  (request as RequestWithInternalAuth<T>)[INTERNAL_AUTH_CONTEXT_SYMBOL] = context;
  return request;
}
