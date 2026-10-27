import { STORE_IDS, type StoreId } from '../normalization/types.js';
import { aldi } from './aldi.js';
import { coop } from './coop.js';
import { denner } from './denner.js';
import { ikea } from './ikea.js';
import { landi } from './landi.js';
import { lidl } from './lidl.js';
import { migros } from './migros.js';
import type { Provider } from './types.js';
import { volg } from './volg.js';

const PROVIDERS: Record<StoreId, Provider> = {
  migros,
  coop,
  denner,
  aldi,
  lidl,
  volg,
  landi,
  ikea,
};

export function getProvider(store: StoreId): Provider {
  return PROVIDERS[store];
}

export function allProviders(): Provider[] {
  return STORE_IDS.map((id) => PROVIDERS[id]);
}
