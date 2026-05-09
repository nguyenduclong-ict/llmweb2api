import { findEnabledByProvider } from '../models/account';
import type { AccountRecord } from '../models/account';

export function findAvailableAccount(providerName: string): AccountRecord | null {
  return findEnabledByProvider(providerName) ?? null;
}
