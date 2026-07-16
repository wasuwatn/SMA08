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

  console.log('\n[5] Shop-issued points: links, grants, claims, POS spend');
  let cust = await req('POST', '/api/customer/line-login', { devLineUserId: 'U_TEST_1', devName: 'Point Tester' });
  ok('LINE dev login -> needsRegistration', cust.data.needsRegistration === true);
  cust = await req('POST', '/api/customer/register', { phone: '0899999999' }, cust.data.token);
  ok('customer registered', cust.status === 200 && cust.data.customer?.id);
  const custToken = cust.data.token, custId = cust.data.customer.id, custName = cust.data.customer.name;

  r = await req('POST', '/api/points/link', { points: 5 }, staff);
  ok('staff without points flag POST /api/points/link -> 403', r.status === 403, `got ${r.status}`);
  r = await req('POST', '/api/points/link', { points: 0 }, admin);
  ok('non-positive points -> 400', r.status === 400, `got ${r.status}`);
  const link = await req('POST', '/api/points/link', { points: 5, note: 'test link' }, admin);
  ok('link minted with token', link.status === 200 && typeof link.data.token === 'string' && link.data.token.length >= 32);

  r = await req('POST', '/api/customer/claim-points', { token: link.data.token }, custToken);
  ok('claim credits 5 points', r.status === 200 && r.data.points === 5 && r.data.balance === 5, JSON.stringify(r.data));
  r = await req('POST', '/api/customer/claim-points', { token: link.data.token }, custToken);
  ok('same-customer retry is idempotent', r.status === 200 && r.data.alreadyClaimed === true, JSON.stringify(r.data));

  let cust2 = await req('POST', '/api/customer/line-login', { devLineUserId: 'U_TEST_2', devName: 'Other Tester' });
  cust2 = await req('POST', '/api/customer/register', { phone: '0888888888' }, cust2.data.token);
  r = await req('POST', '/api/customer/claim-points', { token: link.data.token }, cust2.data.token);
  ok('another customer claiming a used link -> 409', r.status === 409, `got ${r.status}`);
  r = await req('POST', '/api/customer/claim-points', { token: 'no-such-token' }, custToken);
  ok('unknown token -> 404', r.status === 404, `got ${r.status}`);

  const voidable = await req('POST', '/api/points/link', { points: 3 }, admin);
  r = await req('DELETE', `/api/points/link/${voidable.data.id}`, undefined, admin);
  ok('pending link voided', r.status === 200);
  r = await req('DELETE', `/api/points/link/${link.data.id}`, undefined, admin);
  ok('claimed link cannot be voided -> 409', r.status === 409, `got ${r.status}`);

  r = await req('POST', '/api/points/grant', { customer_id: custId, points: 5, note: 'goodwill' }, admin);
  ok('direct CRM grant -> balance 10', r.status === 200 && r.data.balance === 10, JSON.stringify(r.data));
  r = await req('GET', `/api/points/balance?customer_id=${custId}`, undefined, staff);
  ok('POS balance lookup: 10 points, 10 per free cup', r.status === 200 && r.data.balance === 10 && r.data.pointsPerFree === 10, JSON.stringify(r.data));
  let me = await req('GET', '/api/customer/me', undefined, custToken);
  ok('portal /me shows balance + 2 history rows', me.data.pointsBalance === 10 && Array.isArray(me.data.pointsHistory) && me.data.pointsHistory.length === 2, JSON.stringify({ b: me.data.pointsBalance, h: me.data.pointsHistory?.length }));

  ok('staff token rejected on /api/customer/redeem', (await req('POST', '/api/customer/redeem', {}, staff)).status === 401);

  r = await req('POST', '/api/customer/redeem', {}, custToken);
  ok('mint self-redeem code (balance 10 covers 1 free cup)', r.status === 200 && /^\d{6}$/.test(r.data.code), JSON.stringify(r.data));
  const code = r.data.code;

  r = await req('POST', '/api/customer/redeem', {}, custToken);
  ok('minting a 2nd code before the 1st is used -> 409 (pending reserves the credit)', r.status === 409, `got ${r.status}`);

  r = await req('GET', '/api/redemption/000000', undefined, staff);
  ok('unknown code -> 404', r.status === 404, `got ${r.status}`);
  r = await req('GET', `/api/redemption/${code}`, undefined, staff);
  ok('staff lookup resolves the customer', r.status === 200 && r.data.customer_id === custId, JSON.stringify(r.data));
  const redemptionId = r.data.id;

  const freeCup = (name, redemption_id, txn) => req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: name, menu_name: 'Espresso', quantity: 1, total_price: 0, cashier: 'staff', is_free: '1', promotion_id: '1' }],
    requirements: [], date: '2026-07-02', client_txn_id: txn, redemption_id
  }, staff);

  const [b1, b2] = await Promise.all([
    freeCup(custName, redemptionId, 't-pts-spend-race-1'),
    freeCup(custName, redemptionId, 't-pts-spend-race-2')
  ]);
  const raceCodes = [b1.status, b2.status].sort();
  ok('concurrent burn of the same code: one 200, one 409', raceCodes[0] === 200 && raceCodes[1] === 409, `got ${raceCodes}`);
  r = await req('GET', `/api/points/balance?customer_id=${custId}`, undefined, staff);
  ok('balance charged exactly once: 10 -> 0', r.data.balance === 0, `got ${r.data.balance}`);

  r = await req('GET', `/api/redemption/${code}`, undefined, staff);
  ok('used code no longer resolves', r.status === 404, `got ${r.status}`);
  r = await req('POST', '/api/customer/redeem', {}, custToken);
  ok('no points left -> 409', r.status === 409, `got ${r.status}`);

  console.log('\n[5b] Marking a cup free directly (no redeem code needed)');
  const directFreeCup = (name, txn) => req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: name, menu_name: 'Espresso', quantity: 1, total_price: 0, cashier: 'staff', is_free: '1', promotion_id: '1' }],
    requirements: [], date: '2026-07-02', client_txn_id: txn
  }, staff);

  r = await req('POST', '/api/points/grant', { customer_id: custId, points: 10 }, admin);
  ok('grant 10 more points for the direct-mark test', r.status === 200 && r.data.balance === 10, JSON.stringify(r.data));
  r = await directFreeCup(custName, 't-direct-free-1');
  ok('direct free-cup mark (no redemption_id) accepted', r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  r = await req('GET', `/api/points/balance?customer_id=${custId}`, undefined, staff);
  ok('balance charged without ever entering a code: 10 -> 0', r.data.balance === 0, `got ${r.data.balance}`);
  r = await directFreeCup(custName, 't-direct-free-2');
  ok('insufficient points on direct mark -> 409', r.status === 409, `got ${r.status}`);
  r = await directFreeCup('Walk-in', 't-direct-free-3');
  ok('point-funded cup without a resolvable customer -> 409', r.status === 409, `got ${r.status}`);
  r = await req('POST', '/api/checkout/pos', {
    sales: [{ date: '2026-07-02', customer_name: 'Walk-in', menu_name: 'Espresso', quantity: 1, total_price: 0, cashier: 'staff', is_free: '1', promotion_id: '' }],
    requirements: [], date: '2026-07-02', client_txn_id: 't-direct-free-4'
  }, staff);
  ok('goodwill comp (empty promotion_id) needs no customer or points', r.status === 200, `got ${r.status}`);

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

  console.log('\n[10] PIN login');
  r = await req('GET', '/api/auth/staff-list');
  ok('staff-list is public and lists both seeded users',
    r.status === 200 && Array.isArray(r.data) && r.data.includes('admin') && r.data.includes('staff'));
  ok('staff-list entries are bare usernames, no other fields', r.data.every(u => typeof u === 'string'));

  r = await req('POST', '/api/auth/pin-login', { username: 'staff', pin: '1234' });
  ok('pin-login before any PIN is set -> 401', r.status === 401, `got ${r.status}`);

  r = await req('POST', '/api/auth/set-pin', { currentPassword: 'wrong', newPin: '1234' }, staff);
  ok('set-pin wrong current password -> 401', r.status === 401, `got ${r.status}`);
  r = await req('POST', '/api/auth/set-pin', { currentPassword: 'staff', newPin: '12' }, staff);
  ok('set-pin non-4-digit -> 400', r.status === 400, `got ${r.status}`);
  r = await req('POST', '/api/auth/set-pin', { currentPassword: 'staff', newPin: '1234' }, staff);
  ok('set-pin succeeds', r.status === 200, `got ${r.status}`);

  r = await req('POST', '/api/auth/pin-login', { username: 'staff', pin: '1234' });
  ok('pin-login with correct PIN', r.status === 200 && !!r.data.token, `got ${r.status}`);
  ok('pin-login response has no password/pin hash',
    !('password' in (r.data.user || {})) && !('pin' in (r.data.user || {})));

  r = await req('POST', '/api/auth/pin-login', { username: 'staff', pin: '0000' });
  ok('pin-login wrong PIN -> 401', r.status === 401, `got ${r.status}`);

  // 4 more wrong attempts (5 total, including the one just above) should trip
  // the per-username lockout — scoped to this account, not the whole kiosk.
  for (let i = 0; i < 4; i++) {
    await req('POST', '/api/auth/pin-login', { username: 'staff', pin: '0000' });
  }
  r = await req('POST', '/api/auth/pin-login', { username: 'staff', pin: '1234' });
  ok('locked out after repeated failures, even with the correct PIN -> 429', r.status === 429, `got ${r.status}`);

  console.log('\n[11] PIN set via generic user CRUD');
  r = await req('PUT', '/api/users/admin', { role: 'Admin', pin: '12' }, admin);
  ok('PUT /api/users pin non-4-digit -> 400', r.status === 400, `got ${r.status}`);
  r = await req('PUT', '/api/users/admin', { role: 'Admin', pin: '5678' }, admin);
  ok('PUT /api/users pin accepted and stripped from response',
    r.status === 200 && !('pin' in r.data), `got ${JSON.stringify(r.data)}`);
  r = await req('GET', '/api/users', undefined, admin);
  ok('GET /api/users never leaks pin hash', r.status === 200 && r.data.every(u => !('pin' in u)));

  return { pass, fail };
}
