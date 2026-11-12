/**
 * Mock data access (VITE_USE_MOCK=1 and unit tests); see api.ts.
 *
 * Every function answers from src/data/mockData.ts (plus the manager's own
 * menus kept in localStorage), with the same signatures as liveApi.ts.
 */
import { ALL_TIME_START, addDays, eachDay, todayIso } from '../lib/dates'
import { AuthRequiredError, notifyAuthRequired } from './authEvents'
import {
  mockCaptureImages,
  mockCaptures,
  mockImpactDashboard,
  mockMealDetail,
  mockMenuFor,
  mockRecommendation,
} from './mockData'
import type {
  AuthSession,
  DemoStatus,
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
  TryImageJob,
  TryImageStatus,
  TryImageSubmitted,
} from './types'
import { MEALS } from './types'

/** Artificial latency so loading states are visible; tests set it to 0. */
let latencyMs = 250
export function setApiLatency(ms: number): void {
  latencyMs = ms
}
function wait(): Promise<void> {
  return latencyMs > 0 ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve()
}

// ---------------------------------------------------------------------------
// Manager-uploaded menus (localStorage overlay; backend POST /api/menus later)
// ---------------------------------------------------------------------------

const USER_MENUS_KEY = 'scrap.userMenus.v1'

function readUserMenus(): Record<IsoDate, DayMenu> {
  try {
    const raw = localStorage.getItem(USER_MENUS_KEY)
    return raw ? (JSON.parse(raw) as Record<IsoDate, DayMenu>) : {}
  } catch {
    return {}
  }
}

function writeUserMenus(menus: Record<IsoDate, DayMenu>): void {
  localStorage.setItem(USER_MENUS_KEY, JSON.stringify(menus))
}

function menuFor(date: IsoDate, today: IsoDate): DayMenu | null {
  const user = readUserMenus()[date]
  if (user) return user
  return mockMenuFor(date, today)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Menu in effect on a date (manager-uploaded wins over demo data). */
export async function getMenu(date: IsoDate): Promise<DayMenu | null> {
  await wait()
  return menuFor(date, todayIso())
}

/** Save (or replace) the manager's menu for one day. */
export async function saveUserMenu(date: IsoDate, meals: Record<MealLabel, MenuItemLite[]>): Promise<DayMenu> {
  await wait()
  const menu: DayMenu = { date, menuId: `menu_user_${date}`, source: 'user', meals }
  const all = readUserMenus()
  all[date] = menu
  writeUserMenus(all)
  const counts = storedPortions()
  for (const meal of MEALS) delete counts[`mock|${date}|${meal}`]
  localStorage.setItem(PORTIONS_KEY, JSON.stringify(counts))
  return menu
}

/** Right-panel detail for one meal service; null = no menu / no data. */
export async function getMealDetail(date: IsoDate, meal: MealLabel): Promise<MealDetail | null> {
  await wait()
  const today = todayIso()
  const detail = mockMealDetail(date, meal, menuFor(date, today), today)
  if (!detail) return null
  const service = await getPortionService(date, meal)
  if (!service) return detail
  return { ...detail, portionBenchmark: await getPortionBenchmark(service.serviceId),
    tip: { source: 'fallback_rules', recommendation: 'Demo area estimates cannot establish pixels wasted per portion. Save portions served and connect validated mask counts before acting on this benchmark.' } }
}

const PORTIONS_KEY = 'scrap.portions.demo.v1'
function storedPortions(): Record<string, PortionService['portions']> {
  try { return JSON.parse(localStorage.getItem(PORTIONS_KEY) ?? '{}') } catch { return {} }
}

export async function getPortionService(date: IsoDate, meal: MealLabel): Promise<PortionService | null> {
  await wait()
  const menu = menuFor(date, todayIso())
  if (!menu || menu.meals[meal].length === 0) return null
  const serviceId = `mock|${date}|${meal}`
  const items = menu.meals[meal]
  const portions = (storedPortions()[serviceId] ?? []).filter(p => items.some(i => i.itemId === p.itemId))
  return { serviceId, menuVersion: 1, items, portions }
}

export async function savePortions(service: PortionService, entries: PortionEntry[]): Promise<void> {
  await wait()
  const seen = new Set<string>()
  for (const e of entries) {
    if (!service.items.some(i => i.itemId === e.itemId) || seen.has(e.itemId)) throw new Error('Unknown or duplicate menu item.')
    if (e.count !== null && (!Number.isInteger(e.count) || e.count < 0 || e.count > 4_294_967_295)) throw new Error('Use a nonnegative whole number for portions served.')
    seen.add(e.itemId)
  }
  const all = storedPortions()
  all[service.serviceId] = entries.filter((e): e is { itemId: string; count: number } => e.count !== null)
    .map(e => ({ ...e, source: 'demo' as const }))
  localStorage.setItem(PORTIONS_KEY, JSON.stringify(all))
}

export async function importPortionsCsv(service: PortionService, csv: string): Promise<void> {
  // Offline demo imports the generated, unquoted template. Live CSV parsing is server-side.
  const rows = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(row => row.split(','))
  const header = rows.shift()?.map(c => c.trim()) ?? []
  if (header.join(',') !== 'service_id,menu_version,item_id,portions_served') throw new Error('Use the downloaded portions template.')
  const entries = rows.map(row => {
    const [serviceId, version, itemId, count] = row.map(c => c.trim())
    if (row.length !== 4 || serviceId !== service.serviceId || version !== String(service.menuVersion)) throw new Error('The CSV service or menu version differs.')
    if (count !== '' && !/^\d+$/.test(count)) throw new Error('Use nonnegative whole-number counts.')
    return { itemId, count: count === '' ? null : Number(count) }
  })
  await savePortions(service, entries)
}

export async function getPortionBenchmark(serviceId: string): Promise<PortionBenchmark> {
  const [, date, meal] = serviceId.split('|')
  const service = await getPortionService(date, meal as MealLabel)
  if (!service) throw new Error('No menu for this meal.')
  return {
    hallId: 'demo', serviceId, serviceDate: date, menuVersion: service.menuVersion,
    items: service.items.map(i => ({ ...i, portionsServed: service.portions.find(p => p.itemId === i.itemId)?.count ?? null,
      portionsSource: service.portions.some(p => p.itemId === i.itemId) ? 'demo' : null,
      pixelsWasted: null, pixelsWastedPerPortion: null, measuredCaptures: 0,
      unavailableReason: 'Demo area estimates are not validated mask counts.' })),
    capturedDishes: 0, measuredDishes: 0, excludedMeasurements: 0,
    label: 'Pixels wasted per portion', unit: 'pixels/portion',
    coverageNote: 'Demo data. Validated masks are not connected; no per-portion values are available.',
  }
}

// ---------------------------------------------------------------------------
// Waste impact dashboard (BIG-PLAN D1-D8)
// ---------------------------------------------------------------------------

/** All time (start 'all') in demo mode: the last 366 days of mock history, like the API's chart cap. */
function windowStart(start: IsoDate, end: IsoDate): IsoDate {
  return start === ALL_TIME_START ? addDays(end, -365) : start
}

export async function getImpactDashboard(start: IsoDate, end: IsoDate): Promise<ImpactDashboard> {
  await wait()
  return mockImpactDashboard(windowStart(start, end), end, todayIso())
}

export async function getDailyImpact(start: IsoDate, end: IsoDate): Promise<DailyImpactPoint[]> {
  await wait()
  const today = todayIso()
  return eachDay(windowStart(start, end), end).map((date) => {
    const t = mockImpactDashboard(date, date, today).totals
    return {
      date,
      pixels: t.analyzedCaptures > 0 ? t.pixels : null,
      kgCo2e: t.kgCo2e ?? null,
      co2Points: t.co2Points,
      analyzedCaptures: t.analyzedCaptures,
      calibratedCaptures: t.physicalCoverage?.calibratedCaptures ?? 0,
    }
  })
}

export async function getCaptures(start: IsoDate, end: IsoDate): Promise<CaptureListItem[]> {
  await wait()
  const hidden = mockHidden()
  return mockCaptures(windowStart(start, end), end, todayIso()).filter((c) => !hidden.has(c.eventId))
}

// Admin curation, demo only: hidden plate ids live in this browser.
const HIDDEN_KEY = 'scrap.mock.hiddenCaptures.v1'

function mockHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export async function getAdminCaptures(start: IsoDate, end: IsoDate): Promise<AdminCaptureItem[]> {
  await wait()
  const hidden = mockHidden()
  return mockCaptures(windowStart(start, end), end, todayIso()).map((c) => ({ ...c, hidden: hidden.has(c.eventId) }))
}

export async function setCaptureVisibility(eventIds: string[], hidden: boolean): Promise<void> {
  await wait()
  requireSession()
  const set = mockHidden()
  for (const id of eventIds) {
    if (hidden) set.add(id)
    else set.delete(id)
  }
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]))
  } catch {
    // private mode: the change lasts for this page only
  }
}

export async function getCaptureImages(eventId: string): Promise<CaptureImages> {
  await wait()
  const images = mockCaptureImages(eventId, todayIso(), new Date())
  if (!images) throw new Error('This plate is no longer available.')
  return images
}

// Try an Image (demo fixture: tiny placeholder pictures, not a real analysis).
const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const tryPolls = new Map<string, number>()

export async function getTryImageStatus(): Promise<TryImageStatus> {
  await wait()
  return { available: true, waiting: 0, running: false, maxWaiting: 3, hourlyRemaining: 20 }
}

export async function getTryImageSample(): Promise<Blob> {
  await wait()
  return new Blob(['demo'], { type: 'image/jpeg' })
}

export async function submitTryImage(_blob: Blob): Promise<TryImageSubmitted> {
  await wait()
  const id = `try_demo_${tryPolls.size + 1}`
  tryPolls.set(id, 0)
  return { id, status: 'queued', position: 1 }
}

export async function getTryImageJob(id: string): Promise<TryImageJob> {
  await wait()
  const n = (tryPolls.get(id) ?? 0) + 1
  tryPolls.set(id, n)
  if (n < 2) return { id, status: 'running' }
  return {
    id,
    status: 'done',
    summary: {
      countStatus: 'complete',
      capturePixelsWasted: 42_000,
      foods: [
        { itemId: 'item_halal-rice', food: 'Halal Rice (demo)', pixelsWasted: 30_000 },
        { itemId: 'item_halal-chicken', food: 'Halal Chicken (demo)', pixelsWasted: 12_000 },
      ],
    },
    images: { original: PLACEHOLDER_PNG, boxes: PLACEHOLDER_PNG, masks: PLACEHOLDER_PNG, final: PLACEHOLDER_PNG },
  }
}

export async function getRecommendation(start: IsoDate, end: IsoDate): Promise<Recommendation> {
  await wait()
  return mockRecommendation(mockImpactDashboard(windowStart(start, end), end, todayIso()), new Date())
}

// ---------------------------------------------------------------------------
// Staff sign-in (IT_4 I11), demo only: the passcode is MOCK_PASSCODE and the
// "session" lives in this browser. Real sessions are httpOnly cookies set by
// the backend.
// ---------------------------------------------------------------------------

export const MOCK_PASSCODE = 'scrapsaver'
const SESSION_KEY = 'scrap.mock.session.v1'

function mockSignedIn(): boolean {
  try {
    return localStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return false
  }
}

/** Demo mutations behave like the backend: no session, no change (401). */
function requireSession(): void {
  if (!mockSignedIn()) {
    notifyAuthRequired()
    throw new AuthRequiredError()
  }
}

let mockReadOnly = false

/** Tests: make the demo backend report a read-only site (like READ_ONLY=1). */
export function setMockReadOnly(on: boolean): void {
  mockReadOnly = on
}

export async function getSession(): Promise<AuthSession> {
  await wait()
  return { signedIn: mockSignedIn(), authAvailable: true, readOnly: mockReadOnly }
}

export async function login(passcode: string): Promise<AuthSession> {
  await wait()
  if (passcode !== MOCK_PASSCODE) throw new Error("That passcode didn't work.")
  localStorage.setItem(SESSION_KEY, '1')
  return { signedIn: true, authAvailable: true }
}

// Demo data controls: the mock keeps its mode in memory.
let demoStatus: DemoStatus = { hallId: 'hall-main', mode: 'default', sampleLoaded: false, sampleCaptures: 0, clearedAt: null }
export async function getDemoStatus(): Promise<DemoStatus> {
  await wait()
  return { ...demoStatus }
}
export async function loadDemoData(): Promise<DemoStatus> {
  await wait()
  demoStatus = { ...demoStatus, mode: 'sample', sampleLoaded: true, sampleCaptures: 42, clearedAt: null }
  return { ...demoStatus }
}
export async function clearDemoData(): Promise<DemoStatus> {
  await wait()
  demoStatus = { ...demoStatus, mode: 'cleared', clearedAt: new Date().toISOString() }
  return { ...demoStatus }
}
export async function restoreDemoData(): Promise<DemoStatus> {
  await wait()
  demoStatus = { ...demoStatus, mode: 'default', clearedAt: null }
  return { ...demoStatus }
}

export async function regenerateRecommendation(start: IsoDate, end: IsoDate): Promise<Recommendation> {
  await wait()
  return mockRecommendation(mockImpactDashboard(windowStart(start, end), end, todayIso()), new Date())
}
