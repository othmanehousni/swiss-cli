import { STORE_IDS } from '../normalization/types.js';
import { aldi } from './aldi.js';
import { coop } from './coop.js';
import { denner } from './denner.js';
import { ikea } from './ikea.js';
import { landi } from './landi.js';
import { lidl } from './lidl.js';
import { migros } from './migros.js';
import { volg } from './volg.js';
const PROVIDERS = {
    migros,
    coop,
    denner,
    aldi,
    lidl,
    volg,
    landi,
    ikea,
};
export function getProvider(store) {
    return PROVIDERS[store];
}
export function allProviders() {
    return STORE_IDS.map((id) => PROVIDERS[id]);
}
