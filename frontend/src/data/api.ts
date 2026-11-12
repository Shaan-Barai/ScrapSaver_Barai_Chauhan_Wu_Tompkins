/**
 * Data-access layer. Components only talk to this module.
 *
 * By default it calls the real backend (liveApi.ts → Agent 5's API, proxied
 * by Vite in dev). Set VITE_USE_MOCK=1 to run the dashboard on the
 * deterministic demo data in mockData.ts instead; unit tests always use mock.
 */
import * as live from './liveApi'
import * as mock from './mockApi'

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1' || import.meta.env.MODE === 'test'

const impl = USE_MOCK ? mock : live

export const getMenu = impl.getMenu
export const saveUserMenu = impl.saveUserMenu
export const getMealDetail = impl.getMealDetail
export const getPortionService = impl.getPortionService
export const savePortions = impl.savePortions
export const importPortionsCsv = impl.importPortionsCsv
export const getPortionBenchmark = impl.getPortionBenchmark
export const getImpactDashboard = impl.getImpactDashboard
export const getDailyImpact = impl.getDailyImpact
export const getCaptures = impl.getCaptures
export const getCaptureImages = impl.getCaptureImages
export const getAdminCaptures = impl.getAdminCaptures
export const setCaptureVisibility = impl.setCaptureVisibility
export const getRecommendation = impl.getRecommendation
export const regenerateRecommendation = impl.regenerateRecommendation
// Demo data controls (Settings).
export const getDemoStatus = impl.getDemoStatus
export const loadDemoData = impl.loadDemoData
export const clearDemoData = impl.clearDemoData
export const restoreDemoData = impl.restoreDemoData
// Try an Image: one-off analysis of an uploaded plate photo.
export const getTryImageStatus = impl.getTryImageStatus
export const getTryImageSample = impl.getTryImageSample
export const submitTryImage = impl.submitTryImage
export const getTryImageJob = impl.getTryImageJob

// Owner passcode (state/auth.tsx).
export const getSession = impl.getSession
export const login = impl.login
