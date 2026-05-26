'use client'

import { useTheme } from 'next-themes'

export function useAppTheme() {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme !== 'light'

  return {
    isDark,
    resolvedTheme,
    dockviewTheme: isDark ? 'dockview-theme-dark' : 'dockview-theme-light',
    monacoTheme: isDark ? 'vs-dark' : 'vs-light',
  } as const
}
