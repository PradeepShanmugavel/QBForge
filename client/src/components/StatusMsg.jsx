import React from 'react';

const ICONS = { info: 'ℹ️', ok: '✅', warn: '⚠️', err: '✕' };

export default function StatusMsg({ type = 'info', children, loading }) {
  if (!children && !loading) return null;
  return (
    <div className={`status-msg status-${type}`}>
      {loading
        ? <span className="spinner" />
        : <span className="status-icon">{ICONS[type]}</span>}
      <span>{children}</span>
    </div>
  );
}
