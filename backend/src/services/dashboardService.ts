/**
 * Per-meal read models: per-meal detail with a grounded suggestion and the
 * portions benchmark — all in
 * **Pixels wasted** (contracts/measurement.md): integer counts of foreground
 * pixels in validated leftover-food masks, one union per capture.
 *
 * All formulas come from Agent 6's analytics package (AGENTS.md 5.6): this
 * service only gathers each capture's counted attempt and measurements, makes
 * sure each service has one persisted simulated attendance value, and stores
 * generated insights.
 */

import {
  generateAttendance,
  summarizePixels,
  type PixelServiceSummary,
  type TextGateway,
  summarizePortionBenchmarks,
  portionDataVersion,
  generatePortionInsight,
  type PortionBenchmark,
  generatePixelInsight,
  computePixelDataVersion,
} from '@scrap/analytics';
import { notFound } from '../errors.js';
import type { BackendConfig } from '../config.js';
import type { Repository } from '../repo/repository.js';
import { countedOf, type IngestionService } from './ingestionService.js';
import type { AnalysisAttempt, Attendance, CaptureEvent, FoodMeasurement, Insight, MealLabel, MenuBundle } from '../types.js';

const MEALS: MealLabel[] = ['breakfast', 'lunch', 'dinner'];

export interface MealDetailResponse {
  serviceId: string;
  date: string;
  meal: MealLabel;
  summary: PixelServiceSummary;
  attendance: Attendance;
  /**
   * Grounded in the Pixels-wasted-per-portion benchmark (AGENTS.md 7) when a
   * rate exists; otherwise in the meal's measured Pixels wasted.
   */
  insight: Insight | null;
  portionBenchmark: PortionBenchmark;
}

export class DashboardService {
  constructor(
    private readonly repo: Repository,
    private readonly ingestion: IngestionService,
    private readonly config: BackendConfig,
    private readonly gateway?: TextGateway,
  ) {}

  /** One persisted simulated value per service; never re-rolled per request (6.3). */
  async ensureAttendance(menu: MenuBundle): Promise<Attendance> {
    const existing = await this.repo.getAttendance(menu.service.serviceId);
    if (existing) return existing;
    const generated = generateAttendance({
      hallId: menu.service.hallId,
      serviceId: menu.service.serviceId,
      serviceDate: menu.service.serviceDate,
      min: this.config.attendance.min,
      max: this.config.attendance.max,
      ...(this.config.attendance.seed ? { seed: this.config.attendance.seed } : {}),
    });
    await this.repo.upsertAttendance(generated);
    return generated;
  }

  /** Captures plus only the counted (latest succeeded) attempt per dish, never double-counted. */
  private async observations(menu: MenuBundle): Promise<{
    captures: CaptureEvent[];
    countedAttempts: Map<string, AnalysisAttempt>;
    latestAttempts: Map<string, AnalysisAttempt>;
    measurements: FoodMeasurement[];
  }> {
    const captures = await this.repo.listCaptureEvents({
      hallId: menu.service.hallId,
      serviceId: menu.service.serviceId,
    });
    const countedAttempts = new Map<string, AnalysisAttempt>();
    const latestAttempts = new Map<string, AnalysisAttempt>();
    const measurements: FoodMeasurement[] = [];
    for (const event of captures) {
      const attempts = await this.repo.listAnalysisAttempts(event.eventId);
      const latest = attempts.at(-1);
      if (latest) latestAttempts.set(event.eventId, latest);
      if (event.state !== 'succeeded') continue;
      const counted = countedOf(attempts);
      if (!counted) continue;
      countedAttempts.set(event.eventId, counted);
      measurements.push(...(await this.repo.listMeasurementsByAttempt(counted.attemptId)));
    }
    return { captures, countedAttempts, latestAttempts, measurements };
  }

  private summarize(
    menu: MenuBundle,
    obs: Awaited<ReturnType<DashboardService['observations']>>,
    attendance: Attendance | null,
  ): PixelServiceSummary {
    return summarizePixels({
      service: menu.service,
      captures: obs.captures,
      countedAttempts: obs.countedAttempts,
      latestAttempts: obs.latestAttempts,
      measurements: obs.measurements,
      attendance,
      menuItems: menu.items,
    });
  }

  async serviceSummary(menu: MenuBundle, attendance?: Attendance | null): Promise<PixelServiceSummary> {
    return this.summarize(menu, await this.observations(menu), attendance ?? null);
  }

  async portionBenchmark(menu: MenuBundle): Promise<PortionBenchmark> {
    const captures = await this.repo.listCaptureEvents({ hallId: menu.service.hallId, serviceId: menu.service.serviceId });
    const measurements: FoodMeasurement[] = [];
    for (const event of captures) {
      if (event.state === 'succeeded') measurements.push(...await this.ingestion.countedMeasurements(event));
    }
    return summarizePortionBenchmarks({ service: menu.service, menuItems: menu.items, captures, measurements,
      portions: await this.repo.listPortionsServed(menu.service.serviceId, menu.service.menuVersion) });
  }

  async meal(hallId: string, date: string, meal: MealLabel): Promise<MealDetailResponse> {
    if (!MEALS.includes(meal)) {
      throw notFound('MEAL_NOT_FOUND', 'Pick Breakfast, Lunch, or Dinner.', { meal });
    }
    const [menu] = await this.repo.findMenus(hallId, date, meal);
    if (!menu) {
      throw notFound('MENU_NOT_FOUND', 'No menu for this meal yet. Add one in Menus.', {
        hallId,
        serviceDate: date,
        mealLabel: meal,
      });
    }
    const attendance = await this.ensureAttendance(menu);
    const summary = await this.serviceSummary(menu, attendance);
    const portionBenchmark = await this.portionBenchmark(menu);
    // Per-portion rates rank suggestions when they exist (AGENTS.md 7); without
    // one, suggest from the meal's measured Pixels wasted so each meal gets a tip.
    const insight = portionBenchmark.items.some((i) => i.pixelsWastedPerPortion !== null)
      ? await this.portionInsightFor(portionBenchmark)
      : await this.pixelInsightFor(menu, summary);
    return { serviceId: menu.service.serviceId, date, meal, summary, attendance, insight, portionBenchmark };
  }

  /** Pixels-wasted suggestion, stored and reused for identical data like the portion insight. */
  private async pixelInsightFor(menu: MenuBundle, summary: PixelServiceSummary): Promise<Insight> {
    const dataVersion = `pixel-summary-v1|${computePixelDataVersion(summary)}`;
    const stored = (await this.repo.listInsights(menu.service.hallId)).find(
      (i) => i.dataVersion === dataVersion && (i.source === 'gemini' || this.gateway === undefined),
    );
    if (stored) return stored;
    const captures = await this.repo.listCaptureEvents({ hallId: menu.service.hallId, serviceId: menu.service.serviceId });
    const times = captures.map((c) => c.capturedAt).filter((t) => Number.isFinite(Date.parse(t))).sort();
    const now = new Date().toISOString();
    const insight = await generatePixelInsight(
      {
        hallId: menu.service.hallId,
        windowStart: times[0] ?? now,
        windowEnd: times.at(-1) ?? now,
        summary,
        menuItems: menu.items,
        dataVersion,
      },
      this.gateway ? { gateway: this.gateway } : {},
    );
    await this.repo.upsertInsight(insight);
    return insight;
  }

  /**
   * Reuse the stored insight for this exact data; generate (Gemini or labeled
   * fallback) when it changed. A stored fallback is retried with Gemini on the
   * next read, so a transient provider failure doesn't stick.
   */
  private async portionInsightFor(benchmark: PortionBenchmark): Promise<Insight> {
    const dataVersion = portionDataVersion(benchmark);
    const stored = (await this.repo.listInsights(benchmark.hallId)).find(
      (i) => i.dataVersion === dataVersion && (i.source === 'gemini' || this.gateway === undefined),
    );
    if (stored) return stored;

    const captures = await this.repo.listCaptureEvents({ hallId: benchmark.hallId, serviceId: benchmark.serviceId });
    const times = captures.map(c => c.capturedAt).filter(t => Number.isFinite(Date.parse(t))).map(t => new Date(t).toISOString()).sort();
    const now = new Date().toISOString();
    const insight = await generatePortionInsight(benchmark, this.gateway, { windowStart: times[0] ?? now, windowEnd: times.at(-1) ?? now });
    await this.repo.upsertInsight(insight);
    return insight;
  }
}
