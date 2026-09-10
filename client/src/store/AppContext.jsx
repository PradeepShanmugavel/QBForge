import React, { createContext, useContext, useState } from 'react';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [step,       setStep]       = useState(1);
  const [token,      setToken]      = useState('');
  const [user,       setUser]       = useState(null);          // decoded JWT

  function goStep(n) { setStep(n); window.scrollTo(0, 0); }

  return (
    <AppContext.Provider value={{
      step, goStep,
      token, setToken,
      user,  setUser
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
};
