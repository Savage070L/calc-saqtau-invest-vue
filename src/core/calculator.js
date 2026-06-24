/**
 * Калькулятор полиса — Saqtau Invest
 *
 * Формулы брутто-премии (Gold-стиль):
 *   BP_1 = (Ax:n + G7×ax:n) / (ax:t − G6×ax:t − alfa)        [death benefit = full_sum_assured]
 *   BP_2 = (Ex:n + G7×ax:n) / (ax:t − IAx:n − G6×ax:t − alfa) [death benefit = paid_premiums]
 *
 * Аквизиционная нагрузка:
 *   alfa = G2 + G3×D(x+1)/D(x) + G4×D(x+2)/D(x) + G5×D(x+3)/D(x)
 *   Для t = 1: alfa = H4
 *
 * Актуарные величины:
 *   Ax:n  = (M(x) − M(x+n) + D(x+n)) / D(x)
 *   Ex:n  = D(x+n) / D(x)
 *   ax:n  = (N(x) − N(x+n)) / D(x)
 *   ax:t  = (N(x) − N(x+t)) / D(x)
 *   IAx:n = (R(x) − R(x+n) − n×M(x+n)) / D(x)  [t > 1]
 *         = (M(x) − M(x+n)) / D(x)              [t = 1]
 *
 * Особенности Saqtau Invest:
 *   • Ставка доходности зависит от срока полиса n.
 *   • Нагрузки G6/G7/H4 берутся по СРОКУ полиса n (clamp к 3..15).
 *   • Нагрузки G2/G3/G4/G5 — по СРОКУ УПЛАТЫ t (clamp к 3..15),
 *     с округлением вверх до 2 знаков (Excel ROUNDUP).
 *   • При t = 1 (единовременно): G2 = H4, G3 = G4 = G5 = 0.
 *   • Резерв (для отображения «Страховые резервы») — всегда формула Резерв_1.
 *     Выкупная сумма зависит от типа защиты:
 *       full_sum_assured → surr_base = Резерв_1
 *       paid_premiums    → surr_base = Резерв_2 (Ex-based, IAx делится на D(x))
 *   • Минимальная годовая премия — 1 000 USD (по курсу).
 */

import { ActuarialEngine } from './actuarial.js';
import { PRODUCT_CONFIG }  from '../config/product.js';

// ─── Вспомогательное округление (ROUND_HALF_UP, как в Excel) ─────────────────

export function roundHalfUp(value, decimals = 0) {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// Excel ROUNDUP(value, decimals) — округление ВВЕРХ по модулю, с защитой
// от плавающей точки (иначе 0.01×100 = 1.0000000002 → ceil даст 2).
export function roundUp(value, decimals = 0) {
  const factor = Math.pow(10, decimals);
  const scaled = Number((value * factor).toFixed(6));
  return Math.ceil(scaled) / factor;
}

function clampTermKey(n) {
  return Math.min(Math.max(Math.round(n), 3), 15);
}

// ─── PolicyCalculator ─────────────────────────────────────────────────────────

export class PolicyCalculator {

  constructor(engine, config = PRODUCT_CONFIG) {
    this.engine           = engine;
    this.config           = config;
    this.expenseTable     = config.expenseTable;
    this.freqAdj          = config.frequencyAdjustment;
    this.surrenderPenalty = config.surrenderPenalty;
  }

  // ─── Утилиты ────────────────────────────────────────────────────────────────

  static calculateAge(dob, ref = new Date()) {
    const [y, m, d] = dob.split('-').map(Number);
    let age = ref.getFullYear() - y;
    if (ref.getMonth() + 1 < m || (ref.getMonth() + 1 === m && ref.getDate() < d)) {
      age -= 1;
    }
    return age;
  }

  _freqFactor(frequency) {
    return frequency === 'single' ? 1.0 : (this.freqAdj[frequency] ?? 1.0);
  }

  /**
   * Saqtau Invest — расходные коэффициенты ТОЧНО как в Excel (Параметры G2..G7):
   *   G2 = ROUNDUP(J[min(t,15)], 2),  G3 = ROUNDUP(K[min(t,15)], 2)   — по сроку t
   *   G6 = M[min(t,15)],  G7 = N[min(t,15)]                            — по сроку t
   *   Все нагрузки берутся по СРОКУ УПЛАТЫ t (INDEX по MIN(t-2,13)).
   *   При t = 1 (единовременно): G2 = G3 = G6 = G7 = 0, а единовременная
   *   нагрузка H4 = Параметры!H4 = 0 (ячейка в книге пустая). Поэтому BP для
   *   единовременной уплаты считается без аквизиционной нагрузки — как в Excel.
   */
  _getExpenses(n, t) {
    const G8 = this.surrenderPenalty;

    if (t === 1) {
      return { G2: 0.0, G3: 0.0, G4: 0.0, G5: 0.0, G6: 0.0, G7: 0.0, G8, H4: 0.0 };
    }
    const et = this.expenseTable[clampTermKey(t)];
    return {
      G2: roundUp(et.G2, 2),
      G3: roundUp(et.G3, 2),
      G4: et.G4 ?? 0.0,
      G5: et.G5 ?? 0.0,
      G6: et.G6,            // «Расход от премий»  — по сроку уплаты t
      G7: et.G7,            // «Расход от страх. суммы» — по сроку уплаты t
      G8,
      H4: et.H4 ?? 0.0,
    };
  }

  _getRate(term) {
    return this.engine.getInterestRate(term);
  }

  // ─── Актуарные значения ──────────────────────────────────────────────────────

  _actuarialValues(comm, x, n, t) {
    const Dx  = comm.Dx(x);
    const Dxn = comm.Dx(x + n);
    const Dx1 = comm.Dx(x + 1);
    const Dx2 = comm.Dx(x + 2);
    const Dx3 = comm.Dx(x + 3);
    const Mx  = comm.Mx(x);
    const Mxn = comm.Mx(x + n);
    const Nx  = comm.Nx(x);
    const Nxn = comm.Nx(x + n);
    const Nxt = comm.Nx(x + t);
    const Rx  = comm.Rx(x);
    const Rxn = comm.Rx(x + n);

    const Ax_n  = Dx > 0 ? (Mx - Mxn + Dxn) / Dx : 0.0;
    const Ex_n  = Dx > 0 ? Dxn / Dx : 0.0;
    const ax_n  = Dx > 0 ? (Nx - Nxn) / Dx       : 0.0;
    const ax_t  = Dx > 0 ? (Nx - Nxt) / Dx       : 0.0;
    const IAx_n = Dx > 0
      ? (t === 1 ? (Mx - Mxn) / Dx : (Rx - Rxn - n * Mxn) / Dx)
      : 0.0;

    const NP_1 = ax_t > 0 ? Ax_n / ax_t : 0.0;
    const NP_2 = (ax_n - IAx_n) > 0 ? Ex_n / (ax_n - IAx_n) : 0.0;

    return { Dx, Dxn, Dx1, Dx2, Dx3, Mx, Mxn, Nx, Nxn, Nxt, Rx, Rxn,
             Ax_n, Ex_n, ax_n, ax_t, IAx_n, NP_1, NP_2 };
  }

  /**
   * Аквизиционная нагрузка alfa.
   * При t = 1: alfa = H4.
   * Иначе: alfa = G2 + G3×D(x+1)/D(x) + G4×D(x+2)/D(x) + G5×D(x+3)/D(x).
   */
  _calcAlfa(expenses, vals, t) {
    if (t === 1) return expenses.H4;
    const { Dx, Dx1, Dx2, Dx3 } = vals;
    let alfa = expenses.G2;
    if (Dx > 0) {
      alfa += expenses.G3 * Dx1 / Dx;
      if (expenses.G4 > 0) alfa += expenses.G4 * Dx2 / Dx;
      if (expenses.G5 > 0) alfa += expenses.G5 * Dx3 / Dx;
    }
    return alfa;
  }

  // ─── Брутто-ставка ───────────────────────────────────────────────────────────

  calcGrossPremiumRate(x, n, t, gender, deathBenefitType = 'full_sum_assured', kMult = 1.0, lAdd = 0.0) {
    const rate     = this._getRate(n);
    const comm     = this.engine.getCommutationTable(gender, kMult, lAdd, rate);
    const vals     = this._actuarialValues(comm, x, n, t);
    const expenses = this._getExpenses(n, t);

    const { G6, G7 } = expenses;
    const { Ax_n, Ex_n, ax_n, ax_t, IAx_n } = vals;
    const alfa = this._calcAlfa(expenses, vals, t);

    const num1 = Ax_n + G7 * ax_n;
    const den1 = ax_t - G6 * ax_t - alfa;
    const BP_1 = den1 > 0 ? num1 / den1 : 0.0;

    const num2 = Ex_n + G7 * ax_n;
    const den2 = ax_t - IAx_n - G6 * ax_t - alfa;
    const BP_2 = den2 > 0 ? num2 / den2 : 0.0;

    const BP = deathBenefitType === 'paid_premiums' ? BP_2 : BP_1;
    const NP = deathBenefitType === 'paid_premiums' ? vals.NP_2 : vals.NP_1;

    return { ...vals, ...expenses, alfa, BP_1, BP_2, BP, NP, interestRate: rate };
  }

  // ─── Расчёт премии по заданной СС ────────────────────────────────────────────

  calculatePremium(dob, gender, term, frequency, sumAssured,
                   deathBenefitType = 'full_sum_assured', kMult = 1.0, lAdd = 0.0) {
    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const vals = this.calcGrossPremiumRate(x, term, t, gender, deathBenefitType, kMult, lAdd);

    const { BP, NP, interestRate } = vals;
    const freqFactor = this._freqFactor(frequency);

    const annualPremium = roundHalfUp(BP * sumAssured);
    const grossPremium  = frequency === 'single'
      ? annualPremium
      : roundHalfUp(BP * sumAssured * freqFactor);

    return {
      age: x, term, paymentTerm: t, gender, frequency, deathBenefitType,
      sumAssured, interestRate,
      BP_rate: BP, BP_1: vals.BP_1, BP_2: vals.BP_2, NP_rate: NP,
      annualPremium, grossPremium,
      netPremium: NP * sumAssured,
      freqFactor,
      actuarial: vals,
    };
  }

  // ─── Расчёт СС по заданной премии ────────────────────────────────────────────

  calculateSumAssured(dob, gender, term, frequency, premium,
                      deathBenefitType = 'full_sum_assured', kMult = 1.0, lAdd = 0.0) {
    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const vals = this.calcGrossPremiumRate(x, term, t, gender, deathBenefitType, kMult, lAdd);

    const { BP, NP, interestRate } = vals;
    const freqFactor = this._freqFactor(frequency);

    let sumAssured;
    if (frequency === 'single') {
      sumAssured = BP > 0 ? premium / BP : 0.0;
    } else {
      sumAssured = BP > 0 ? premium / (BP * freqFactor) : 0.0;
    }
    sumAssured = Math.round(sumAssured * 100) / 100;

    const annualPremium = roundHalfUp(BP * sumAssured);
    const grossPremium  = frequency === 'single'
      ? annualPremium
      : roundHalfUp(BP * sumAssured * freqFactor);

    return {
      age: x, term, paymentTerm: t, gender, frequency, deathBenefitType,
      sumAssured, interestRate,
      BP_rate: BP, BP_1: vals.BP_1, BP_2: vals.BP_2, NP_rate: NP,
      annualPremium, grossPremium,
      netPremium: NP * sumAssured,
      freqFactor,
      actuarial: vals,
    };
  }

  // ─── Обратный расчёт с учётом райдеров ───────────────────────────────────────

  calculateSumAssuredWithRiders(dob, gender, term, frequency, totalPremium,
                                deathBenefitType, ridersCalc, saLinkedKeys, fixedRiders,
                                kMult = 1.0, lAdd = 0.0) {
    if (!totalPremium || !term) {
      return this.calculateSumAssured(dob, gender, term, frequency, 0,
                                      deathBenefitType, kMult, lAdd);
    }

    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const vals = this.calcGrossPremiumRate(x, term, t, gender, deathBenefitType, kMult, lAdd);
    const { BP: bpRate, NP, interestRate, BP_1, BP_2 } = vals;

    if (!bpRate) {
      return this.calculateSumAssured(dob, gender, term, frequency, 0,
                                      deathBenefitType, kMult, lAdd);
    }

    const freqFactor = this._freqFactor(frequency);

    // Сумма брутто-тарифов SA-linked простых допов
    let saLinkedTariffSum = 0.0;
    for (const rk of saLinkedKeys) {
      saLinkedTariffSum += this._getSimpleRiderGrossTariff(rk);
    }

    // Фиксированная часть (fixed-sum допы) — не зависят от SA
    let fixedTotal = 0.0;
    for (const [rk, rs] of fixedRiders) {
      const riderSum = parseFloat(rs);
      if (riderSum > 0) {
        const r = ridersCalc.calculateSimpleRider(rk, riderSum, term, frequency);
        fixedTotal += r.riderPremium;
      }
    }

    const tpSmooth = (sa) => {
      const main = frequency === 'single' ? bpRate * sa : bpRate * sa * freqFactor;
      let linked = 0;
      for (const rk of saLinkedKeys) {
        linked += ridersCalc.calculateSimpleRider(rk, sa, term, frequency).riderPremium;
      }
      return main + linked + fixedTotal;
    };

    const tpRound = (sa) => {
      const sac  = roundHalfUp(sa);
      const main = frequency === 'single'
        ? roundHalfUp(bpRate * sac)
        : roundHalfUp(bpRate * sac * freqFactor);
      let linked = 0;
      for (const rk of saLinkedKeys) {
        linked += ridersCalc.calculateSimpleRider(rk, sac, term, frequency).riderPremium;
      }
      return main + linked + fixedTotal;
    };

    let saEst = frequency === 'single'
      ? totalPremium / bpRate * 2
      : totalPremium / (bpRate * freqFactor) * 2;

    let saLo = 0.0, saHi = saEst;
    while (tpSmooth(saHi) < totalPremium) {
      saHi *= 2;
      if (saHi > 1e15) break;
    }
    for (let iter = 0; iter < 300; iter++) {
      const mid = (saLo + saHi) / 2;
      if (tpSmooth(mid) < totalPremium) saLo = mid; else saHi = mid;
      if (saHi - saLo < 1e-6) break;
    }
    const saSmooth = (saLo + saHi) / 2;

    const totalRate = (bpRate + saLinkedTariffSum) * (frequency === 'single' ? 1.0 : freqFactor);
    const saCont    = totalRate > 0 ? (totalPremium - fixedTotal) / totalRate : saSmooth;

    let bestSA   = saSmooth;
    let bestDiff = Math.abs(tpRound(saSmooth) - totalPremium);

    const candidates = [];
    for (let off = -5; off <= 5; off++) candidates.push(Math.round(saSmooth) + off);
    for (const d of [-0.5, -0.25, -0.1, -0.01, 0, 0.01, 0.1, 0.25, 0.5]) candidates.push(saSmooth + d);
    candidates.push(saCont);
    for (let off = -5; off <= 5; off++) candidates.push(Math.round(saCont) + off);
    for (const d of [-0.5, -0.25, -0.1, -0.01, 0, 0.01, 0.1, 0.25, 0.5]) candidates.push(saCont + d);

    for (const sa of candidates) {
      if (sa <= 0) continue;
      const diff = Math.abs(tpRound(sa) - totalPremium);
      if (diff < bestDiff) { bestDiff = diff; bestSA = sa; }
    }

    const sumAssured    = Math.round(bestSA * 100) / 100;
    const annualPremium = roundHalfUp(bpRate * sumAssured);
    const grossPremium  = frequency === 'single'
      ? annualPremium
      : roundHalfUp(bpRate * sumAssured * freqFactor);

    return {
      age: x, term, paymentTerm: t, gender, frequency, deathBenefitType,
      sumAssured, interestRate,
      BP_rate: bpRate, BP_1, BP_2, NP_rate: NP,
      annualPremium, grossPremium,
      netPremium: NP * sumAssured,
      freqFactor,
      actuarial: vals,
    };
  }

  _getSimpleRiderGrossTariff(riderKey) {
    const rc = this.config.riders?.[riderKey] ?? {};
    if (rc.type) return 0.0;
    const bt = rc.tariff ?? 0.0;
    return roundHalfUp(bt * (1.0 + (rc.expenses ?? 0)) / (1.0 - (rc.acquisition ?? 0)), 4);
  }

  // ─── Таблица резервов ─────────────────────────────────────────────────────────

  /**
   * Резервы и выкупные суммы по годам.
   *
   * Резерв (для отображения) — Ax-based:
   *   reserve_rate = Ax:n_k + G7×ax:n_k + BP×(alfa_k + G6×ax:t_k − ax:t_k)
   *
   * Выкупная сумма зависит от типа защиты:
   *   full_sum_assured → surr_base = reserve_rate
   *   paid_premiums    → surr_base = Ex:n_k + G7×ax:n_k + BP×IAx:n_k
   *                                  + BP×(alfa_k + G6×ax:t_k − ax:t_k)
   *   surrender_rate = surr_base − (1 − surr_base) × G8
   *
   * Замечание: IAx:n_k для paid_premiums делится на D(x), НЕ D(x+k) — как в engine.js.
   */
  calculateReserves(dob, gender, term, frequency, sumAssured,
                    deathBenefitType = 'full_sum_assured', kMult = 1.0, lAdd = 0.0) {
    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const rate = this._getRate(term);
    const comm = this.engine.getCommutationTable(gender, kMult, lAdd, rate);

    const base     = this._actuarialValues(comm, x, term, t);
    const expenses = this._getExpenses(term, t);
    const { G6, G7, G8 } = expenses;
    const alfa0 = this._calcAlfa(expenses, base, t);

    let BP;
    if (deathBenefitType === 'paid_premiums') {
      const num = base.Ex_n + G7 * base.ax_n;
      const den = base.ax_t - base.IAx_n - G6 * base.ax_t - alfa0;
      BP = den > 0 ? num / den : 0.0;
    } else {
      const num = base.Ax_n + G7 * base.ax_n;
      const den = base.ax_t - G6 * base.ax_t - alfa0;
      BP = den > 0 ? num / den : 0.0;
    }

    const Dx  = comm.Dx(x);
    const Mxn = comm.Mx(x + term);
    const Dxn = comm.Dx(x + term);
    const Nxn = comm.Nx(x + term);
    const Nxt = comm.Nx(x + t);
    const Rxn = comm.Rx(x + term);

    const reserves = [];

    for (let k = 1; k <= term; k++) {
      const xk  = x + k;
      const Dxk = comm.Dx(xk);

      if (Dxk === 0) {
        reserves.push({ year: k, age: xk, reserveRate: 0, surrenderRate: 0,
                        reserve: 0, surrender: 0, reducedSA: 0 });
        continue;
      }

      const Mxk = comm.Mx(xk);
      const Nxk = comm.Nx(xk);
      const Rxk = comm.Rx(xk);

      const Ax_n_k = (Mxk - Mxn + Dxn) / Dxk;
      const Ex_n_k = Dxn / Dxk;
      const ax_n_k = (Nxk - Nxn) / Dxk;
      const ax_t_k = k < t ? (Nxk - Nxt) / Dxk : 0.0;

      // Остаточная аквизиционная нагрузка alfa_k
      let alfa_k = 0.0;
      if (t > 1) {
        if (k === 1) {
          alfa_k = expenses.G3;
          if (expenses.G4 > 0 && Dxk > 0) alfa_k += expenses.G4 * comm.Dx(x + 2) / Dxk;
          if (expenses.G5 > 0 && Dxk > 0) alfa_k += expenses.G5 * comm.Dx(x + 3) / Dxk;
        } else if (k === 2) {
          alfa_k = expenses.G4 ?? 0.0;
          if (expenses.G5 > 0 && Dxk > 0) alfa_k += expenses.G5 * comm.Dx(x + 3) / Dxk;
        } else if (k === 3) {
          alfa_k = expenses.G5 ?? 0.0;
        }
      }

      // Резерв (Ax-based) — для отображения «Страховые резервы» (Расчет!M)
      const reserveRate = Ax_n_k + G7 * ax_n_k + BP * (alfa_k + G6 * ax_t_k - ax_t_k);

      // Выкупная сумма (Расчет!N для «сумма оплаченных взносов», иначе = Резерв_1)
      let surrenderBase;
      let IAx_n_k = 0.0;
      if (deathBenefitType === 'paid_premiums') {
        IAx_n_k       = (Rxk - Rxn - (term - k) * Mxn) / Dx;
        // При единовременной уплате (t=1) Excel использует Ax:n1_k = (Mxk−Mxn)/Dxk
        const IAterm  = (t === 1) ? (Mxk - Mxn) / Dxk : IAx_n_k;
        surrenderBase = Ex_n_k + G7 * ax_n_k + BP * IAterm + BP * (alfa_k + G6 * ax_t_k - ax_t_k);
      } else {
        surrenderBase = reserveRate;
      }

      const surrenderRate = surrenderBase - (1.0 - surrenderBase) * G8;

      // Округление как в Excel: E = IF(резерв>0, ROUND(резерв·СС,0), 0);
      // P = ROUND(выкуп·СС,0), отображается как IF(выкуп>0, P, 0);
      // Q (уменьшенная СС) = IF(выкуп>0 и не единовр., ROUND(P/Ax:n_k,0), 0).
      const reserve   = reserveRate   > 0 ? roundHalfUp(reserveRate   * sumAssured) : 0;
      const surrender = surrenderRate > 0 ? roundHalfUp(surrenderRate * sumAssured) : 0;
      const reducedSA = (surrenderRate > 0 && frequency !== 'single' && Ax_n_k > 0)
        ? roundHalfUp(surrender / Ax_n_k)
        : 0;

      reserves.push({
        year: k, age: xk,
        Ax_n_k, Ex_n_k, ax_n_k, ax_t_k, IAx_n_k, alfa_k,
        reserveRate, surrenderRate,
        reserve, surrender, reducedSA,
      });
    }

    return reserves;
  }

  // ─── Полный расчёт ────────────────────────────────────────────────────────────

  fullCalculation(params, ridersCalc = null) {
    const {
      dob, gender, term, frequency,
      deathBenefitType = 'full_sum_assured',
      mode = 'sa_to_premium',
      saLinkedKeys = [],
      fixedRiders = [],
      kMult = 1.0,
      lAdd  = 0.0,
    } = params;

    let result, sumAssured;

    if (mode === 'sa_to_premium') {
      result     = this.calculatePremium(dob, gender, term, frequency,
                                         params.sumAssured, deathBenefitType, kMult, lAdd);
      sumAssured = params.sumAssured;
    } else {
      if (ridersCalc && (saLinkedKeys.length > 0 || fixedRiders.length > 0)) {
        result = this.calculateSumAssuredWithRiders(
          dob, gender, term, frequency, params.premium,
          deathBenefitType, ridersCalc, saLinkedKeys, fixedRiders, kMult, lAdd,
        );
      } else {
        result = this.calculateSumAssured(dob, gender, term, frequency,
                                          params.premium, deathBenefitType, kMult, lAdd);
      }
      sumAssured = result.sumAssured;
    }

    const reserves = this.calculateReserves(dob, gender, term, frequency, sumAssured,
                                            deathBenefitType, kMult, lAdd);

    return { ...result, reserves };
  }
}
