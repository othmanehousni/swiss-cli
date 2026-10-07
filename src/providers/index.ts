import { STORE_IDS, type StoreId } from '../normalization/types.js';
import { aldi } from './aldi.js';
import { coop } from './coop.js';
import { denner } from './denner.js';
import { lidl } from './lidl.js';
import { migros } from './migros.js';
import type { Provider } from './types.js';

const PROVIDERS: Record<StoreId, Provider> = { migros, coop, denner, aldi, lidl };

export function getProvider(store: StoreId): Provider {
  return PROVIDERS[store];
}

export function allProviders(): Provider[] {
  return STORE_IDS.map((id) => PROVIDERS[id]);
}
