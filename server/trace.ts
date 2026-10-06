// Which station and item a provider call belongs to: set where work starts (a request, the cron, the
// queue) and read where the call leaves the Worker (server/usage.ts), without passing it through every layer.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CallContext { owner?: string; itemId?: string }

const context = new AsyncLocalStorage<CallContext>();

export const withCallContext = <T>(value: CallContext, run: () => T): T => context.run(value, run);
export const currentCallContext = (): CallContext => context.getStore() ?? {};
