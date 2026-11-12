/**
 * Live data access against Agent 5's backend (backend/README.md). Same
 * function signatures as mockApi.ts; api.ts picks one.
 *
 * Everything is Pixels wasted (contracts/measurement.md): integer counts of
 * foreground pixels in validated leftover-food masks, shown as-is (no
 * "waste units" scaling). Totals, shares, and exclusions are computed
 * server-side by analytics/; components never redo canonical math.
 */
import { loadSettings } from '../state/settings'
import { AuthRequiredError, notifyAuthRequired } from './authEvents'
import type {
  AuthSession,
  CaptureImages,
  AdminCaptureItem,
  CaptureListItem,
  ImpactDashboard,
  Recommendation,
  DailyImpactPoint,
  DayMenu,
  IsoDate,
  MealDetail,
  MealLabel,
  MenuItemLite,
  PortionService,
  PortionEntry,
  PortionBenchmark,
  DemoStatus,
  TryImageJob,
  TryImageStatus,
  TryImageSubmitted,
} from './types'
import { MEALS } from './types'

/** contracts/decisions.md: hall timezone until a hall config says otherwise. */
const HALL_TIMEZONE = 'America/Detroit'

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

function hallId(): string {
  return loadSettings()?.hallId ?? 'hall-main'
}

interface ApiErrorBody {
  error?: { code: string; message: string }
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new Error("Can't reach ScrapSaver right now. Try again in a minute.")
  }
  const body = (await res.json().catch(() => ({}))) as T & ApiErrorBody
  const method = (init?.method ?? 'GET').toUpperCase()
  if (res.status === 401 && method !== 'GET' && !path.startsWith('/api/auth/')) {
    // A change was refused because no staff session is active (IT_4 I11).
    notifyAuthRequired()
    throw new AuthRequiredError()
  }
  if (!res.ok) {
    throw new ApiRequestError(res.status, body.error?.code, body.error?.message ?? 'Something went wrong on the server.')
  }
  return body
}

/** 404 "not found yet" answers become null (friendly empty states), other errors surface. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null
    throw err
  }
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

interface MenuBundle {
  service: { serviceId: string; menuId: string; menuVersion: number; serviceDate: string; mealLabel: MealLabel }
  items: { itemId: string; displayName: string }[]
}

export async function getMenu(date: IsoDate): Promise<DayMenu | null> {
  const body = await orNull(call<{ menus: MenuBundle[] }>(`/api/menus?${q({ hallId: hallId(), date })}`))
  if (!body || body.menus.length === 0) return null
  const meals: Record<MealLabel, MenuItemLite[]> = { breakfast: [], lunch: [], dinner: [] }
  for (const m of body.menus) {
    meals[m.service.mealLabel] = m.items.map((i) => ({ itemId: i.itemId, displayName: i.displayName }))
  }
  return { date, menuId: body.menus[0].service.menuId, source: 'user', meals }
}

/** POST /api/menus/upload, parsed and versioned by the backend (data/ helpers). */
export async function saveUserMenu(date: IsoDate, meals: Record<MealLabel, MenuItemLite[]>): Promise<DayMenu> {
  const day: Record<string, unknown> = { date }
  for (const meal of MEALS) if (meals[meal].length > 0) day[meal] = meals[meal].map((i) => i.displayName)
  await call('/api/menus/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hallId: hallId(), hallTimezone: HALL_TIMEZONE, days: [day] }),
  })
  return (await getMenu(date)) ?? { date, menuId: '', source: 'user', meals }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

interface MealResponse {
  portionBenchmark?: PortionBenchmark
  serviceId: string
  summary: {
    captureCount: number
    countedCaptureCount: number
    emptyPlateCount: number
    excludedCaptureCount: number
    pixelsWasted: number
    unclassifiedPixels: number
    items: {
      itemId: string
      displayName?: string
      pixelsWasted: number
      shareOfMealPixelsPercent: number | null
      grams?: number | null
      kgCo2e?: number | null
      waterLitres?: number | null
      physicalUnavailableReason?: MealDetail['items'][number]['physicalUnavailableReason']
    }[]
  }
  attendance: { count: number; source: 'simulated' }
  insight: { recommendation: string; source: 'gemini' | 'fallback_rules' } | null
}

/** Null = no menu or no scanned plate yet (friendly empty state). */
export async function getMealDetail(date: IsoDate, meal: MealLabel): Promise<MealDetail | null> {
  const body = await orNull(call<MealResponse>(`/api/dashboard/meal?${q({ hallId: hallId(), date, meal })}`))
  // Scanned plates that weren't counted stay visible (AGENTS.md §9.7).
  if (!body || body.summary.captureCount === 0) return null
  const s = body.summary
  return {
    serviceId: body.serviceId,
    date,
    meal,
    pixelsWasted: s.pixelsWasted,
    unclassifiedPixels: s.unclassifiedPixels,
    platesScanned: s.captureCount,
    coverage: {
      platesCounted: s.countedCaptureCount,
      emptyPlates: s.emptyPlateCount,
      platesLeftOut: s.excludedCaptureCount,
    },
    mealSwipes: { count: body.attendance.count, source: 'simulated' },
    items: s.items.map((i) => ({
      itemId: i.itemId,
      displayName: i.displayName ?? i.itemId,
      pixelsWasted: i.pixelsWasted,
      shareOfMealPixelsPercent: i.shareOfMealPixelsPercent ?? 0,
      // IT_4 I8: estimated amounts when the backend sends them; absent = unavailable.
      grams: i.grams ?? null,
      kgCo2e: i.kgCo2e ?? null,
      waterLitres: i.waterLitres ?? null,
      ...(i.physicalUnavailableReason ? { physicalUnavailableReason: i.physicalUnavailableReason } : {}),
    })),
    tip: body.insight && { recommendation: body.insight.recommendation, source: body.insight.source },
    ...(body.portionBenchmark ? { portionBenchmark: body.portionBenchmark } : {}),
  }
}

export async function getPortionService(date: IsoDate, meal: MealLabel): Promise<PortionService | null> {
  const menus = await orNull(call<{ menus: MenuBundle[] }>(`/api/menus?${q({ hallId: hallId(), date, meal })}`))
  const menu = menus?.menus[0]
  if (!menu) return null
  const body = await call<{ menu: MenuBundle; portions: PortionService['portions'] }>(
    `/api/portions-served?${q({ hallId: hallId(), serviceId: menu.service.serviceId })}`)
  return { serviceId: body.menu.service.serviceId, menuVersion: body.menu.service.menuVersion, items: body.menu.items, portions: body.portions }
}

export async function savePortions(service: PortionService, entries: PortionEntry[]): Promise<void> {
  await call(`/api/portions-served?${q({ hallId: hallId(), serviceId: service.serviceId })}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceId: service.serviceId, menuVersion: service.menuVersion, entries }),
  })
}

export async function importPortionsCsv(service: PortionService, csv: string): Promise<void> {
  await call(`/api/portions-served/csv?${q({ hallId: hallId(), serviceId: service.serviceId })}`, {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
  })
}

export async function getPortionBenchmark(serviceId: string): Promise<PortionBenchmark> {
  return call(`/api/portions-served/benchmark?${q({ hallId: hallId(), serviceId })}`)
}

// ---------------------------------------------------------------------------
// Waste impact dashboard (BIG-PLAN v2, contracts/types.ts waste-impact section)
// ---------------------------------------------------------------------------

export async function getImpactDashboard(start: IsoDate, end: IsoDate): Promise<ImpactDashboard> {
  return call<ImpactDashboard>(`/api/dashboard/impact?${q({ hallId: hallId(), start, end })}`)
}

export async function getDailyImpact(start: IsoDate, end: IsoDate): Promise<DailyImpactPoint[]> {
  const { days } = await call<{ days: DailyImpactPoint[] }>(`/api/dashboard/impact/daily?${q({ hallId: hallId(), start, end })}`)
  return days
}

/** Accepts a bare array or `{ captures: [...] }`. */
export async function getCaptures(start: IsoDate, end: IsoDate): Promise<CaptureListItem[]> {
  const body = await call<CaptureListItem[] | { captures: CaptureListItem[] }>(
    `/api/captures?${q({ hallId: hallId(), start, end })}`,
  )
  return Array.isArray(body) ? body : body.captures ?? []
}

/** Short-lived read links for a plate's photo, AI outline image and masks. Ask again when they expire. */
export async function getCaptureImages(eventId: string): Promise<CaptureImages> {
  return call<CaptureImages>(`/api/captures/${encodeURIComponent(eventId)}/images`)
}

// ---------------------------------------------------------------------------
// Admin curation: choose which plates the dashboard shows (staff session only)
// ---------------------------------------------------------------------------

/** Every plate in the window, hidden ones included. Needs a staff session (401 otherwise). */
export async function getAdminCaptures(start: IsoDate, end: IsoDate): Promise<AdminCaptureItem[]> {
  const body = await call<{ captures: AdminCaptureItem[] }>(`/api/admin/captures?${q({ hallId: hallId(), start, end })}`)
  return body.captures ?? []
}

/** Hide plates from (or show them on) the dashboard. Nothing is deleted. */
export async function setCaptureVisibility(eventIds: string[], hidden: boolean): Promise<void> {
  await call('/api/admin/captures/visibility', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventIds, hidden }),
  })
}

export async function getRecommendation(start: IsoDate, end: IsoDate): Promise<Recommendation> {
  return call<Recommendation>(`/api/recommendation?${q({ hallId: hallId(), start, end })}`)
}

// ---------------------------------------------------------------------------
// Staff sign-in (IT_4 I11): reads are public, every change needs a session.
// The backend sets an httpOnly cookie; the browser sends it on same-origin
// requests, so nothing here stores a token.
// ---------------------------------------------------------------------------

interface MeBody {
  authenticated?: boolean
  signedIn?: boolean
  admin?: boolean
  role?: string
  /** false = this server runs without sign-in (local open mode). */
  authRequired?: boolean
  /** true = the public read-only site: no uploads, edits, AI or camera calls. */
  readOnly?: boolean
  expiresAt?: string
}

function signedInFrom(body: MeBody): boolean {
  return Boolean(body.authenticated ?? body.signedIn ?? body.admin ?? body.role === 'admin')
}

export async function getSession(): Promise<AuthSession> {
  try {
    const body = await call<MeBody>('/api/auth/me')
    return {
      signedIn: signedInFrom(body),
      authAvailable: body.authRequired !== false,
      ...(body.readOnly === true ? { readOnly: true } : {}),
      ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    }
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'READ_ONLY') return { signedIn: false, authAvailable: true, readOnly: true }
    if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) return { signedIn: false, authAvailable: true }
    // An older backend without sign-in: changes are not gated there.
    if (err instanceof ApiRequestError && err.status === 404) return { signedIn: true, authAvailable: false }
    throw err
  }
}

export async function login(passcode: string): Promise<AuthSession> {
  try {
    const body = await call<MeBody>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    })
    return { signedIn: true, authAvailable: true, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) }
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) throw new Error("That passcode didn't work.")
    if (err instanceof ApiRequestError && err.status === 429) throw new Error('Too many tries. Wait a minute, then try again.')
    throw err
  }
}

// Try an Image: one-off analysis of an uploaded photo (nothing is added to the dashboard).
export async function getTryImageStatus(): Promise<TryImageStatus> {
  return call<TryImageStatus>('/api/try-image/status')
}

export async function getTryImageSample(): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/try-image/sample.jpg`)
  } catch {
    throw new Error("Can't reach ScrapSaver right now. Try again in a minute.")
  }
  if (!res.ok) throw new Error('The sample photo is not available right now.')
  return res.blob()
}

/** Raw image body (no JSON); the backend reads the type from Content-Type. */
export async function submitTryImage(blob: Blob): Promise<TryImageSubmitted> {
  return call<TryImageSubmitted>('/api/try-image', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
}

export async function getTryImageJob(id: string): Promise<TryImageJob> {
  return call<TryImageJob>(`/api/try-image/${encodeURIComponent(id)}`)
}

/** Asks the AI for a new recommendation for these days (saved with its inputs). */
export async function regenerateRecommendation(start: IsoDate, end: IsoDate): Promise<Recommendation> {
  return call<Recommendation>('/api/recommendation/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hallId: hallId(), start, end }),
  })
}

// Demo data controls: load labeled sample scans, hide older scans, or restore the default view.
export async function getDemoStatus(): Promise<DemoStatus> {
  return call<DemoStatus>(`/api/demo/status?${q({ hallId: hallId() })}`)
}

function demoPost(action: 'load' | 'clear-data' | 'restore'): Promise<DemoStatus> {
  return call<DemoStatus>(`/api/demo/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hallId: hallId() }),
  })
}
export const loadDemoData = () => demoPost('load')
export const clearDemoData = () => demoPost('clear-data')
export const restoreDemoData = () => demoPost('restore')
