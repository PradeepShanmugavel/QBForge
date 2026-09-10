import React from 'react';
import { AppProvider, useApp } from './store/AppContext';
import Step1Login  from './steps/Step1Login';
import Step6AddSolutions from './steps/Step6AddSolutions';
import { getDisplayName } from './utils/jwtDecoder';

function Inner() {
  const { step, user } = useApp();
  const displayName = user ? getDisplayName(user) : null;

  // Just two screens now: log in, then Add Solutions — the earlier
  // "Test Packing" pipeline (project select / requirements / QB search /
  // questions QC / pack & push) was removed as a separate project.
  const STEPS = {
    1: <Step1Login />,
    6: <Step6AddSolutions />
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-brand">
          <span className="brand-icon">⚒️</span>
          <div>
            <div className="brand-name">QBForge</div>
            <div className="brand-sub">Examly · iamneo Automation</div>
          </div>
        </div>
        {displayName && (
          <div className="header-user">
            <span className="user-dot" />
            {displayName}
          </div>
        )}
      </header>

      {/* Step content */}
      <main className="app-main">
        {STEPS[step] || <Step1Login />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Inner />
    </AppProvider>
  );
}
