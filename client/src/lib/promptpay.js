// Thai PromptPay EMVCo QR payload builder (the same format Thai banking apps
// scan at every shop counter). Supports a phone number or a 13-digit national
// id / tax id as the PromptPay target, with an optional fixed amount.

const tlv = (id, value) => id + String(value.length).padStart(2, '0') + value;

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — required by the EMV spec.
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// target: phone ("0812345678", also accepts +66 / dashes) or 13-digit id.
// amount: optional number; when present the QR is amount-locked (dynamic).
export function promptpayPayload(target, amount) {
  const digits = String(target || '').replace(/\D/g, '');
  let accountTlv;
  if (digits.length === 13) {
    accountTlv = tlv('02', digits); // national id / tax id
  } else {
    // Phone numbers are encoded as 0066 + number without the leading 0.
    const local = digits.startsWith('66') ? digits.slice(2) : digits.replace(/^0/, '');
    accountTlv = tlv('01', '0066' + local);
  }
  const merchant = tlv('00', 'A000000677010111') + accountTlv;
  const hasAmount = amount != null && Number(amount) > 0;
  let payload =
    tlv('00', '01') +                       // payload format indicator
    tlv('01', hasAmount ? '12' : '11') +    // dynamic (one-shot) vs static QR
    tlv('29', merchant) +                   // merchant account info (PromptPay AID)
    tlv('53', '764') +                      // currency: THB
    (hasAmount ? tlv('54', Number(amount).toFixed(2)) : '') +
    tlv('58', 'TH');
  payload += '6304'; // CRC id+len, checksum computed over everything incl. these 4 chars
  return payload + crc16(payload);
}
