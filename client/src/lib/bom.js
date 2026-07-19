// BOM (bill of materials) expansion and cost math shared by POS, Recipes,
// Delivery, and Dashboard.

// Expand a PBOM/MPREP set id into its component [{material_id, qty_used}] items.
// Returns null if the id is not a set prefix (caller should treat it as a plain material).
export function expandSetItems(materialId, packagingbom, matprepbom) {
  const id = String(materialId);
  const pool = id.startsWith('PBOM') ? packagingbom : id.startsWith('MPREP') ? matprepbom : null;
  if (!pool) return null;
  const set = pool.find(p => p.id === materialId);
  if (!set) return [];
  try { return JSON.parse(set.items); } catch { return []; }
}

// Aggregate raw-material requirements for drink lines.
// Each line: { name, qty, childId? }.
//  - Base BOM rows for the drink are always deducted (packaging "PBOM" sets and
//    mat prep "MPREP" sets are expanded into their component materials).
//  - If the line has a childId, the selected child menu's material (e.g. the bean
//    the customer picked) is deducted too.
export function computeRequirements(lines, bom, packagingbom = [], childmenu = [], matprepbom = []) {
  const req = {};
  const add = (matId, amount) => { if (matId) req[matId] = (req[matId] || 0) + amount; };
  lines.forEach(({ name, qty, childId }) => {
    bom.filter(b => b.menu_name === name).forEach(r => {
      const amount = Number(r.qty_used) * qty;
      const setItems = expandSetItems(r.material_id, packagingbom, matprepbom);
      if (setItems !== null) {
        setItems.forEach(it => add(it.material_id, Number(it.qty_used) * amount));
      } else {
        add(r.material_id, amount);
      }
    });
    if (childId) {
      const child = childmenu.find(c => String(c.id) === String(childId));
      if (child) add(child.material_id, Number(child.qty_used || 1) * qty);
    }
  });
  return req;
}

// BOM cost of one cup given its `[{material_id, qty_used}]` rows (sum of
// material.unit_price * qty_used, expanding PBOM/MPREP sets). Returns
// { cost, warn } — warn flags missing or inactive materials. Pass
// bom.filter(b => b.menu_name === name) for a saved menu's full recipe.
export function computeCupCost(bomRows, materials, packagingbom = [], matprepbom = []) {
  let cost = 0, warn = false;
  bomRows.forEach(r => {
    if (!r.material_id) return;
    const q = Number(r.qty_used) || 0;
    const setItems = expandSetItems(r.material_id, packagingbom, matprepbom);
    if (setItems !== null) {
      setItems.forEach(it => {
        const sm = materials.find(m => m.id === it.material_id);
        if (sm) { cost += Number(sm.unit_price) * Number(it.qty_used) * q; if (sm.status !== 'Active') warn = true; }
        else warn = true;
      });
      if (!setItems.length) warn = true;
    } else {
      const m = materials.find(x => x.id === r.material_id);
      if (m) { cost += Number(m.unit_price) * q; if (m.status !== 'Active') warn = true; }
      else warn = true;
    }
  });
  return { cost, warn };
}
