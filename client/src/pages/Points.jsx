import React, { useState, useEffect, useCallback } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';

// Shop-issued point links: pick an amount, create a single-use claim link and
// send it to the customer over LINE chat. The customer opens it in the rewards
// portal (customer.html?claim=<token>) and the points land on their account.
// Links never expire; unclaimed ones can be voided below.
const POINT_CHOICES = [1, 2, 3, 5, 10];

// Always route through liff.line.me when a LIFF ID is configured: LINE
// resolves that URL straight to the LIFF app's registered Endpoint URL and
// handles login itself, so it works regardless of which raw domain
// customer.html is actually served from. Opening the raw domain URL directly
// (customer.html?claim=...) instead makes liff.login()'s redirect_uri include
// the query string, which LINE's login rejects with a 400 on some LIFF app
// configs — liff.line.me sidesteps that entirely.
// VITE_PORTAL_BASE + raw domain is only a fallback for local dev / setups
// with no LIFF ID yet (VITE_DEV_LINE_USER testing).
const claimUrl = (token) => {
  const liffId = import.meta.env.VITE_LIFF_ID;
  if (liffId) return `https://liff.line.me/${liffId}?claim=${token}`;
  return `${(import.meta.env.VITE_PORTAL_BASE || window.location.origin).replace(/\/$/, '')}/customer.html?claim=${token}`;
};

const fmtTs = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');

export default function Points() {
  const { pushToast } = useData();
  const [points, setPoints] = useState(POINT_CHOICES[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState([]);
  // The most recently created link, echoed in a read-only field as a fallback
  // for when the clipboard API is unavailable (plain HTTP, older WebView).
  const [lastUrl, setLastUrl] = useState('');

  const refresh = useCallback(() => {
    api.pointsLinks({ limit: 100 }).then(setLinks).catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const createLink = async () => {
    setBusy(true);
    try {
      const r = await api.pointsLink({ points: Number(points), note: note.trim() || undefined });
      const url = claimUrl(r.token);
      setLastUrl(url);
      setNote('');
      refresh();
      const copied = await copyText(url);
      pushToast(copied
        ? `Link for ${r.points} point${r.points > 1 ? 's' : ''} copied — paste it in LINE chat.`
        : 'Link created — copy it from the box below.', 'success');
    } catch (e) {
      pushToast(e.message || 'Could not create the link.', 'warning');
    } finally {
      setBusy(false);
    }
  };

  const copyRow = async (l) => {
    const url = claimUrl(l.token);
    setLastUrl(url);
    pushToast((await copyText(url)) ? 'Link copied.' : 'Copy failed — use the box above.', 'info');
  };

  const voidLink = async (l) => {
    if (!confirm(`Void this unclaimed ${l.points}-point link?`)) return;
    try {
      await api.pointsLinkVoid(l.id);
      refresh();
      pushToast('Link voided.', 'success');
    } catch (e) {
      pushToast(e.message || 'Could not void the link.', 'warning');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header"><h3>Give points</h3></div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', padding: '0 16px 16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Points</label>
            <select className="form-control" style={{ width: 120 }} value={points}
              onChange={(e) => setPoints(Number(e.target.value))}>
              {POINT_CHOICES.map(p => <option key={p} value={p}>{p} point{p > 1 ? 's' : ''}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
            <label>Note (optional)</label>
            <input className="form-control" value={note} placeholder="e.g. order #0042, review reward"
              onChange={(e) => setNote(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={createLink}>
            <i className="fa-solid fa-link"></i> Create link &amp; copy
          </button>
        </div>
        {lastUrl && (
          <div style={{ display: 'flex', gap: 8, padding: '0 16px 16px' }}>
            <input className="form-control" readOnly value={lastUrl} onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary" onClick={async () => {
              pushToast((await copyText(lastUrl)) ? 'Link copied.' : 'Copy failed — select the text manually.', 'info');
            }}>
              <i className="fa-solid fa-copy"></i>
            </button>
          </div>
        )}
        <p className="helper-text" style={{ padding: '0 16px 16px', margin: 0 }}>
          Each link can be claimed once, by the first customer who opens it. Send it privately to one customer.
        </p>
      </div>

      <div className="card">
        <div className="card-header"><h3>Issued links</h3>
          <button className="btn btn-sm btn-secondary" onClick={refresh}><i className="fa-solid fa-rotate"></i> Refresh</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>Points</th><th>Status</th><th>Claimed by</th><th>Note</th><th>Created</th><th>Claimed</th><th></th>
            </tr></thead>
            <tbody>
              {links.length ? links.map(l => (
                <tr key={l.id}>
                  <td><strong>+{l.points}</strong></td>
                  <td>
                    <span className={`badge ${l.status === 'claimed' ? 'bg-green' : 'local'}`}>
                      {l.status === 'claimed' ? 'Claimed' : 'Pending'}
                    </span>
                  </td>
                  <td>{l.claimed_by || <span className="helper-text">—</span>}</td>
                  <td><span className="helper-text">{l.note || '—'}</span></td>
                  <td><span className="helper-text">{fmtTs(l.created_at)}{l.created_by ? ` · ${l.created_by}` : ''}</span></td>
                  <td><span className="helper-text">{fmtTs(l.claimed_at) || '—'}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {l.status !== 'claimed' && (
                      <>
                        <button className="btn btn-sm btn-secondary" title="Copy link" onClick={() => copyRow(l)}>
                          <i className="fa-solid fa-copy"></i>
                        </button>
                        <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} title="Void link" onClick={() => voidLink(l)}>
                          <i className="fa-solid fa-ban"></i>
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )) : <tr className="empty-row"><td colSpan={7}>No links issued yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
