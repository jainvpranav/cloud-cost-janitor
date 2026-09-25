import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const THEME_KEY = 'ccj.theme';
export const THEMES = ['light', 'dark'];

const ThemeContext = createContext(null);

/** Resolve the effective theme, honouring the OS preference when set to 'system'. */
function resolve(mode, systemPrefersDark) {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode === 'dark' ? 'dark' : 'light';
}

/** `matchMedia` is missing in some environments (jsdom, SSR, old WebViews). */
function prefersDark() {
  try {
    return typeof window !== 'undefined' && Boolean(window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    return false;
  }
}

function readStoredMode() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* localStorage unavailable (private mode / disabled) — fall through */
  }
  return 'system';
}

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(readStoredMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState(prefersDark);

  // Track OS-level changes so 'system' stays live.
  useEffect(() => {
    let mq;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }
    const onChange = (e) => setSystemPrefersDark(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);

  const theme = resolve(mode, systemPrefersDark);

  // Paint the document. The inline script in index.html has already done this
  // before first paint, so this keeps it in sync on mount and on every change.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }, [theme]);

  const setTheme = useCallback((next) => {
    setMode(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* non-fatal: preference simply won't persist */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const value = useMemo(
    () => ({ theme, mode, setTheme, toggle, systemPrefersDark }),
    [theme, mode, setTheme, toggle, systemPrefersDark]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside a <ThemeProvider>');
  return ctx;
}
