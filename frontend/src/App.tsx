import { useCallback, useEffect, useState } from 'react'
import { AdminPage } from './pages/AdminPage'
import { BehindScenesPage, TRY_PATH } from './pages/BehindScenesPage'
import { DashboardPage } from './pages/DashboardPage'
import { LandingPage } from './pages/LandingPage'
import { MenusPage } from './pages/MenusPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PortionsPage } from './pages/PortionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StatisticsPage } from './pages/StatisticsPage'
import { AuthProvider, useAuth } from './state/auth'
import { DEFAULT_SETTINGS, useHallSettings } from './state/settings'

type Page = 'landing' | 'dashboard' | 'statistics' | 'menus' | 'portions' | 'behind' | 'settings' | 'admin'

const NAV: { page: Page; label: string; path: string }[] = [
  { page: 'dashboard', label: 'Dashboard', path: '/dashboard' },
  { page: 'statistics', label: 'Statistics', path: '/statistics' },
  { page: 'menus', label: 'Menus', path: '/menus' },
  { page: 'portions', label: 'Portions served', path: '/portions' },
  { page: 'behind', label: 'Behind the scenes', path: '/behind-the-scenes' },
  { page: 'settings', label: 'Settings', path: '/settings' },
]

/** Unlisted: the owner opens /admin directly to choose which plates are counted. */
const HIDDEN: { page: Page; label: string; path: string }[] = [{ page: 'admin', label: 'Admin', path: '/admin' }]

/** Remembered per browser: the left menu can be hidden to give the page more room. */
const NAV_HIDDEN_KEY = 'scrapsaver.navHidden'

function readNavHidden(): boolean {
  try {
    return localStorage.getItem(NAV_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Path -> page; null = no such page (404). The server sends index.html for every non-API path. */
export function pageForPath(pathname: string): Page | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/' || path === '/index.html') return 'landing'
  if (path === '/schedule') return 'statistics'
  if (path === TRY_PATH) return 'behind'
  return [...NAV, ...HIDDEN].find((n) => n.path === path)?.page ?? null
}

function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next: string) => {
    if (next !== window.location.pathname) window.history.pushState(null, '', next)
    setPath(next)
  }, [])
  return [path, go]
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}

function Shell() {
  const { settings, update } = useHallSettings()
  const { readOnly } = useAuth()
  const [path, go] = usePath()
  const page = pageForPath(path)
  const [dataRevision, setDataRevision] = useState(0)
  const [navHidden, setNavHidden] = useState(readNavHidden)
  useEffect(() => {
    try {
      if (navHidden) localStorage.setItem(NAV_HIDDEN_KEY, '1')
      else localStorage.removeItem(NAV_HIDDEN_KEY)
    } catch {
      /* storage unavailable: the choice lasts until the page is reloaded */
    }
  }, [navHidden])

  const title = page === 'landing' ? null : page ? [...NAV, ...HIDDEN].find((n) => n.page === page)!.label : 'Page not found'
  useEffect(() => {
    document.title = title ? `${title} · ScrapSaver` : 'ScrapSaver'
  }, [title])

  if (page === 'landing') return <LandingPage onStart={() => go('/dashboard')} />
  const hall = settings ?? DEFAULT_SETTINGS

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-cream focus:p-2 focus:text-ink">
        Skip to content
      </a>
      {/* Left: narrow nav, black with white text */}
      <nav className={`flex w-full shrink-0 flex-col bg-ink p-4 text-cream ${navHidden ? 'lg:w-auto lg:px-2' : 'lg:w-56'}`} aria-label="Main">
        <div className={`flex items-center justify-between gap-2 ${navHidden ? 'lg:justify-center' : ''}`}>
          <a
            href="/"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              go('/')
            }}
            className={`font-display text-2xl font-bold tracking-tight ${navHidden ? 'lg:hidden' : ''}`}
          >
            ScrapSaver
          </a>
          <button
            type="button"
            onClick={() => setNavHidden((h) => !h)}
            aria-expanded={!navHidden}
            aria-controls={navHidden ? undefined : 'main-nav-links'}
            title={navHidden ? 'Show menu' : 'Hide menu'}
            className="flex shrink-0 items-center gap-2 rounded-btn px-2 py-2 text-sm text-cream hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
            <span className={navHidden ? 'lg:sr-only' : ''}>{navHidden ? 'Show menu' : 'Hide menu'}</span>
          </button>
        </div>
        {!navHidden && (
          <ul id="main-nav-links" className="mt-3 flex flex-wrap gap-1 lg:mt-6 lg:block lg:space-y-1">
            {NAV.map((item) => (
              <li key={item.page}>
                <a
                  href={item.path}
                  aria-current={page === item.page ? 'page' : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                    e.preventDefault()
                    go(item.path)
                  }}
                  className={`block w-full rounded-btn px-3 py-2 text-left text-base ${
                    page === item.page ? 'bg-cream font-semibold text-ink' : 'text-cream hover:underline'
                  }`}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <main id="main" className="min-w-0 flex-1 overflow-y-auto bg-cream p-4 sm:p-6">
        {readOnly && (
          <p role="note" className="mb-5 rounded-card border border-linen bg-cream px-4 py-2 text-sm text-ink">
            This site shows demo data only
          </p>
        )}
        {page === 'dashboard' && <DashboardPage dataRevision={dataRevision} />}
        {page === 'statistics' && <StatisticsPage dataRevision={dataRevision} />}
        {page === 'menus' && <MenusPage />}
        {page === 'portions' && <PortionsPage onSaved={() => setDataRevision((r) => r + 1)} />}
        {page === 'behind' && <BehindScenesPage path={path} onNavigate={go} />}
        {page === 'settings' && <SettingsPage settings={hall} onSave={update} onDataChanged={() => setDataRevision((r) => r + 1)} />}
        {page === 'admin' && <AdminPage />}
        {page === null && <NotFoundPage onHome={() => go('/dashboard')} />}
      </main>
    </div>
  )
}
