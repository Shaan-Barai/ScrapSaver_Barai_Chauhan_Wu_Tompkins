/**
 * Sample history for the dashboard charts (DEMO_SEED).
 *
 * Fills ~14 days of breakfast/lunch/dinner with SAMPLE scans so the trend
 * chart, per-portion ranking and recommendation have something to show
 * before real scans accumulate. Everything it writes is flagged:
 *   - its own services/menus/items (`svc_demo_…`, `menu_demo_…`), never a
 *     real one; a slot that already has a real service is skipped,
 *   - captures with source 'demo' (no photo: imageObjectId 'demo:none'),
 *     scan rows with demo: true, portions with source 'demo',
 *   - and every row is listed in demo_marker first, so `npm run demo:clear`
 *     (clear_demo_data) removes exactly these rows and nothing real.
 * Pixel values are generated, not measured: deterministic for a seed, with a
 * per-food waste tendency and a mild downward trend over the window.
 */

import { DEMO_PORTION_RANGES, WASTE_FACTOR_MENU_TEXT, factorKeyFor, portionRole } from 'scrap-data';
import { badRequest } from '../errors.js';
import type { DemoMarker, Repository } from '../repo/repository.js';
import { ItemNameResolver } from './itemNames.js';
import type {
  AnalysisAttempt,
  CaptureEvent,
  FoodMeasurement,
  ImageGeometry,
  MealLabel,
  MenuBundle,
  MenuItem,
  PortionsServed,
  ScanInfo,
} from '../types.js';

export const DEMO_TIME_ZONE = 'America/Detroit';

export interface DemoStatus {
  hallId: string;
  mode: 'default' | 'sample' | 'cleared';
  sampleLoaded: boolean;
  sampleCaptures: number;
  clearedAt: string | null;
}

export const DEMO_HISTORY_VERSION = 'demo-history-v1';
const DEMO_IMAGE = 'demo:none';
const GEOMETRY: ImageGeometry = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' };

export interface DemoSeedOptions {
  hallId: string;
  /** Last day of the history (hall local date, YYYY-MM-DD). */
  endDate: string;
  days?: number;
  seed?: string;
  timeZone?: string;
}

export interface DemoSeedResult {
  services: number;
  captures: number;
  measurements: number;
  /** Day/meal slots skipped because a real (or earlier demo) service exists. */
  skippedSlots: string[];
}

/** Meal → foods (by CSV name) and local serving time. Dinner is the full 23-food menu. */
const MEALS: Array<{ meal: MealLabel; time: string; foods: string[] | 'all'; plates: [number, number] }> = [
  {
    meal: 'breakfast',
    time: '08:00',
    foods: ['Oven Roasted Garlic Potatoes', 'Baked Sweet Potatoes', 'Farro', 'Cheese Bread', 'Strawberry Shortcake Bar', 'Pumpkin Pie'],
    plates: [4, 8],
  },
  {
    meal: 'lunch',
    time: '12:00',
    foods: [
      'Broccoli Cheddar Soup', 'Cheese Pizza', 'Pepperoni Pizza', 'Panzanella Salad', 'Sticky Rice',
      'Vegetable Stir Fry Blend', 'Michigan Farmers 4 Bean Stew', 'Golden Cake with Chocolate Frosting',
    ],
    plates: [6, 12],
  },
  { meal: 'dinner', time: '17:30', foods: 'all', plates: [8, 14] },
];

/** Typical leftover area (pixels in the 1024x1024 frame) per food role. */
const ROLE_PIXELS: Record<ReturnType<typeof portionRole>, number> = {
  pizza: 15000,
  entree: 22000,
  side: 12000,
  soup: 16000,
  dessert: 8000,
};

/** Deterministic PRNG in [0, 1) for a key (FNV-1a + xorshift). */
export function demoRandom(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return (h >>> 0) / 0x1_0000_0000;
}

function intIn(key: string, min: number, max: number): number {
  return min + Math.floor(demoRandom(key) * (max - min + 1));
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** UTC instant for a hall-local date + "HH:MM" (two-pass offset correction, DST-safe). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const target = Date.parse(`${date}T${time}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    const shown = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    guess += target - shown;
  }
  return new Date(guess);
}

export const DEMO_COPIES_VERSION = 'demo-copies-v1';

export interface DemoCopyOptions {
  hallId: string;
  /** Last day to fill (hall local date, YYYY-MM-DD). */
  endDate: string;
  /** How many days back from endDate (default 56, at most 120). */
  days?: number;
  seed?: string;
  timeZone?: string;
}

export interface DemoCopyResult {
  /** Real plates the copies were made from. */
  sourcePlates: number;
  services: number;
  captures: number;
  measurements: number;
  /** Day/meal slots skipped because a service already exists (real, sample, or earlier copies). */
  skippedSlots: number;
}

/** Copied lunches and dinners: local start time and plates per service (weekends get fewer). */
const COPY_MEALS: Array<{ meal: MealLabel; time: string; plates: [number, number] }> = [
  { meal: 'lunch', time: '11:40', plates: [2, 5] },
  { meal: 'dinner', time: '17:20', plates: [3, 7] },
];

/** One real, counted plate and everything a copy repeats. */
interface CopySource {
  event: CaptureEvent;
  scan: ScanInfo | undefined;
  attempt: AnalysisAttempt;
  measurements: FoodMeasurement[];
  /** Source itemId -> its menu row (for the display name and station). */
  items: Map<string, MenuItem>;
}

export class DemoService {
  constructor(
    private readonly repo: Repository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Demo copies (2026-11-01): spread the hall's real, counted plates over the
   * past weeks so the dashboard has history. Each copy repeats a real plate
   * exactly (same photo, AI outline, masks and pixel counts) on another day,
   * with a new time. Everything is labeled demo the same way as the sample
   * history: source 'demo', scan_info demo: true, its own `svc_demo_copy_…`
   * services and menus, portions with source 'demo', and a demo_marker for
   * every row, so clearing demo data removes exactly the copies. Image objects
   * are reused, never copied, and never deleted with the copies.
   */
  async spreadCopies(options: DemoCopyOptions): Promise<DemoCopyResult> {
    const days = options.days ?? 56;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.endDate) || !Number.isInteger(days) || days < 1 || days > 120) {
      throw badRequest('INVALID_DEMO_COPIES', 'Demo copies need endDate (YYYY-MM-DD) and 1-120 days.');
    }
    const seed = options.seed ?? DEMO_COPIES_VERSION;
    const { hallId } = options;
    const names = new ItemNameResolver(this.repo);
    const services = await this.repo.listServices(hallId);
    const taken = new Set(services.map((s) => `${s.serviceDate}|${s.mealLabel}`));

    // Real plates (never sample scans or earlier copies) whose count the totals use.
    const sources: CopySource[] = [];
    for (const event of await this.repo.listCaptureEvents({ hallId })) {
      if (event.source === 'demo' || event.state !== 'succeeded') continue;
      const succeeded = (await this.repo.listAnalysisAttempts(event.eventId)).filter((a) => a.status === 'succeeded');
      succeeded.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attemptId.localeCompare(b.attemptId));
      const attempt = succeeded.at(-1);
      const countStatus = attempt?.segmentation?.countStatus;
      if (!attempt || (countStatus !== 'complete' && countStatus !== 'empty')) continue;
      const measurements = await this.repo.listMeasurementsByAttempt(attempt.attemptId);
      if (!measurements.every((m) => m.method === 'mask_pixel_count' && m.maskCount?.validated === true)) continue;
      const menu = await this.repo.getMenuByService(event.serviceId);
      const items = await names.items(menu, [
        ...measurements.map((m) => m.itemId),
        ...(attempt.segmentation?.regions ?? []).map((r) => r.itemId),
      ]);
      sources.push({ event, scan: await this.repo.getScanInfo(event.eventId), attempt, measurements, items });
    }
    sources.sort((a, b) => a.event.eventId.localeCompare(b.event.eventId));
    const result: DemoCopyResult = { sourcePlates: sources.length, services: 0, captures: 0, measurements: 0, skippedSlots: 0 };
    if (sources.length === 0) return result;

    // Menu template: the latest real service's items and portions (dinner has the full menu).
    const real = services
      .filter((s) => !s.serviceId.startsWith('svc_demo'))
      .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate) || Number(b.mealLabel === 'dinner') - Number(a.mealLabel === 'dinner'));
    const template = real[0] ? await this.repo.getMenuByService(real[0].serviceId) : undefined;
    const templatePortions = template
      ? await this.repo.listPortionsServed(template.service.serviceId, template.service.menuVersion)
      : [];
    const templateCount = new Map<string, number>();
    for (const p of templatePortions) {
      const name = template!.items.find((i) => i.itemId === p.itemId)?.displayName;
      if (name) templateCount.set(name, p.count);
    }
    // Every food a copy can name: the template menu plus anything the plates measured.
    const foods = new Map<string, { displayName: string; category?: string; description?: string }>();
    for (const i of template?.items ?? []) foods.set(i.displayName, i);
    for (const src of sources) for (const i of src.items.values()) if (!foods.has(i.displayName)) foods.set(i.displayName, i);

    const timeZone = options.timeZone ?? template?.service.hallTimezone ?? DEMO_TIME_ZONE;
    const nowMs = this.now();
    for (let d = days - 1; d >= 0; d--) {
      const date = addDays(options.endDate, -d);
      const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
      for (const plan of COPY_MEALS) {
        if (taken.has(`${date}|${plan.meal}`)) {
          result.skippedSlots++;
          continue;
        }
        const slot = `${hallId}_${date}_${plan.meal}`;
        const serviceId = `svc_demo_copy_${slot}`;
        const menuId = `menu_demo_copy_${slot}`;
        let plates = intIn(`${seed}|plates|${slot}`, plan.plates[0], plan.plates[1]);
        if (weekend) plates = Math.max(1, Math.round(plates * 0.6));
        // Distinct real plates for this meal, in a seeded order.
        const picked = sources
          .map((src) => ({ src, r: demoRandom(`${seed}|pick|${slot}|${src.event.eventId}`) }))
          .sort((a, b) => a.r - b.r)
          .slice(0, Math.min(plates, sources.length))
          .map((x) => x.src);
        const start = zonedToUtc(date, plan.time, timeZone).getTime();
        let at = start;
        const times = picked.map((_, p) => (at += (p === 0 ? 0 : 4 + Math.floor(demoRandom(`${seed}|gap|${slot}|${p}`) * 9)) * 60_000));
        const kept = picked.filter((_, p) => times[p]! <= nowMs);
        if (kept.length === 0) continue;

        const itemIdFor = (displayName: string) => `item_demo_copy_${slot}_${factorKeyFor(displayName)}`;
        const items: MenuItem[] = [...foods.values()].map((f) => ({
          itemId: itemIdFor(f.displayName),
          menuId,
          displayName: f.displayName,
          ...(f.category ? { category: f.category } : {}),
          ...(f.description ? { description: f.description } : {}),
        }));
        const bundle: MenuBundle = {
          service: { serviceId, hallId, hallTimezone: timeZone, serviceDate: date, mealLabel: plan.meal, menuId, menuVersion: 1 },
          items,
        };
        // The template's portion counts by food; foods it does not list get a seeded demo count.
        const portions: PortionsServed[] = items.map((item) => {
          const [min, max] = DEMO_PORTION_RANGES[portionRole(factorKeyFor(item.displayName), item.category ?? '')];
          return {
            recordId: JSON.stringify([serviceId, 1, item.itemId]),
            hallId,
            serviceId,
            serviceDate: date,
            menuId,
            menuVersion: 1,
            itemId: item.itemId,
            count: templateCount.get(item.displayName) ?? intIn(`${seed}|portions|${serviceId}|${item.itemId}`, min, max),
            source: 'demo',
            updatedAt: zonedToUtc(date, '22:00', timeZone).toISOString(),
          };
        });

        const copies = kept.map((src, p) => {
          const n = String(p + 1).padStart(2, '0');
          const eventId = `cap_demo_copy_${slot}_${n}`;
          const attemptId = `att_demo_copy_${slot}_${n}`;
          const capturedAt = new Date(times[p]!).toISOString();
          const mapItem = (id: string | null) => (id === null ? null : itemIdFor(src.items.get(id)?.displayName ?? id));
          const regionIds = new Map<string, string>();
          const seg = src.attempt.segmentation;
          const segmentation = seg
            ? {
                ...seg,
                regions: seg.regions.map((r, k) => {
                  const regionId = `rgn_demo_copy_${slot}_${n}_${k}`;
                  regionIds.set(r.regionId, regionId);
                  return { ...r, regionId, eventId, attemptId, itemId: mapItem(r.itemId) };
                }),
              }
            : undefined;
          const baselineVersions = Object.fromEntries(
            Object.entries(src.attempt.baselineVersions).map(([itemId, v]) => [mapItem(itemId)!, v]),
          );
          const attempt: AnalysisAttempt = {
            ...src.attempt,
            eventId,
            attemptId,
            menuId,
            menuVersion: 1,
            baselineVersions,
            createdAt: capturedAt,
            ...(segmentation ? { segmentation } : {}),
          };
          const measurements: FoodMeasurement[] = src.measurements.map((m, k) => {
            const { regionIds: _derived, ...rest } = m;
            void _derived;
            return {
              ...rest,
              measurementId: `msr_demo_copy_${slot}_${n}_${k}`,
              eventId,
              attemptId,
              itemId: mapItem(m.itemId),
              ...(m.maskCount ? { maskCount: { ...m.maskCount, menuId, menuVersion: 1 } } : {}),
            };
          });
          const event: CaptureEvent = { ...src.event, eventId, hallId, serviceId, capturedAt, source: 'demo', state: 'succeeded' };
          const scan: ScanInfo = {
            eventId,
            deviceId: 'demo-copy',
            timestampBasis: 'demo',
            ...(src.scan?.originalImageObjectId ? { originalImageObjectId: src.scan.originalImageObjectId } : {}),
            ...(src.scan?.originalSha256 ? { originalSha256: src.scan.originalSha256 } : {}),
            ...(src.scan?.sourceName ? { sourceName: src.scan.sourceName } : {}),
            demo: true,
          };
          return { event, scan, attempt, measurements, regions: [...regionIds.values()] };
        });

        const markers: DemoMarker[] = [
          { tableName: 'meal_service', rowKey: serviceId },
          ...items.map((i) => ({ tableName: 'menu_item' as const, rowKey: i.itemId })),
          ...portions.map((p) => ({ tableName: 'portions_served' as const, rowKey: p.recordId })),
          ...copies.flatMap(({ event, attempt, measurements, regions }) => [
            { tableName: 'capture_event' as const, rowKey: event.eventId },
            { tableName: 'scan_info' as const, rowKey: event.eventId },
            { tableName: 'analysis_attempt' as const, rowKey: attempt.attemptId },
            { tableName: 'capture_count' as const, rowKey: attempt.attemptId },
            { tableName: 'attempt_calibration' as const, rowKey: attempt.attemptId },
            ...regions.map((regionId) => ({ tableName: 'segmentation_region' as const, rowKey: regionId })),
            ...measurements.map((m) => ({ tableName: 'food_measurement' as const, rowKey: m.measurementId })),
          ]),
        ];
        // Markers first, so a failure part-way leaves only removable rows.
        await this.repo.recordDemoMarkers(markers);
        await this.repo.upsertMenu(bundle);
        await this.repo.replacePortionsServed(serviceId, 1, portions);
        for (const { event, scan, attempt, measurements } of copies) {
          await this.repo.upsertCaptureEvent(event);
          await this.repo.upsertScanInfo(scan);
          await this.repo.recordAnalysis(attempt, measurements);
          result.captures++;
          result.measurements += measurements.length;
        }
        result.services++;
        taken.add(`${date}|${plan.meal}`);
      }
    }
    return result;
  }

  async seedHistory(options: DemoSeedOptions): Promise<DemoSeedResult> {
    const days = options.days ?? 14;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.endDate) || !Number.isInteger(days) || days < 1 || days > 60) {
      throw badRequest('INVALID_DEMO_SEED', 'Demo history needs endDate (YYYY-MM-DD) and 1-60 days.');
    }
    const seed = options.seed ?? DEMO_HISTORY_VERSION;
    const timeZone = options.timeZone ?? 'America/Detroit';
    const { hallId } = options;
    const existing = await this.repo.listServices(hallId);
    const taken = new Set(existing.map((s) => `${s.serviceDate}|${s.mealLabel}`));
    const result: DemoSeedResult = { services: 0, captures: 0, measurements: 0, skippedSlots: [] };
    const foods = WASTE_FACTOR_MENU_TEXT;

    for (let d = days - 1; d >= 0; d--) {
      const date = addDays(options.endDate, -d);
      // 1.15 → 0.85 over the window: waste trending down, so the chart has a story.
      const trend = days === 1 ? 1 : 1.15 - (0.3 * (days - 1 - d)) / (days - 1);
      for (const plan of MEALS) {
        if (taken.has(`${date}|${plan.meal}`)) {
          result.skippedSlots.push(`${date} ${plan.meal}`);
          continue;
        }
        const slot = `${hallId}_${date}_${plan.meal}`;
        const serviceId = `svc_demo_${slot}`;
        const menuId = `menu_demo_${slot}`;
        const rows = plan.foods === 'all' ? foods : foods.filter((f) => (plan.foods as string[]).includes(f.food));
        const items: MenuItem[] = rows.map((f) => ({
          itemId: `item_demo_${slot}_${f.factorKey}`,
          menuId,
          displayName: f.food,
          category: f.station,
        }));
        const bundle: MenuBundle = {
          service: { serviceId, hallId, hallTimezone: timeZone, serviceDate: date, mealLabel: plan.meal, menuId, menuVersion: 1 },
          items,
        };
        const portions: PortionsServed[] = items.map((item) => {
          const [min, max] = DEMO_PORTION_RANGES[portionRole(factorKeyFor(item.displayName), item.category ?? '')];
          // Fewer people at breakfast.
          const scale = plan.meal === 'breakfast' ? 0.5 : 1;
          return {
            recordId: JSON.stringify([serviceId, 1, item.itemId]),
            hallId,
            serviceId,
            serviceDate: date,
            menuId,
            menuVersion: 1,
            itemId: item.itemId,
            count: Math.max(1, Math.round(intIn(`${seed}|portions|${serviceId}|${item.itemId}`, min, max) * scale)),
            source: 'demo',
            updatedAt: zonedToUtc(date, '22:00', timeZone).toISOString(),
          };
        });

        // Captures first in memory, so every marker exists before any row is written.
        const plates = intIn(`${seed}|plates|${serviceId}`, plan.plates[0], plan.plates[1]);
        const scans: Array<{ event: CaptureEvent; attempt: AnalysisAttempt; measurements: FoodMeasurement[] }> = [];
        for (let p = 0; p < plates; p++) {
          const eventId = `cap_demo_${slot}_${String(p + 1).padStart(2, '0')}`;
          const attemptId = `att_demo_${slot}_${String(p + 1).padStart(2, '0')}`;
          const capturedAt = new Date(zonedToUtc(date, plan.time, timeZone).getTime() + p * 4 * 60_000).toISOString();
          const clean = demoRandom(`${seed}|clean|${eventId}`) < 0.1;
          const count = clean ? 0 : intIn(`${seed}|count|${eventId}`, 1, 3);
          const picked = new Set<number>();
          const measurements: FoodMeasurement[] = [];
          for (let k = 0; k < count; k++) {
            const idx = intIn(`${seed}|food|${eventId}|${k}`, 0, items.length - 1);
            if (picked.has(idx)) continue;
            picked.add(idx);
            const item = items[idx]!;
            const key = factorKeyFor(item.displayName);
            // Each food has a stable waste tendency (0.5x-1.8x), so rankings are meaningful.
            const tendency = 0.5 + 1.3 * demoRandom(`${seed}|tendency|${key}`);
            const noise = 0.6 + 0.8 * demoRandom(`${seed}|px|${eventId}|${k}`);
            const base = ROLE_PIXELS[portionRole(key, item.category ?? '')];
            const pixels = Math.max(200, Math.round(base * tendency * noise * trend));
            const measurementId = `msr_demo_${slot}_${String(p + 1).padStart(2, '0')}_${k}`;
            measurements.push({
              measurementId,
              eventId,
              attemptId,
              itemId: item.itemId,
              remainingAreaPx: pixels,
              method: 'mask_pixel_count',
              maskCount: {
                pixelsWasted: pixels,
                maskObjectId: DEMO_IMAGE,
                geometry: GEOMETRY,
                menuId,
                menuVersion: 1,
                classificationVersion: DEMO_HISTORY_VERSION,
                segmentationVersion: DEMO_HISTORY_VERSION,
                processingVersion: DEMO_HISTORY_VERSION,
                assignment: 'exclusive',
                validated: true,
              },
              unavailableReason: 'sample data: no baseline',
              qualityFlags: [],
            });
          }
          const total = measurements.reduce((s, m) => s + m.remainingAreaPx, 0);
          const event: CaptureEvent = {
            eventId, hallId, serviceId, capturedAt, imageObjectId: DEMO_IMAGE, geometry: GEOMETRY, source: 'demo', qualityFlags: [], state: 'succeeded',
          };
          const attempt: AnalysisAttempt = {
            eventId,
            attemptId,
            menuId,
            menuVersion: 1,
            baselineVersions: {},
            model: DEMO_HISTORY_VERSION,
            promptVersion: DEMO_HISTORY_VERSION,
            status: 'succeeded',
            qualityFlags: [],
            createdAt: capturedAt,
            segmentation: {
              model: DEMO_HISTORY_VERSION,
              checkpoint: DEMO_HISTORY_VERSION,
              codeRevision: DEMO_HISTORY_VERSION,
              promptSource: 'gemini_box',
              settingsVersion: DEMO_HISTORY_VERSION,
              countingRuleVersion: DEMO_HISTORY_VERSION,
              status: total === 0 ? 'skipped' : 'succeeded',
              countStatus: total === 0 ? 'empty' : 'complete',
              capturePixelsWasted: total,
              widthPx: GEOMETRY.widthPx,
              heightPx: GEOMETRY.heightPx,
              regions: [],
            },
          };
          scans.push({ event, attempt, measurements });
        }

        const markers: DemoMarker[] = [
          { tableName: 'meal_service', rowKey: serviceId },
          ...items.map((i) => ({ tableName: 'menu_item' as const, rowKey: i.itemId })),
          ...portions.map((p) => ({ tableName: 'portions_served' as const, rowKey: p.recordId })),
          ...scans.flatMap(({ event, attempt, measurements }) => [
            { tableName: 'capture_event' as const, rowKey: event.eventId },
            { tableName: 'scan_info' as const, rowKey: event.eventId },
            { tableName: 'analysis_attempt' as const, rowKey: attempt.attemptId },
            { tableName: 'capture_count' as const, rowKey: attempt.attemptId },
            ...measurements.map((m) => ({ tableName: 'food_measurement' as const, rowKey: m.measurementId })),
          ]),
        ];
        await this.repo.recordDemoMarkers(markers);
        await this.repo.upsertMenu(bundle);
        await this.repo.replacePortionsServed(serviceId, 1, portions);
        for (const { event, attempt, measurements } of scans) {
          await this.repo.upsertCaptureEvent(event);
          await this.repo.upsertScanInfo({ eventId: event.eventId, deviceId: 'sample-data', timestampBasis: 'demo', demo: true });
          await this.repo.recordAnalysis(attempt, measurements);
          result.captures++;
          result.measurements += measurements.length;
        }
        result.services++;
      }
    }
    return result;
  }

  /** Dashboard demo-data state for a hall (GET /api/demo/status). */
  async status(hallId: string): Promise<DemoStatus> {
    const clearedAt = (await this.repo.getDashboardView(hallId))?.clearedAt ?? null;
    const sampleCaptures = (await this.repo.listCaptureEvents({ hallId, includeHidden: true })).filter((c) => c.source === 'demo').length;
    return {
      hallId,
      mode: clearedAt ? 'cleared' : sampleCaptures > 0 ? 'sample' : 'default',
      sampleLoaded: sampleCaptures > 0,
      sampleCaptures,
      clearedAt,
    };
  }

  /** Load dummy data: drop the cutoff and add the sample history (idempotent). */
  async load(hallId: string): Promise<DemoStatus> {
    await this.repo.setDashboardView(hallId, null, new Date(this.now()).toISOString());
    const endDate = new Intl.DateTimeFormat('en-CA', { timeZone: DEMO_TIME_ZONE }).format(new Date(this.now()));
    await this.seedHistory({ hallId, endDate });
    return this.status(hallId);
  }

  /** Clear data: remove sample rows and hide every capture taken before now. Real captures stay stored. */
  async clearData(hallId: string): Promise<DemoStatus> {
    await this.repo.clearDemoData();
    await this.repo.setDashboardView(hallId, new Date(this.now()).toISOString(), new Date(this.now()).toISOString());
    return this.status(hallId);
  }

  /** Restore default: remove sample rows and the cutoff, back to the live dashboard. */
  async restore(hallId: string): Promise<DemoStatus> {
    await this.repo.clearDemoData();
    await this.repo.setDashboardView(hallId, null, new Date(this.now()).toISOString());
    return this.status(hallId);
  }

  /** Remove every sample row (and only those). */
  async clear(): Promise<{ removedRows: number }> {
    return { removedRows: await this.repo.clearDemoData() };
  }
}
