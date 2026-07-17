// In-chat LINE expense bot: an allow-listed staff member sends a receipt
// photo (or a text like "ค่ากาแฟ 40 ไข่ 60") to the shop's LINE OA, GPT-4o-mini
// extracts categorized line items, the bot replies with a Flex card where each
// item can be toggled off, and confirming records one `expenses` row per
// selected item — the whole loop lives in the chat, no LIFF page needed. The
// older Make.com + LIFF review flow (/api/line/slips*) coexists untouched.
//
// Auth model: LINE signs every webhook delivery (x-line-signature = HMAC-SHA256
// of the raw body with the channel secret); postback actions additionally
// require the tapping user to be the slip's original sender. Reward customers
// share this OA — anyone not in settings.expense_line_users is ignored without
// a reply so the bot stays invisible to them.
import crypto from 'node:crypto';
import { pool, withTransaction, insertRow, updateRow, getRow, logActivity } from './db.js';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Same LIFF app as expense-review.html (VITE_EXPENSE_LIFF_ID on the client
// build) — the Flex card's "แก้ไขรายการ" button opens it with ?flow=chat so
// the one page serves both the old single-slip form and this item checklist.
// Optional: without it the button is simply omitted from the card.
const LINE_EXPENSE_LIFF_ID = process.env.LINE_EXPENSE_LIFF_ID;
const DEV = process.env.NODE_ENV !== 'production';

const MAX_ITEMS = 20; // keeps the Flex card bounded but fits a full grocery-run receipt
// Sum-of-items vs. the receipt's own printed total may legitimately differ by
// a baht or two from rounding — only flag real misses (a dropped line item),
// not float noise.
const TOTAL_MISMATCH_TOLERANCE = 2;

// `new Date().toISOString()` is UTC — between 00:00 and 06:59 Thai time that
// books the expense on yesterday. Shift to ICT (UTC+7) before taking the date.
const bangkokToday = () =>
  new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0];

// Mirrors index.js's fail() — never echo raw pg/driver errors to the client.
const fail = (res, e) => {
  console.error(e);
  res.status(500).json({ error: 'Internal server error.' });
};

// Shared by the postback confirm action and the HTTP confirm endpoint below:
// insert one expenses row per selected item and link the slip to the first
// one (pending_slips.expense_id is a single FK; "which of N rows" doesn't
// matter, it's only used to prove the slip *has* been turned into expenses).
async function insertSelectedExpenses(client, slipId, buyerName, selectedItems) {
  const date = bangkokToday();
  const rows = [];
  for (const it of selectedItems) {
    rows.push(await insertRow('expenses', {
      date, description: it.description, amount: it.amount,
      buyer: buyerName, category: it.category || 'Other',
      note: `LINE chat slip #${slipId}`
    }, client));
  }
  await client.query('UPDATE pending_slips SET expense_id = $2 WHERE id = $1', [slipId, rows[0].id]);
  return rows;
}

function validSignature(rawBody, headerSig) {
  if (!rawBody || !headerSig) return false;
  const mac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(headerSig), 'base64'); } catch { return false; }
  return given.length === mac.length && crypto.timingSafeEqual(mac, given);
}

// settings.expense_line_users: "U1234abc:สมชาย, U5678def" → Map(userId → buyer
// name, defaulting to 'LINE' when no :name suffix is given).
async function getAllowlist() {
  const { rows: [s] } = await pool.query('SELECT expense_line_users FROM settings LIMIT 1');
  const map = new Map();
  for (const entry of String(s?.expense_line_users || '').split(',')) {
    const [id, name] = entry.split(':').map(x => x.trim());
    if (id) map.set(id, name || 'LINE');
  }
  return map;
}

async function lineReply(replyToken, messages) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    // Same spirit as the LIFF verify dev-bypass in index.js: lets the whole
    // pipeline run locally / in tests without a real LINE channel.
    if (DEV) { console.log('DEV lineReply:', JSON.stringify(messages).slice(0, 400)); return; }
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');
  }
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: Array.isArray(messages) ? messages : [messages] })
  });
  // Nothing to recover from a failed reply (token expired/used) — log and move on.
  if (!r.ok) console.error('lineExpense: reply failed', r.status, (await r.text()).slice(0, 300));
}

const textMsg = (text) => ({ type: 'text', text });

async function fetchLineImage(messageId) {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  if (!r.ok) throw new Error(`LINE content fetch failed (${r.status})`);
  return {
    base64: Buffer.from(await r.arrayBuffer()).toString('base64'),
    mime: r.headers.get('content-type') || 'image/jpeg'
  };
}

// ---------------------------------------------------------------------------
// Analysis: image or text → { merchant, items: [{description, amount, category}] }

const SYSTEM_PROMPT = `You extract expense line items for a Thai coffee shop's bookkeeping.
The input is either a photo of a receipt / payment slip, or a short Thai/English text such as "ค่ากาแฟ 40 ไข่ 60".

For a text message like "ค่ากาแฟ 40 ไข่ 60": split into one item per name+amount pair (that example has TWO items).
Set "receipt_total" to null for text input — there is no printed total to check against.

For a photo of an itemized receipt (e.g. a supermarket/wholesale tax invoice with many lines):
- Extract EVERY purchasable line between the header and the total/subtotal line. Do not skip lines because
  they look similar to each other or because there are many of them — a long receipt commonly has 10-20 items.
- Each line typically ends with a quantity or weight times a unit price, producing a final line amount, e.g.
  "1 * 79.00" (qty 1 @ 79), "0.642 * 55.00" (0.642 kg @ 55/kg — a weighed item), or "2 * 86.00" (qty 2 @ 86).
  Use the FINAL computed amount for that line (i.e. quantity/weight × unit price) as "amount" — never the bare
  unit price alone.
- The photo may be rotated, sideways, wrinkled, or partially blurry — read all text regardless of orientation.
- Set "receipt_total" to the grand total printed on the receipt (the TOTAL / รวม / มูลค่าสินค้ารวม line), as a
  plain number, so it can be cross-checked against the sum of the items you extracted. If no total is legible,
  use null.

Choose "category" as the closest match from the allowed list; use "Other" when nothing fits.
"merchant" is the store/payee name if visible, else "".
If the input contains no expense items at all, return an empty "items" array and receipt_total null.
Keep descriptions short (under 40 characters). Return at most ${MAX_ITEMS} items — merge only the smallest/least
distinct lines if there are genuinely more than that, and prefer merging over dropping items silently.`;

async function analyzeExpense({ text, image }) {
  const { rows: catRows } = await pool.query(
    "SELECT DISTINCT category FROM expenses WHERE category IS NOT NULL AND category <> '' ORDER BY category"
  );
  const categories = [...new Set([...catRows.map(r => r.category), 'Other'])];

  if (!OPENAI_API_KEY) {
    // Dev/test fallback: naive "name amount" pair parser for text messages so
    // npm test can exercise the full webhook → slip → confirm pipeline offline.
    if (DEV && text) {
      const items = [];
      for (const m of text.matchAll(/([^\d,]+?)\s*(\d+(?:\.\d+)?)/g)) {
        const amount = Number(m[2]);
        if (m[1].trim() && amount > 0) items.push({ description: m[1].trim(), amount, category: 'Other' });
      }
      return { merchant: '', items: items.slice(0, MAX_ITEMS), receiptTotal: null, raw: 'dev-fallback' };
    }
    throw new Error('OPENAI_API_KEY is not set');
  }

  const userContent = image
    ? [
        { type: 'text', text: 'สกัดรายการค่าใช้จ่ายจากรูปสลิป/ใบเสร็จนี้' },
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}`, detail: 'high' } }
      ]
    : text;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 3000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'expense_extraction',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['merchant', 'items', 'receipt_total'],
            properties: {
              merchant: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['description', 'amount', 'category'],
                  properties: {
                    description: { type: 'string' },
                    amount: { type: 'number' },
                    category: { type: 'string', enum: categories }
                  }
                }
              },
              receipt_total: { type: ['number', 'null'] }
            }
          }
        }
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ]
    })
  });
  if (!r.ok) throw new Error(`OpenAI request failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const rawText = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(rawText);
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .map(i => ({
      description: String(i.description || '').trim().slice(0, 60),
      amount: Number(i.amount),
      category: categories.includes(i.category) ? i.category : 'Other'
    }))
    .filter(i => i.description && Number.isFinite(i.amount) && i.amount > 0)
    .slice(0, MAX_ITEMS);
  const receiptTotal = parsed.receipt_total != null && Number.isFinite(Number(parsed.receipt_total))
    ? Number(parsed.receipt_total) : null;
  return { merchant: String(parsed.merchant || '').trim(), items, receiptTotal, raw: rawText };
}

// ---------------------------------------------------------------------------
// Flex card: item list (read-only) + "บันทึกทั้งหมด" / "แก้ไขรายการ" / "ยกเลิก".
//
// Per-item toggling used to be postback buttons directly on the card, but
// every tap meant waiting for a brand new chat message (LINE can't edit a
// message that's already been sent) — a real back-and-forth for what should
// feel instant. "แก้ไขรายการ" instead opens the expense-review LIFF page
// (?flow=chat) where unchecking an item is a local checkbox with no round
// trip; only the final save talks to the server. "บันทึกทั้งหมด" stays a
// single-tap postback for the common case where nothing needs removing.
function buildSlipFlex(slip, items) {
  const total = items.reduce((s, i) => s + i.amount, 0);
  const rows = items.map((it) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
    contents: [
      {
        type: 'box', layout: 'vertical', flex: 5,
        contents: [
          { type: 'text', text: it.description, size: 'sm', wrap: true },
          { type: 'text', text: it.category, size: 'xxs', color: '#999999' }
        ]
      },
      { type: 'text', text: `${it.amount}฿`, flex: 2, size: 'sm', align: 'end' }
    ]
  }));
  const footerButtons = [
    { type: 'button', style: 'primary', height: 'sm',
      action: { type: 'postback', label: `บันทึกทั้งหมด ${items.length} รายการ`, data: `exp:c:${slip.id}` } }
  ];
  if (LINE_EXPENSE_LIFF_ID) {
    footerButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: {
        type: 'uri', label: 'แก้ไขรายการ',
        uri: `https://liff.line.me/${LINE_EXPENSE_LIFF_ID}?flow=chat&id=${slip.id}&token=${slip.confirm_token}`
      }
    });
  }
  footerButtons.push({ type: 'button', style: 'secondary', height: 'sm',
    action: { type: 'postback', label: 'ยกเลิก', data: `exp:x:${slip.id}` } });
  return {
    type: 'flex',
    altText: `รายการค่าใช้จ่าย ${total} บาท (${items.length} รายการ)`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: slip.merchant || 'รายการค่าใช้จ่าย', weight: 'bold', size: 'md', wrap: true },
          { type: 'separator' },
          ...rows,
          { type: 'separator' },
          { type: 'text', text: `รวม ${total} บาท (${items.length} รายการ)`, weight: 'bold', size: 'sm', align: 'end' }
        ]
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerButtons }
    }
  };
}

// ---------------------------------------------------------------------------
// Message pipeline (image and text share it)

async function handleExpenseMessage(event, userId) {
  const replyToken = event.replyToken;
  const isImage = event.message.type === 'image';
  const text = isImage ? null : String(event.message.text || '').trim();

  // "myid" helper for onboarding a colleague — allowlisted users only reach
  // this point, so the reply can't leak to customers.
  if (!isImage && text.toLowerCase() === 'myid') {
    await lineReply(replyToken, textMsg(`LINE user ID ของคุณคือ:\n${userId}`));
    return;
  }

  // Insert the idempotency stub BEFORE any paid API call: line_message_id is
  // UNIQUE, so a redelivered webhook (LINE retries on timeout) hits 23505 and
  // bails without a second OpenAI charge or a duplicate reply card.
  let stub;
  try {
    stub = await insertRow('pending_slips', {
      line_message_id: event.message.id,
      line_user_id: userId,
      status: 'analyzing',
      confirm_token: crypto.randomBytes(24).toString('hex'),
      created_at: new Date().toISOString()
    });
  } catch (e) {
    if (e.code === '23505') return; // redelivery — first delivery handles the reply
    throw e;
  }

  try {
    const image = isImage ? await fetchLineImage(event.message.id) : null;
    const { merchant, items, receiptTotal, raw } = await analyzeExpense({ text, image });

    if (!items.length) {
      await updateRow('pending_slips', stub.id, { status: 'discarded' });
      await lineReply(replyToken, textMsg(isImage
        ? 'ไม่พบรายการค่าใช้จ่ายในรูปนี้ ลองถ่ายใหม่ให้ชัดขึ้น หรือพิมพ์รายการเอง เช่น: ค่ากาแฟ 40 ไข่ 60'
        : 'ไม่พบรายการค่าใช้จ่าย — พิมพ์รายการพร้อมยอด เช่น: ค่ากาแฟ 40 ไข่ 60 หรือส่งรูปสลิปมาได้เลย'));
      return;
    }

    const withSelection = items.map(i => ({ ...i, selected: true }));
    const total = withSelection.reduce((s, i) => s + i.amount, 0);
    const slip = await updateRow('pending_slips', stub.id, {
      status: 'pending',
      merchant,
      amount: total,
      items: JSON.stringify(withSelection),
      ocr_raw: typeof raw === 'string' ? raw : JSON.stringify(raw)
    });
    const flex = buildSlipFlex(slip, withSelection);
    // The model also reads the receipt's own printed total, if visible — a
    // real gap here (a dropped/misread line, not just rounding) means the
    // extraction is probably incomplete. Surface that instead of staying
    // silent about it, since a silently-short list looks identical to a
    // correct one until someone checks the books later.
    if (receiptTotal != null && Math.abs(total - receiptTotal) > TOTAL_MISMATCH_TOLERANCE) {
      await lineReply(replyToken, [
        textMsg(`⚠️ ยอดรวมที่อ่านได้ (${total} บาท) ไม่ตรงกับยอดในใบเสร็จ (${receiptTotal} บาท) — รายการอาจอ่านไม่ครบ กรุณาตรวจสอบก่อนบันทึก หรือถ่ายรูปใหม่ให้ชัดและตรงกว่านี้`),
        flex
      ]);
      return;
    }
    await lineReply(replyToken, flex);
  } catch (e) {
    console.error('lineExpense: analysis failed for slip', stub.id, e.message);
    await updateRow('pending_slips', stub.id, { status: 'error' });
    // A re-sent photo/text is a new LINE message id → fresh row, clean retry.
    await lineReply(replyToken, textMsg('อ่านรายการไม่สำเร็จ ขออภัยค่ะ 🙏 ลองส่งใหม่อีกครั้ง'));
  }
}

// ---------------------------------------------------------------------------
// Postback pipeline: exp:c:<slipId> confirm-all / exp:x:<slipId> cancel.
// (Per-item removal moved to the expense-review LIFF page — see
// buildSlipFlex above.) Signature already proves the event came from LINE;
// requiring the tapper to be the slip's sender closes the loop.

const ZERO_SELECTED = Symbol('zero-selected');

async function handlePostback(event, userId, buyerName) {
  const m = /^exp:(c|x):(\d+)$/.exec(String(event.postback?.data || ''));
  if (!m) return; // not ours (e.g. future postbacks from other features)
  const [, action, slipIdStr] = m;
  const slipId = Number(slipIdStr);
  const replyToken = event.replyToken;

  if (action === 'c') {
    let saved;
    try {
      saved = await withTransaction(async (client) => {
        // Atomic claim — same pattern as the LIFF confirm route: a double-tap
        // or redelivered postback finds status != 'pending' and no-ops.
        const claim = await client.query(
          `UPDATE pending_slips SET status = 'completed', confirmed_at = $3
           WHERE id = $1 AND line_user_id = $2 AND status = 'pending'
           RETURNING id, items, merchant`,
          [slipId, userId, new Date().toISOString()]);
        if (!claim.rowCount) return null;
        const selected = JSON.parse(claim.rows[0].items || '[]').filter(i => i.selected);
        if (!selected.length) throw ZERO_SELECTED; // rolls the claim back
        await insertSelectedExpenses(client, slipId, buyerName, selected);
        return selected;
      });
    } catch (e) {
      if (e !== ZERO_SELECTED) throw e;
      await lineReply(replyToken, textMsg('ไม่มีรายการให้บันทึก — กดยกเลิก หรือกด "แก้ไขรายการ" ในการ์ดเดิมเพื่อเลือกใหม่'));
      return;
    }
    if (!saved) {
      await lineReply(replyToken, textMsg('รายการนี้ถูกบันทึกหรือยกเลิกไปแล้วค่ะ'));
      return;
    }
    const total = saved.reduce((s, i) => s + i.amount, 0);
    await logActivity('line-chat', 'EXPENSE', `slip #${slipId}: ${saved.length} items, ${total} THB`);
    await lineReply(replyToken, textMsg(
      `บันทึกแล้ว ${saved.length} รายการ ✅\n` +
      saved.map(i => `• ${i.description} ${i.amount} บาท (${i.category})`).join('\n') +
      `\nรวม ${total} บาท`));
    return;
  }

  // action === 'x' — cancel
  const { rowCount } = await pool.query(
    `UPDATE pending_slips SET status = 'discarded'
     WHERE id = $1 AND line_user_id = $2 AND status = 'pending'`,
    [slipId, userId]);
  await lineReply(replyToken, rowCount
    ? textMsg('ยกเลิกแล้วค่ะ ❌ รายการนี้จะไม่ถูกบันทึก')
    : textMsg('รายการนี้ถูกบันทึกหรือยกเลิกไปแล้วค่ะ'));
}

// ---------------------------------------------------------------------------

async function processEvents(events) {
  const allowlist = await getAllowlist();
  for (const event of events || []) {
    try {
      // LINE redelivers events it thinks we missed; every first delivery is
      // fully handled below, so redeliveries are always safe to drop (the
      // message pipeline also has the DB-level 23505 guard as a backstop).
      if (event.deliveryContext?.isRedelivery) continue;
      const userId = event.source?.userId;
      if (!userId) continue;
      if (!allowlist.has(userId)) {
        // No reply of any kind — reward customers share this OA. The log line
        // is how the admin discovers a userId to add to the allowlist.
        if (event.type === 'message') console.log('lineExpense: ignored message from non-allowlisted user', userId);
        continue;
      }
      const buyerName = allowlist.get(userId);
      if (event.type === 'message' && (event.message?.type === 'image' || event.message?.type === 'text')) {
        await handleExpenseMessage(event, userId);
      } else if (event.type === 'postback') {
        await handlePostback(event, userId, buyerName);
      }
    } catch (e) {
      console.error('lineExpense: event handling failed', e);
    }
  }
}

export function registerLineExpenseRoutes(app) {
  app.post('/api/line/webhook', (req, res) => {
    if (!LINE_CHANNEL_SECRET) return res.sendStatus(503); // feature not configured
    if (!validSignature(req.rawBody, req.header('x-line-signature'))) {
      return res.sendStatus(403);
    }
    // Ack before processing: a slow OpenAI call inside the response window
    // would make LINE redeliver the whole batch (duplicate token spend).
    // Reply tokens stay valid long enough to answer after the ack.
    res.sendStatus(200);
    processEvents(req.body?.events).catch(e => console.error('lineExpense: batch failed', e));
  });

  // Backs the expense-review LIFF page's "?flow=chat" checklist (opened from
  // the Flex card's "แก้ไขรายการ" button) — instant local checkboxes, one
  // network round trip on save, instead of a postback per item. Same
  // token-is-the-auth model as the older /api/line/slips/:id routes.
  app.get('/api/line/chat-slips/:id', async (req, res) => {
    const token = String(req.query.token || '');
    try {
      const slip = await getRow('pending_slips', req.params.id);
      if (!slip || !token || slip.confirm_token !== token || slip.status !== 'pending' || !slip.items) {
        return res.status(404).json({ error: 'Slip not found or already processed.' });
      }
      res.json({ merchant: slip.merchant, items: JSON.parse(slip.items) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/line/chat-slips/:id/confirm', async (req, res) => {
    const token = String(req.body?.token || '');
    const slipId = req.params.id;
    // Client sends back which checkboxes ended up checked; re-fetching the
    // canonical items server-side (not trusting client-supplied amounts) —
    // the boolean array only says which of the stored items to keep.
    const selectedFlags = Array.isArray(req.body?.selected) ? req.body.selected : null;
    try {
      const result = await withTransaction(async (client) => {
        const claim = await client.query(
          `UPDATE pending_slips SET status = 'completed', confirmed_at = $3
           WHERE id = $1 AND confirm_token = $2 AND status = 'pending'
           RETURNING id, items, line_user_id`,
          [slipId, token, new Date().toISOString()]);
        if (!claim.rowCount) return null;
        const allItems = JSON.parse(claim.rows[0].items || '[]');
        const selected = allItems.filter((it, i) => selectedFlags ? !!selectedFlags[i] : it.selected);
        if (!selected.length) throw ZERO_SELECTED;
        const allowlist = await getAllowlist();
        const buyerName = allowlist.get(claim.rows[0].line_user_id) || 'LINE';
        await insertSelectedExpenses(client, slipId, buyerName, selected);
        return selected;
      });
      if (!result) return res.status(409).json({ error: 'This slip was already confirmed or the link is invalid.' });
      const total = result.reduce((s, i) => s + i.amount, 0);
      await logActivity('line-chat', 'EXPENSE', `slip #${slipId}: ${result.length} items, ${total} THB (LIFF)`);
      res.json({ ok: true, saved: result, total });
    } catch (e) {
      if (e === ZERO_SELECTED) return res.status(400).json({ error: 'ยังไม่มีรายการที่เลือกเลย' });
      fail(res, e);
    }
  });
}
