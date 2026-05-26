/**
 * useInsuranceCalc — Vue 3 composable для расчёта полиса Saqtau Invest
 */

import { ref, computed } from 'vue';
import { ActuarialEngine } from '../core/actuarial.js';
import { PolicyCalculator } from '../core/calculator.js';
import { RidersCalculator } from '../core/riders.js';
import { PRODUCT_CONFIG } from '../config/product.js';
import { useI18n } from '../i18n/index.js';

// Группы рейдеров (radio в UI):
//   group1: { accidental_death }
//   group2: { disability_accident_lumpsum }
//   group3: набор чекбоксов с фикс. суммой
const GROUP1 = ['accidental_death'];
const GROUP2 = ['disability_accident_lumpsum'];
const GROUP3 = ['trauma', 'hospitalization'];

const ALLOWED_RIDERS = [...GROUP1, ...GROUP2, ...GROUP3];

const SA_LINKED_KEYS = ['accidental_death', 'disability_accident_lumpsum'];
const FIXED_SUM_KEYS = ['trauma', 'hospitalization'];

let _engine = null;
let _calculator = null;
let _ridersCalc = null;

function getEngine() {
  if (!_engine) {
    _engine = new ActuarialEngine(PRODUCT_CONFIG);
    _calculator = new PolicyCalculator(_engine, PRODUCT_CONFIG);
    _ridersCalc = new RidersCalculator(_engine, PRODUCT_CONFIG);
  }
  return { engine: _engine, calculator: _calculator, ridersCalc: _ridersCalc };
}

export function formatMoney(value, currency = '') {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const formatted = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
  return currency ? `${formatted} ${currency}` : formatted;
}

export function validateInputs(inputs) {
  const { t } = useI18n();
  const errors = [];
  const {
    dob, gender, term, frequency, mode,
    sumAssured, premium,
    usdRate,
  } = inputs;
  const { minTerm, maxTerm, maxExitAge, minAge,
          minAnnualPremiumUsd, defaultUsdRate } = PRODUCT_CONFIG;

  if (!dob) {
    errors.push(t('errors.dobRequired'));
  } else {
    const age = PolicyCalculator.calculateAge(dob);
    if (age < 0) {
      errors.push(t('errors.dobInvalid'));
    } else if (age < minAge) {
      errors.push(t('errors.minAge', { age, min: minAge }));
    } else if (age + minTerm > maxExitAge) {
      errors.push(t('errors.ageTooHigh', { age, maxAge: maxExitAge - minTerm, max: maxExitAge }));
    }
    const exitAge = age + (term || 0);
    if (term && exitAge > maxExitAge) {
      errors.push(t('errors.exitAgeExceeds', { exitAge, max: maxExitAge }));
    }
  }

  if (!gender || !['male', 'female'].includes(gender)) {
    errors.push(t('errors.genderRequired'));
  }

  if (!term || term < minTerm || term > maxTerm) {
    errors.push(t('errors.termRange', { min: minTerm, max: maxTerm }));
  }

  if (!frequency) {
    errors.push(t('errors.frequencyRequired'));
  }

  if (mode === 'sa_to_premium') {
    if (!sumAssured || sumAssured <= 0) {
      errors.push(t('errors.sumAssuredRequired'));
    }
  } else if (!premium || premium <= 0) {
    errors.push(t('errors.premiumRequired'));
  }

  return errors;
}

export function useInsuranceCalc() {
  const result = ref(null);
  const loading = ref(false);
  const error = ref(null);
  const errors = ref([]);

  const hasResult = computed(() => result.value !== null);
  const isValid = computed(() => errors.value.length === 0);

  function calculate(inputs) {
    errors.value = validateInputs(inputs);
    if (errors.value.length > 0) {
      error.value = errors.value.join('; ');
      result.value = null;
      return;
    }

    loading.value = true;
    error.value = null;

    try {
      const { calculator, ridersCalc } = getEngine();
      const {
        dob, gender, term, frequency,
        mode = 'sa_to_premium',
        deathBenefitType = 'full_sum_assured',
        sumAssured,
        premium,
        _usdRate,
        usdRate: usdRateExplicit,
        riders: ridersSelection = {},
        kMult = 1.0,
        lAdd = 0.0,
      } = inputs;
      const usdRate = usdRateExplicit ?? _usdRate ?? PRODUCT_CONFIG.defaultUsdRate;

      const allowedRidersSelection = Object.fromEntries(
        Object.entries(ridersSelection).filter(([key]) => ALLOWED_RIDERS.includes(key))
      );

      const t = frequency === 'single' ? 1 : term;

      const saLinkedKeys = SA_LINKED_KEYS
        .filter((k) => allowedRidersSelection[k]?.enabled);

      const fixedRiders = FIXED_SUM_KEYS
        .filter((k) => allowedRidersSelection[k]?.enabled)
        .map((k) => [k, allowedRidersSelection[k].sum ?? 0])
        .filter(([, s]) => s > 0);

      let baseResult = calculator.fullCalculation({
        dob, gender, term, frequency,
        mode,
        deathBenefitType,
        sumAssured, premium,
        saLinkedKeys, fixedRiders,
        kMult, lAdd,
      }, ridersCalc);

      let finalResult = baseResult;
      if (mode === 'premium_to_sa' && (saLinkedKeys.length > 0 || fixedRiders.length > 0)) {
        finalResult = calculator.calculateSumAssuredWithRiders(
          dob, gender, term, frequency, premium,
          deathBenefitType, ridersCalc, saLinkedKeys, fixedRiders, kMult, lAdd,
        );
        const reserves = calculator.calculateReserves(
          dob, gender, term, frequency, finalResult.sumAssured,
          deathBenefitType, kMult, lAdd,
        );
        finalResult = { ...finalResult, reserves };
      }

      const finalRidersResult = ridersCalc.calculateAllRiders({
        n: term,
        frequency,
        sumAssured: finalResult.sumAssured,
        ridersSelection: allowedRidersSelection,
        kMult, lAdd,
      });

      const totalRiderPremium = ALLOWED_RIDERS.reduce((sum, key) => {
        const rider = finalRidersResult.riders[key];
        return sum + (rider?.riderPremium ?? 0);
      }, 0);

      const totalPremium = finalResult.grossPremium + totalRiderPremium;
      const maturityAmount = finalResult.sumAssured;

      // Минимальная годовая премия — 1 000 USD по курсу
      const minAnnualKzt = (PRODUCT_CONFIG.minAnnualPremiumUsd ?? 1000) * (usdRate || PRODUCT_CONFIG.defaultUsdRate);
      const annualPremiumKzt = Math.round(finalResult.annualPremium ?? 0);
      const minPremiumWarning = annualPremiumKzt > 0 && annualPremiumKzt < minAnnualKzt
        ? { minAnnualKzt: Math.round(minAnnualKzt), annualPremium: annualPremiumKzt, usdRate: usdRate || PRODUCT_CONFIG.defaultUsdRate }
        : null;

      // Конвертация в USD для отображения
      const usd = (kzt) => (usdRate > 0 ? Math.round((kzt / usdRate) * 100) / 100 : 0);

      // Страховая сумма по доп. покрытию не может превышать СС по основному.
      const { t: ti } = useI18n();
      const finalSA = finalResult.sumAssured;
      const hasRiderOverSA = Object.values(allowedRidersSelection).some(
        (r) => r?.enabled && typeof r.sum === 'number' && r.sum > finalSA,
      );
      if (hasRiderOverSA) {
        errors.value = [...errors.value, ti('errors.riderSumExceedsSA')];
        error.value = errors.value.join('; ');
      }

      result.value = {
        ...finalResult,
        riders: finalRidersResult.riders,
        totalRiderPremium,
        totalPremium,
        maturityAmount,
        usdRate: usdRate || PRODUCT_CONFIG.defaultUsdRate,
        sumAssuredUsd:    usd(finalResult.sumAssured),
        annualPremiumUsd: usd(finalResult.annualPremium),
        grossPremiumUsd:  usd(finalResult.grossPremium),
        totalPremiumUsd:  usd(totalPremium),
        minPremiumWarning,
        calcDate: new Date().toISOString().slice(0, 10),
      };
    } catch (e) {
      error.value = `Ошибка расчёта: ${e.message}`;
      result.value = null;
      console.error(e);
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    result.value = null;
    error.value = null;
    errors.value = [];
    loading.value = false;
  }

  return {
    result,
    loading,
    error,
    errors,
    hasResult,
    isValid,
    calculate,
    reset,
    GROUP1,
    GROUP2,
    GROUP3,
    ALLOWED_RIDERS,
  };
}

export { GROUP1, GROUP2, GROUP3, ALLOWED_RIDERS };
