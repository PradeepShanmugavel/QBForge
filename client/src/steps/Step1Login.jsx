import React, { useState } from 'react';
import { useApp } from '../store/AppContext';
import { decodeJWT, isExpired, getDisplayName } from '../utils/jwtDecoder';
import StatusMsg from '../components/StatusMsg';

export default function Step1Login() {
  const { setToken, setUser, goStep } = useApp();
  const [raw,    setRaw]    = useState('');
  const [status, setStatus] = useState(null); // { type, msg }

  function handleConnect() {
    setStatus(null);
    const trimmed = raw.trim();
    if (!trimmed) {
      setStatus({ type: 'err', msg: 'Please paste your JWT token.' });
      return;
    }

    const payload = decodeJWT(trimmed);
    if (!payload) {
      setStatus({ type: 'err', msg: 'Invalid token — make sure you pasted the full JWT (starts with eyJ...).' });
      return;
    }

    if (isExpired(payload)) {
      setStatus({ type: 'warn', msg: 'Token may be expired. Continuing — re-login to your portal if you see auth errors.' });
    }

    setToken(trimmed);
    setUser(payload);
    goStep(6); // straight to Add Solutions — the project-select screen was removed
  }

  return (
    <div className="step-content">
      <div className="card">
        <h2 className="card-title">Connect to Examly portal</h2>
        <p className="card-desc">
          Paste your JWT auth token — it's decoded locally and never sent anywhere except your own portal.
        </p>

        <div className="field">
          <label className="field-label">JWT Token</label>
          <textarea
            className="input input-mono"
            placeholder="Paste your token here (eyJhbGciOi...)"
            value={raw}
            onChange={e => setRaw(e.target.value)}
          />
          <p className="field-hint">
            How to get it: Open Examly portal → DevTools (F12) → Application tab →
            Local Storage → find <code>token</code> or <code>accessToken</code>
          </p>
        </div>

        {status && <StatusMsg type={status.type}>{status.msg}</StatusMsg>}

        <div className="nav-footer">
          <span className="nav-info">Step 1</span>
          <button className="btn btn-primary" onClick={handleConnect}>
            Verify &amp; Connect →
          </button>
        </div>
      </div>
    </div>
  );
}
