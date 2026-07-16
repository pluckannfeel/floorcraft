import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { apiClient, registerAuthFailureHandler } from '../api/client'

export interface AuthUser {
  id: number | string
  email: string
  full_name?: string
  [key: string]: unknown
}

interface AuthContextValue {
  user: AuthUser | null
  isAuthenticated: boolean
  /** True only during the initial app-boot auth check. */
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const clearAuth = useCallback(() => {
    setUser(null)
  }, [])

  // R30: register the interceptor's auth-failure callback so a 401/403
  // anywhere in the app clears local auth state (RequireAuth then redirects).
  useEffect(() => {
    registerAuthFailureHandler(clearAuth)
    return () => registerAuthFailureHandler(null)
  }, [clearAuth])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        // Prime the CSRF cookie before any subsequent POST/PATCH/DELETE
        // (including the login call) needs it.
        await apiClient.get('/auth/csrf/')
      } catch {
        // Non-fatal: if this fails we still attempt the /me/ check below;
        // a missing CSRF cookie will only matter once an unsafe request fires.
      }

      try {
        const { data } = await apiClient.get<AuthUser>('/auth/me/')
        if (!cancelled) setUser(data)
      } catch {
        if (!cancelled) setUser(null)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await apiClient.post<AuthUser>('/auth/login/', { email, password })
    setUser(data)
  }, [])

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout/')
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isLoading,
      login,
      logout,
    }),
    [user, isLoading, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// Context + hook colocated in one file is the standard React Context pattern.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
