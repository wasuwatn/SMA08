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
import { pool, withTransaction, insertRow, updateRow, logActivity } from './db.js';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEV = process.env.NODE_ENV !== 'production';

const MAX_ITEMS = 10; // keeps the Flex card compact and bounds model output

// `new Date().toISOString()` is UTC — between 00:00 and 06:59 Thai time that
// books the expense on yesterday. Shift to ICT (UTC+7) before taking the date.
const bangkokToday = () =>
  new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0];

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
Return every purchasable line item with its amount in Thai Baht (a text like "ค่ากาแฟ 40 ไข่ 60" has TWO items: ค่ากาแฟ 40 and ไข่ 60).
Choose "category" as the closest match from the allowed list; use "Other" when nothing fits.
"merchant" is the store/payee name if visible, else "".
If the input contains no expense items at all, return an empty "items" array.
Keep descriptions short (under 40 characters). Return at most ${MAX_ITEMS} items — merge minor lines if there are more.`;

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
      return { merchant: '', items: items.slice(0, MAX_ITEMS), raw: 'dev-fallback' };
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
      max_tokens: 1500,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'expense_extraction',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['merchant', 'items'],
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
              }
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
  return { merchant: String(parsed.merchant || '').trim(), items, raw: rawText };
}

// ---------------------------------------------------------------------------
// Flex card: item list with per-row remove/restore buttons + confirm/cancel.

function buildSlipFlex(slip, items) {
  const selected = items.filter(i => i.selected);
  const total = selected.reduce((s, i) => s + i.amount, 0);
  const rows = items.map((it, i) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
    contents: [
      { type: 'text', text: it.selected ? '✅' : '➖', flex: 0, size: 'sm' },
      {
        type: 'box', layout: 'vertical', flex: 5,
        contents: [
          { type: 'text', text: it.description, size: 'sm', wrap: true,
            ...(it.selected ? {} : { color: '#aaaaaa', decoration: 'line-through' }) },
          { type: 'text', text: it.category, size: 'xxs', color: '#999999' }
        ]
      },
      { type: 'text', text: `${it.amount}฿`, flex: 2, size: 'sm', align: 'end',
        ...(it.selected ? {} : { color: '#aaaaaa' }) },
      { type: 'button', style: 'link', height: 'sm', flex: 2,
        action: { type: 'postback', label: it.selected ? 'ลบ' : 'คืน', data: `exp:t:${slip.id}:${i}` } }
    ]
  }));
  return {
    type: 'flex',
    altText: `รายการค่าใช้จ่าย ${total} บาท (${selected.length} รายการ)`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: slip.merchant || 'รายการค่าใช้จ่าย', weight: 'bold', size: 'md', wrap: true },
          { type: 'separator' },
          ...rows
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `รวม ${total} บาท (${selected.length} รายการ)`, weight: 'bold', size: 'sm', align: 'center' },
          { type: 'button', style: 'primary', height: 'sm',
            action: { type: 'postback', label: `บันทึก ${selected.length} รายการ`, data: `exp:c:${slip.id}` } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'postback', label: 'ยกเลิก', data: `exp:x:${slip.id}` } }
        ]
      }
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
    const { merchant, items, raw } = await analyzeExpense({ text, image });

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
    await lineReply(replyToken, buildSlipFlex(slip, withSelection));
  } catch (e) {
    console.error('lineExpense: analysis failed for slip', stub.id, e.message);
    await updateRow('pending_slips', stub.id, { status: 'error' });
    // A re-sent photo/text is a new LINE message id → fresh row, clean retry.
    await lineReply(replyToken, textMsg('อ่านรายการไม่สำเร็จ ขออภัยค่ะ 🙏 ลองส่งใหม่อีกครั้ง'));
  }
}

// ---------------------------------------------------------------------------
// Postback pipeline: exp:t:<slipId>:<idx> toggle / exp:c:<slipId> confirm /
// exp:x:<slipId> cancel. Signature already proves the event came from LINE;
// requiring the tapper to be the slip's sender closes the loop.

const ZERO_SELECTED = Symbol('zero-selected');

async function handlePostback(event, userId, buyerName) {
  const m = /^exp:(t|c|x):(\d+)(?::(\d+))?$/.exec(String(event.postback?.data || ''));
  if (!m) return; // not ours (e.g. future postbacks from other features)
  const [, action, slipIdStr, idxStr] = m;
  const slipId = Number(slipIdStr);
  const replyToken = event.replyToken;

  if (action === 't') {
    // FOR UPDATE: two quick taps race the read-modify-write on the JSON blob.
    const updated = await withTransaction(async (client) => {
      const { rows: [slip] } = await client.query(
        'SELECT * FROM pending_slips WHERE id = $1 FOR UPDATE', [slipId]);
      if (!slip || slip.line_user_id !== userId || slip.status !== 'pending') return null;
      const items = JSON.parse(slip.items || '[]');
      const idx = Number(idxStr);
      if (!items[idx]) return null;
      items[idx].selected = !items[idx].selected;
      await client.query('UPDATE pending_slips SET items = $2 WHERE id = $1',
        [slipId, JSON.stringify(items)]);
      return { slip, items };
    });
    if (!updated) {
      await lineReply(replyToken, textMsg('รายการนี้ถูกบันทึกหรือยกเลิกไปแล้วค่ะ'));
      return;
    }
    await lineReply(replyToken, buildSlipFlex(updated.slip, updated.items));
    return;
  }

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
        const date = bangkokToday();
        const rows = [];
        for (const it of selected) {
          rows.push(await insertRow('expenses', {
            date,
            description: it.description,
            amount: it.amount,
            buyer: buyerName,
            category: it.category || 'Other',
            note: `LINE chat slip #${slipId}`
          }, client));
        }
        await client.query('UPDATE pending_slips SET expense_id = $2 WHERE id = $1',
          [slipId, rows[0].id]);
        return selected;
      });
    } catch (e) {
      if (e !== ZERO_SELECTED) throw e;
      await lineReply(replyToken, textMsg('ยังไม่มีรายการที่เลือกอยู่เลย — กด "คืน" รายการที่ต้องการ หรือกดยกเลิกถ้าไม่ต้องการบันทึก'));
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
}
