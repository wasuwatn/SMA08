// HTTP-level assertions against a running hub API + fresh database. Exported
// as a function (rather than a script that calls process.exit) so run.mjs can
// own server/DB lifecycle and only decide the final exit code once, after
// tearing both down.
export async function runChecks(BASE) {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
  };

  async function req(method, url, body, token) {
    const opts = { method, headers: {} };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data, headers: res.headers };
  }

  console.log('\n[0] Security headers (helmet)');
  let r = await req('GET', '/api/tables');
  ok('helmet sets X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff');

  console.log('\n[1] Auth & default-password detection');
  const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  ok('admin/admin login', adminLogin.status === 200);
  ok('mustChangePassword flagged for default password', adminLogin.data.mustChangePassword === true);
  ok('login response has no password hash', !('password' in (adminLogin.data.user || {})));
  const admin = adminLogin.data.token;

  const staffLogin = await req('POST', '/api/auth/login', { username: 'staff', password: 'staff' });
  const staff = staffLogin.data.token;
  ok('staff/staff login', staffLogin.status === 200);

  console.log('\n[2] Server-side authorization');
  r = await req('PUT', '/api/users/admin', { role: 'Admin', password: 'hacked' }, staff);
  ok('staff PUT /api/users/admin -> 403', r.status === 403, `got ${r.status}`);
  r = await req('POST', '/api/users', { username: 'evil', password: 'evil', role: 'Admin', access: '' }, staff);
  ok('staff POST /api/users -> 403', r.status === 403, `got ${r.status}`);
  r = await req('DELETE', '/api/users/staff', undefined, staff);
  ok('staff DELETE /api/users/staff -> 403', r.status === 403, `got ${r.status}`);
  r = await req('GET', '/api/users', undefined, staff);
  ok('staff GET /api/users -> 403', r.status === 403, `got ${r.status}`);
  r = await req('PUT', '/api/promotions/1', { status: 'Inactive' }, staff);
  ok('staff (no promotions flag) PUT /api/promotions -> 403', r.status === 403, `got ${r.status}`);
  r = await req('POST', '/api/materials', { id: 'MATX', item: 'X' }, staff);
  ok('staff (no materials flag) POST /api/materials -> 403', r.status === 403, `got ${r.status}`);
  r = await req('PUT', '/api/customers/1', { address: 'updated by staff' }, staff);
  ok('staff (has customers flag) PUT /api/customers -> 200', r.status === 200, `got ${r.status}`);
  r = await req('GET', '/api/users', undefined, admin);
  ok('admin GET /api/users -> 200 without hashes', r.status === 200 && r.data.every(u => !('password' in u)));
  r = await req('GET', '/api/materials', undefined, staff);
  ok('staff can still read materials (dashboards)', r.status === 200 && Array.isArray(r.data));
  r = await req('PUT', '/api/settings/1', { logo: 'x'.repeat(500000) }, admin);
  ok('oversized logo -> 413', r.status === 413, `got ${r.status}`);

  console.log('\n[3] DATE columns stay plain YYYY-MM-DD (not full timestamps)');
  await req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: 'Walk-in', menu_name: 'Espresso', quantity: 1, total_price: 60, cashier: 'staff' }],
    requirements: [], date: '2026-07-02', client_txn_id: 't-datefmt-1'
  }, staff);
  r = await req('GET', '/api/salefront?limit=1', undefined, admin);
  ok('salefront.date is "YYYY-MM-DD", not an ISO timestamp', /^\d{4}-\d{2}-\d{2}$/.test(r.data[0]?.date || ''), `got ${JSON.stringify(r.data[0]?.date)}`);

  console.log('\n[4] Atomic stock deduction');
  const mkCheckout = (qty, txn) => req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: 'Walk-in', menu_name: 'Espresso', quantity: 1, total_price: 60, cashier: 'staff' }],
    requirements: [{ material_id: 'MAT001', qty, note: 'concurrency test' }],
    date: '2026-07-02', client_txn_id: txn
  }, staff);

  const [c1, c2] = await Promise.all([mkCheckout(100, 't-conc-1'), mkCheckout(100, 't-conc-2')]);
  ok('both concurrent checkouts accepted', c1.status === 200 && c2.status === 200);
  r = await req('GET', '/api/materials', undefined, admin);
  let mat = r.data.find(m => m.id === 'MAT001');
  ok('stock 5000-100-100 = 4800 (no lost update)', Number(mat.current_stock) === 4800, `got ${mat.current_stock}`);

  const [g1, g2] = await Promise.all([mkCheckout(3000, 't-guard-1'), mkCheckout(3000, 't-guard-2')]);
  const codes = [g1.status, g2.status].sort();
  ok('insufficient-stock guard under concurrency (one 200, one 409)', codes[0] === 200 && codes[1] === 409, `got ${codes}`);
  r = await req('GET', '/api/materials', undefined, admin);
  mat = r.data.find(m => m.id === 'MAT001');
  ok('stock after guarded round = 1800', Number(mat.current_stock) === 1800, `got ${mat.current_stock}`);

  const dup = await mkCheckout(100, 't-conc-1');
  ok('replayed client_txn_id is a no-op', dup.status === 200 && dup.data.duplicate === true);

  console.log('\n[5] Loyalty via customer_id + rename + server-side /api/loyalty');
  let cust = await req('POST', '/api/customer/line-login', { devLineUserId: 'U_TEST_1' });
  ok('LINE dev login -> needsRegistration', cust.data.needsRegistration === true);
  cust = await req('POST', '/api/customer/register', { phone: '0899999999', name: 'Loyal Tester' }, cust.data.token);
  ok('customer registered', cust.status === 200 && cust.data.customer?.id);
  const custToken = cust.data.token, custId = cust.data.customer.id;

  const tenCups = Array.from({ length: 10 }, () => ({
    date: '2026-07-02', customer_name: 'Loyal Tester', customer_id: String(custId),
    menu_name: 'Espresso', quantity: 1, total_price: 60, cashier: 'staff', is_free: '0'
  }));
  r = await req('POST', '/api/checkout/pos', { sales: tenCups, requirements: [], date: '2026-07-02', client_txn_id: 't-loyal-1' }, staff);
  ok('10-cup checkout recorded', r.status === 200 && Array.isArray(r.data) && r.data.length === 10);

  let me = await req('GET', '/api/customer/me', undefined, custToken);
  ok('loyalty: 10 purchased, 1 available', me.data.loyalty?.purchased === 10 && me.data.loyalty?.available === 1, JSON.stringify(me.data.loyalty));

  r = await req('GET', `/api/loyalty?customer_id=${custId}`, undefined, staff);
  ok('staff /api/loyalty by customer_id matches customer-portal loyalty', r.status === 200 && r.data.available === 1 && r.data.purchased === 10, JSON.stringify(r.data));
  r = await req('GET', '/api/loyalty?name=Loyal%20Tester', undefined, staff);
  ok('staff /api/loyalty by typed name also matches', r.status === 200 && r.data.available === 1, JSON.stringify(r.data));
  r = await req('GET', '/api/loyalty?name=Nobody%20Ever%20Sold%20To', undefined, staff);
  ok('staff /api/loyalty for an unknown name returns zeros, not an error', r.status === 200 && r.data.purchased === 0);

  r = await req('PUT', `/api/customers/${custId}`, { name: 'Renamed Tester' }, admin);
  ok('customer renamed', r.status === 200 && r.data.name === 'Renamed Tester');
  me = await req('GET', '/api/customer/me', undefined, custToken);
  ok('loyalty survives rename (still 1 available)', me.data.loyalty?.available === 1, JSON.stringify(me.data.loyalty));

  const redeem = await req('POST', '/api/customer/redeem', undefined, custToken);
  ok('redeem code minted', redeem.status === 200 && /^\d{6}$/.test(redeem.data.code || ''));
  const lookup = await req('GET', `/api/redemption/${redeem.data.code}`, undefined, staff);
  ok('staff code lookup finds customer', lookup.status === 200 && lookup.data.customer_name === 'Renamed Tester');
  r = await req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: 'Renamed Tester', customer_id: String(custId), menu_name: 'Espresso', quantity: 1, total_price: 0, cashier: 'staff', is_free: '1' }],
    requirements: [], date: '2026-07-02', client_txn_id: 't-redeem-1', redemption_id: lookup.data.id
  }, staff);
  ok('free cup checkout burns the code', r.status === 200);
  r = await req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: 'Renamed Tester', menu_name: 'Espresso', quantity: 1, total_price: 0, cashier: 'staff', is_free: '1' }],
    requirements: [], date: '2026-07-02', client_txn_id: 't-redeem-2', redemption_id: lookup.data.id
  }, staff);
  ok('re-using a burnt code -> 409', r.status === 409, `got ${r.status}`);

  console.log('\n[6] Shifts & Z-report');
  let shift = await req('POST', '/api/shift/open', { opening_cash: 500 }, staff);
  ok('shift opened with 500 float', shift.status === 200 && shift.data.status === 'open');
  const shiftId = shift.data.id;
  r = await req('POST', '/api/shift/open', { opening_cash: 1 }, staff);
  ok('second open -> 409', r.status === 409, `got ${r.status}`);

  const sale = (amount, method, txn) => req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: 'Walk-in', menu_name: 'Latte', quantity: 1, total_price: amount, cashier: 'staff', payment_method: method, shift_id: String(shiftId) }],
    requirements: [], date: '2026-07-02', client_txn_id: txn
  }, staff);
  await sale(100, 'Cash', 't-shift-cash');
  await sale(70, 'PromptPay', 't-shift-pp');
  await sale(65, 'Transfer', 't-shift-tr');

  const closed = await req('POST', '/api/shift/close', { closing_cash: 590, note: 'test close' }, staff);
  const s = closed.data.shift || {};
  ok('shift closed', closed.status === 200 && s.status === 'closed');
  ok('cash_sales = 100', Number(s.cash_sales) === 100, `got ${s.cash_sales}`);
  ok('promptpay_sales = 70', Number(s.promptpay_sales) === 70, `got ${s.promptpay_sales}`);
  ok('transfer_sales = 65', Number(s.transfer_sales) === 65, `got ${s.transfer_sales}`);
  ok('expected_cash = 500 + 100 = 600', Number(s.expected_cash) === 600, `got ${s.expected_cash}`);
  ok('over_short = 590 - 600 = -10', Number(s.over_short) === -10, `got ${s.over_short}`);
  ok('close with no open shift -> 409', (await req('POST', '/api/shift/close', {}, staff)).status === 409);

  console.log('\n[7] Windowed GET');
  r = await req('GET', '/api/salefront?since=2026-07-02&until=2026-07-02', undefined, staff);
  ok('date window returns only 2026-07-02 rows', r.status === 200 && r.data.length > 0 && r.data.every(x => x.date === '2026-07-02'));
  r = await req('GET', '/api/salefront?limit=3', undefined, staff);
  ok('limit=3 returns 3 newest rows', r.status === 200 && r.data.length === 3);

  console.log('\n[8] Change password');
  r = await req('POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'newpass123' }, admin);
  ok('wrong current password -> 401', r.status === 401, `got ${r.status}`);
  r = await req('POST', '/api/auth/change-password', { currentPassword: 'admin', newPassword: 'admin' }, admin);
  ok('password == username rejected', r.status === 400, `got ${r.status}`);
  r = await req('POST', '/api/auth/change-password', { currentPassword: 'admin', newPassword: 'newpass123' }, admin);
  ok('password changed', r.status === 200);
  r = await req('POST', '/api/auth/login', { username: 'admin', password: 'newpass123' });
  ok('login with new password, no forced change', r.status === 200 && r.data.mustChangePassword === false);
  r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  ok('old password rejected', r.status === 401);

  console.log('\n[9] Error responses');
  r = await req('POST', '/api/expense', { expense: { date: '2026-07-02', description: 'x', amount: 'not-a-number' } }, staff);
  ok('500 does not leak internals', r.status !== 500 || r.data.error === 'Internal server error.', JSON.stringify(r.data));

  return { pass, fail };
}
