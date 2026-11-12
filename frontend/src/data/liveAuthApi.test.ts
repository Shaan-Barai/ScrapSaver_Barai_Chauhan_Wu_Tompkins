/** Live API: staff sign-in and 401 handling (IT_4 §3 HTTP API). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCaptures, getSession, login, savePortions } from './liveApi'
import { AUTH_REQUIRED_EVENT, AuthRequiredError } from './authEvents'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sign-in', () => {
  it('reads the session from /api/auth/me (200 signed in, 401 signed out, 404 = no sign-in on this backend)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { authenticated: true, expiresAt: '2026-10-04T23:00:00Z' })))
    expect(await getSession()).toEqual({ signedIn: true, authAvailable: true, expiresAt: '2026-10-04T23:00:00Z' })
    // the backend's own shape: { admin, authRequired }
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: false, authRequired: true })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: true, authRequired: false })))
    expect(await getSession()).toEqual({ signedIn: true, authAvailable: false })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { authenticated: false })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'x' } })))
    expect(await getSession()).toEqual({ signedIn: true, authAvailable: false })
  })

  it('reads readOnly from /api/auth/me (absent = false) and from a READ_ONLY refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: false, authRequired: true, readOnly: true })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true, readOnly: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { admin: false, authRequired: true, readOnly: false })))
    expect((await getSession()).readOnly).toBeFalsy()
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: { code: 'READ_ONLY', message: 'This site is read-only.', retryable: false } })))
    expect(await getSession()).toEqual({ signedIn: false, authAvailable: true, readOnly: true })
  })

  it('a READ_ONLY refusal surfaces its message and never asks for the passcode', async () => {
    const heard = vi.fn()
    window.addEventListener(AUTH_REQUIRED_EVENT, heard)
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: { code: 'READ_ONLY', message: 'This site is read-only.', retryable: false } })))
    await expect(
      savePortions({ serviceId: 'svc', menuVersion: 1, items: [], portions: [] }, [{ itemId: 'rice', count: 1 }]),
    ).rejects.toThrow('This site is read-only.')
    window.removeEventListener(AUTH_REQUIRED_EVENT, heard)
    expect(heard).not.toHaveBeenCalled()
  })

  it('posts the passcode and explains a wrong one or too many tries, without firing the sign-in event', async () => {
    const fetchMock = vi.fn(async () => json(200, { authenticated: true }))
    vi.stubGlobal('fetch', fetchMock)
    await login('secret')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/auth/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ passcode: 'secret' })

    const heard = vi.fn()
    window.addEventListener(AUTH_REQUIRED_EVENT, heard)
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'BAD_PASSCODE', message: 'x' } })))
    await expect(login('nope')).rejects.toThrow("That passcode didn't work.")
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { code: 'RATE_LIMITED', message: 'x' } })))
    await expect(login('nope')).rejects.toThrow('Too many tries')
    expect(heard).not.toHaveBeenCalled()
    window.removeEventListener(AUTH_REQUIRED_EVENT, heard)
  })

  it('a 401 on any change fires the sign-in event and throws "Sign in to change this."', async () => {
    const heard = vi.fn()
    window.addEventListener(AUTH_REQUIRED_EVENT, heard)
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } })))
    const err = await savePortions({ serviceId: 's', menuVersion: 1, items: [], portions: [] }, []).catch((e) => e)
    expect(err).toBeInstanceOf(AuthRequiredError)
    expect(err.message).toBe('Sign in to change this.')
    expect(heard).toHaveBeenCalledOnce()
    // reads stay public: a 401 on a GET is just an error, no dialog
    await expect(getCaptures('2026-10-03', '2026-10-03')).rejects.toThrow()
    expect(heard).toHaveBeenCalledOnce()
    window.removeEventListener(AUTH_REQUIRED_EVENT, heard)
  })
})
