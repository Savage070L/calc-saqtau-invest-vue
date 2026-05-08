/**
 * Калькулятор дополнительных покрытий (райдеров) — Saqtau Invest
 *
 * Покрытия (UI):
 *   Группа 1 (radio, SA-linked):  accidental_death
 *   Группа 2 (radio, SA-linked):  disability_accident_lumpsum
 *   Группа 3 (checkbox, fixed-sum): trauma | hospitalization
 *
 * Формула простых допов:
 *   gross_tariff   = ROUND((tariff × kMult + lAdd) × (1 + expenses) / (1 − acquisition), 4)
 *   annual_premium = gross_tariff × rider_sum
 *   rider_premium  = (frequency = 'single')
 *                    ? ROUND(annual_premium × term)
 *                    : ROUND(annual_premium × freqFactor)
 *
 * В Saqtau Invest нет КЗ, премиум-вейвера и аннуитета.
 */

import { PRODUCT_CONFIG } from '../config/product.js';
import { roundHalfUp }    from './calculator.js';

// ─── RidersCalculator ─────────────────────────────────────────────────────────

export class RidersCalculator {

  constructor(engine, config = PRODUCT_CONFIG) {
    this.engine       = engine;
    this.config       = config;
    this.ridersConfig = config.riders ?? {};
    this.freqAdj      = config.frequencyAdjustment;
  }

  _freqFactor(frequency) {
    return frequency === 'single' ? 1.0 : (this.freqAdj[frequency] ?? 1.0);
  }

  // ─── Простой доп (SA-linked или fixed-sum) ────────────────────────────────

  calculateSimpleRider(riderName, riderSum, term, frequency, kMult = 1.0, lAdd = 0.0) {
    const rc          = this.ridersConfig[riderName] ?? {};
    const baseTariff  = rc.tariff ?? 0.0;
    const expenseRate = rc.expenses ?? 0.0;
    const acquisition = rc.acquisition ?? 0.0;

    const grossTariff = roundHalfUp(
      (baseTariff * kMult + lAdd) * (1.0 + expenseRate) / (1.0 - acquisition),
      4,
    );

    const freqFactor    = this._freqFactor(frequency);
    const annualPremium = grossTariff * riderSum;

    const riderPremium = frequency === 'single'
      ? roundHalfUp(annualPremium * term)
      : roundHalfUp(annualPremium * freqFactor);

    return {
      riderName,
      baseTariff,
      grossTariff,
      riderSum,
      annualPremium: Math.round(annualPremium * 100) / 100,
      riderPremium,
      frequency,
    };
  }

  // ─── Расчёт всех выбранных допов ──────────────────────────────────────────

  /**
   * @param {Object} params
   * @param {number} params.n        — срок договора
   * @param {string} params.frequency
   * @param {number} params.sumAssured
   * @param {Object} params.ridersSelection — { riderName: { enabled, sum } }
   */
  calculateAllRiders(params) {
    const {
      n, frequency,
      sumAssured,
      ridersSelection = {},
      kMult = 1.0, lAdd = 0.0,
    } = params;

    const results = {};
    let totalRiderPremium = 0.0;

    // SA-linked простые допы (rider_sum = SA): группы 1 и 2
    const saLinkedRiders = ['accidental_death', 'disability_accident_lumpsum'];
    for (const riderName of saLinkedRiders) {
      const sel = ridersSelection[riderName] ?? {};
      if (sel.enabled) {
        const riderSum = sel.sum ?? sumAssured;
        const r = this.calculateSimpleRider(riderName, riderSum, n, frequency, kMult, lAdd);
        results[riderName]  = r;
        totalRiderPremium  += r.riderPremium;
      }
    }

    // Fixed-sum простые допы (группа 3)
    const fixedRiders = ['trauma', 'hospitalization'];
    for (const riderName of fixedRiders) {
      const sel = ridersSelection[riderName] ?? {};
      if (sel.enabled) {
        const riderSum = sel.sum ?? 0;
        if (riderSum > 0) {
          const r = this.calculateSimpleRider(riderName, riderSum, n, frequency, kMult, lAdd);
          results[riderName] = r;
          totalRiderPremium += r.riderPremium;
        }
      }
    }

    return { riders: results, totalRiderPremium };
  }
}
