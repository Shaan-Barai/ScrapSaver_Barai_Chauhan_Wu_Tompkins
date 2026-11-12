import { beforeEach, describe, expect, it } from 'vitest'
import { getMealDetail, getMenu, saveUserMenu } from './api'
import { setApiLatency } from './mockApi'
import { addDays, todayIso } from '../lib/dates'

beforeEach(() => {
  localStorage.clear()
  setApiLatency(0)
})

const today = todayIso()
const yesterday = addDays(today, -1)

describe('getMealDetail', () => {
  async function someDayWithData() {
    for (let i = 1; i <= 20; i++) {
      const date = addDays(today, -i)
      const d = await getMealDetail(date, 'lunch')
      if (d) return d
    }
    throw new Error('mock data should have at least one lunch in 20 days')
  }

  it('items are sorted by waste, shares sum to ~100%, swipes labeled simulated', async () => {
    const d = await someDayWithData()
    const shares = d.items.map((i) => i.shareOfMealPixelsPercent)
    expect([...d.items].sort((a, b) => b.pixelsWasted - a.pixelsWasted)).toEqual(d.items)
    expect(shares.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 5)
    expect(d.mealSwipes.source).toBe('simulated')
    expect(d.pixelsWasted).toBe(d.items.reduce((s, i) => s + i.pixelsWasted, 0))
    expect(d.tip?.recommendation.length).toBeGreaterThan(0)
  })

  it('returns null when the day has no menu', async () => {
    // find a mock missing-menu day in the past year
    let missing: string | undefined
    for (let i = 1; i <= 200 && !missing; i++) {
      const date = addDays(yesterday, -i)
      if ((await getMenu(date)) === null) missing = date
    }
    expect(missing).toBeDefined()
    expect(await getMealDetail(missing!, 'dinner')).toBeNull()
  })
})

describe('user menus (localStorage overlay, swapped for POST /api/menus later)', () => {
  it('saveUserMenu persists and wins over mock data', async () => {
    const date = addDays(today, 10) // future: no mock menu
    expect(await getMenu(date)).toBeNull()
    await saveUserMenu(date, {
      breakfast: [{ itemId: 'item_bagels', displayName: 'Bagels' }],
      lunch: [],
      dinner: [],
    })
    const menu = await getMenu(date)
    expect(menu?.source).toBe('user')
    expect(menu?.meals.breakfast[0].displayName).toBe('Bagels')
  })
})
