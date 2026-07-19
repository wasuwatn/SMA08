// ---- Modifier categories ---------------------------------------------------
// `addons.kind` is overloaded (see coffee-pos-buddy's catalog.ts, which owns
// this convention): a "modcat:<single|multi>" row is a category shell (never
// itself sellable), a "modopt:<catId>" row is one option belonging to that
// category. Everything else (undefined, or the legacy container/sweetness/
// extra enum this page's own Add-on modal still writes) is a plain add-on.
const MODCAT_PREFIX = 'modcat:';
const MODOPT_PREFIX = 'modopt:';

export const isCategoryRow = (a) => String(a.kind || '').startsWith(MODCAT_PREFIX);
export const isOptionRow = (a) => String(a.kind || '').startsWith(MODOPT_PREFIX);
export const categoryKind = (mode) => `${MODCAT_PREFIX}${mode}`;
export const optionKind = (categoryId) => `${MODOPT_PREFIX}${categoryId}`;

export function parseModifierCategories(addons) {
  return addons.filter(isCategoryRow).map(c => ({
    id: c.id,
    name: c.name,
    mode: c.kind === categoryKind('multi') ? 'multi' : 'single',
    options: addons.filter(a => a.kind === optionKind(c.id))
  }));
}

// Categories every menu offers regardless of per-menu links (see
// menu_modifiers) — kept in sync with coffee-pos-buddy's catalog.ts.
export const MANDATORY_MODIFIER_NAMES = ['ภาชนะ', 'ความหวาน', 'ของเพิ่ม'];
export const isMandatoryCategory = (c) => MANDATORY_MODIFIER_NAMES.includes(c.name);
