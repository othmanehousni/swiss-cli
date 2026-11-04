import { searchKey } from '../normalization/text.js';
/** Flattens a nested category tree, recording each category's full path. */
export function flattenTree(store, nodes, parent = null) {
    const out = [];
    for (const node of nodes) {
        const category = {
            store,
            id: node.id,
            parentId: parent?.id ?? null,
            name: node.name,
            path: [...(parent?.path ?? []), node.name],
            productCount: node.count ?? null,
        };
        out.push(category, ...flattenTree(store, node.children ?? [], category));
    }
    return out;
}
// Top-level category names that are clearly not groceries (de / fr / it).
const NON_FOOD = /haushalt|reinigung|putz|waschen|k(ö|oe)rper|kosmetik|pflege|drogerie|gesundheit|baby|tier|garten|baumarkt|werkstatt|elektronik|multimedia|bekleidung|mode\b|textil|schuh|spielwaren|spielzeug|b(ü|ue)ro|papeterie|wohnen|einrichtung|freizeit|sport|camping|nicht-lebensmittel|non.?food|m(é|e)nage|nettoyage|soins|beaut(é|e)|b(é|e)b(é|e)|animaux|jardin|maison|bricolage|v(ê|e)tements|jouets|loisirs|\bcasa\b|pulizia|cura|bellezza|animali|giardino|abbigliamento|giocattoli|tempo libero/i;
export function isFoodByName(category) {
    return !NON_FOOD.test(category.name);
}
/** Words that select every grocery category of a store. */
export const FOOD_ALIASES = ['food', 'groceries', 'lebensmittel', 'alimentation', 'alimentari'];
function dropDescendants(categories, ids) {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const selected = new Set(ids);
    return ids.filter((id) => {
        let parent = byId.get(id)?.parentId ?? null;
        while (parent) {
            if (selected.has(parent))
                return false;
            parent = byId.get(parent)?.parentId ?? null;
        }
        return true;
    });
}
/**
 * Turns `--category` values into category ids. Accepts ids, names
 * ("Milchprodukte", accents optional) and "food". When a category and one of
 * its sub-categories both match, only the parent is kept.
 */
export function resolveCategories(provider, categories, terms) {
    const ids = [];
    const unmatched = [];
    const add = (id) => {
        if (!ids.includes(id))
            ids.push(id);
    };
    for (const term of terms) {
        const key = searchKey(term);
        if (FOOD_ALIASES.includes(key)) {
            const isFood = provider.isFood ?? isFoodByName;
            for (const c of categories)
                if (c.parentId === null && isFood(c))
                    add(c.id);
            continue;
        }
        const byId = categories.find((c) => c.id === term.trim());
        if (byId) {
            add(byId.id);
            continue;
        }
        const exact = categories.filter((c) => searchKey(c.name) === key);
        const matches = exact.length > 0
            ? exact
            : categories.filter((c) => searchKey(c.path.join(' ')).includes(key));
        if (matches.length === 0)
            unmatched.push(term);
        for (const c of matches)
            add(c.id);
    }
    return { ids: dropDescendants(categories, ids), unmatched };
}
