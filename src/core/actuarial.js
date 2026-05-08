/**
 * Актуарное ядро — Saqtau Invest
 *
 * Строит коммутационные таблицы:
 *   l(x)  — число живущих в возрасте x
 *   D(x)  = l(x) × v^x
 *   N(x)  = Σ D(x)..D(ω)   (сумма «хвоста»)
 *   S(x)  = Σ N(x)..N(ω)
 *   C(x)  = (l(x) − l(x+1)) × v^(x+1)  [death_timing=2, конец года]
 *   M(x)  = Σ C(x)..C(ω)
 *   R(x)  = Σ M(x)..M(ω)
 *
 * В Saqtau Invest ставка доходности зависит от срока — на каждый срок
 * строится своя коммутационная таблица.
 */

import { MORTALITY } from '../config/mortality.js';
import { PRODUCT_CONFIG } from '../config/product.js';

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/**
 * Строит «хвостовую» кумулятивную сумму массива (справа налево).
 * result[i] = arr[i] + arr[i+1] + ... + arr[n-1]
 */
function tailCumsum(arr) {
  const n = arr.length;
  const result = new Array(n).fill(0);
  result[n - 1] = arr[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    result[i] = result[i + 1] + arr[i];
  }
  return result;
}

// ─── CommutationTable ─────────────────────────────────────────────────────────

export class CommutationTable {
  /**
   * @param {number[]} qxPer1000  — q(x) на 1000 живущих, массив [0..maxAge]
   * @param {number}   interestRate
   * @param {number}   deathTiming  — 1 (середина года) | 2 (конец года)
   * @param {number}   l0           — начальное число живущих
   * @param {number}   maxAge
   * @param {number}   kMult        — мультипликатор для корректировки таблицы
   * @param {number}   lAdd         — аддитивная поправка
   */
  constructor(
    qxPer1000,
    interestRate,
    deathTiming = 2,
    l0 = 1_000_000,
    maxAge = 100,
    kMult = 1.0,
    lAdd = 0.0,
  ) {
    this.interestRate = interestRate;
    this.v = 1.0 / (1.0 + interestRate);
    this.maxAge = maxAge;
    const n = maxAge + 1;

    // Скорректированные вероятности смерти
    const adjQx = new Array(n);
    for (let x = 0; x < n; x++) {
      adjQx[x] = (qxPer1000[x] * kMult + lAdd) / 1000.0;
    }
    adjQx[maxAge] = 1.0; // 100% смертность в конечном возрасте

    // Функция дожития l(x)
    const lx = new Array(n).fill(0);
    lx[0] = l0;
    for (let x = 1; x < n; x++) {
      lx[x] = lx[x - 1] * (1.0 - adjQx[x - 1]);
    }

    // D(x) = l(x) × v^x
    const Dx = lx.map((l, x) => l * Math.pow(this.v, x));

    // N(x) = хвостовая сумма D(x)
    const Nx = tailCumsum(Dx);

    // S(x) = хвостовая сумма N(x)
    const Sx = tailCumsum(Nx);

    // C(x): дисконтированные смерти
    const Cx = new Array(n).fill(0);
    for (let x = 0; x < n - 1; x++) {
      const deaths = lx[x] - lx[x + 1];
      if (deathTiming === 2) {
        Cx[x] = deaths * Math.pow(this.v, x + 1);
      } else {
        Cx[x] = deaths * Math.pow(this.v, x + 1) * Math.sqrt(1.0 + interestRate);
      }
    }
    Cx[n - 1] = lx[n - 1] >= 1.0 ? 1.0 : 0.0;

    // M(x) = хвостовая сумма C(x)
    const Mx = tailCumsum(Cx);

    // R(x) = хвостовая сумма M(x)
    const Rx = tailCumsum(Mx);

    this._Dx = Dx;
    this._Nx = Nx;
    this._Sx = Sx;
    this._Cx = Cx;
    this._Mx = Mx;
    this._Rx = Rx;
  }

  _get(arr, age) {
    if (age < 0 || age > this.maxAge) return 0.0;
    return arr[age];
  }

  Dx(age) { return this._get(this._Dx, age); }
  Nx(age) { return this._get(this._Nx, age); }
  Sx(age) { return this._get(this._Sx, age); }
  Cx(age) { return this._get(this._Cx, age); }
  Mx(age) { return this._get(this._Mx, age); }
  Rx(age) { return this._get(this._Rx, age); }
}

// ─── ActuarialEngine ─────────────────────────────────────────────────────────

export class ActuarialEngine {
  /**
   * Актуарный движок: создаёт и кэширует коммутационные таблицы.
   * Таблицы строятся один раз для каждой комбинации (пол, ставка) и переиспользуются.
   */
  constructor(config = PRODUCT_CONFIG) {
    this.interestRateByTerm = config.interestRateByTerm ?? {};
    this.defaultInterestRate = config.defaultInterestRate ?? 0.035;
    this.deathTiming = config.deathTiming;
    this.maxAge = config.maxAge;
    this.l0 = config.l0;

    this._commTables = new Map();
  }

  /**
   * Saqtau Invest: ставка доходности зависит от срока полиса.
   * Срок ограничивается диапазоном 1..20 лет.
   */
  getInterestRate(term = null) {
    if (term == null) return this.defaultInterestRate;
    const k = Math.min(Math.max(Math.round(term), 1), 20);
    return this.interestRateByTerm[k] ?? this.defaultInterestRate;
  }

  /**
   * Получить (или построить) коммутационную таблицу для заданных параметров.
   * @param {'male'|'female'} gender
   * @param {number} kMult — мультипликатор (по умолчанию 1.0)
   * @param {number} lAdd  — аддитивная поправка (по умолчанию 0.0)
   * @param {number} rate  — ставка доходности
   */
  getCommutationTable(gender, kMult = 1.0, lAdd = 0.0, rate = this.defaultInterestRate) {
    const key = `${gender}_${rate}_${kMult}_${lAdd}`;
    if (!this._commTables.has(key)) {
      const qx = gender === 'male' ? MORTALITY.male : MORTALITY.female;
      this._commTables.set(key, new CommutationTable(
        qx,
        rate,
        this.deathTiming,
        this.l0,
        this.maxAge,
        kMult,
        lAdd,
      ));
    }
    return this._commTables.get(key);
  }
}
