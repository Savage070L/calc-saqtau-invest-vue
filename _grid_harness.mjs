// Grid harness — runs the Vue core engine over input rows from stdin, emits results.
import { ActuarialEngine } from './src/core/actuarial.js';
import { PolicyCalculator } from './src/core/calculator.js';
import { PRODUCT_CONFIG }   from './src/config/product.js';

const engine = new ActuarialEngine(PRODUCT_CONFIG);
const calc   = new PolicyCalculator(engine, PRODUCT_CONFIG);

const REF = new Date('2026-06-24T12:00:00');           // fixed reference date
function dobForAge(x) { return `${2026 - x}-01-15`; }   // age = x on REF

const input = JSON.parse(await new Promise((res) => {
  let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => res(s));
}));

const out = [];
for (const row of input) {
  const { gender, x, n, freq, deathType, SA, premium } = row;
  const dob = dobForAge(x);
  // forward: SA -> premium (+reserves)
  const fwd = calc.fullCalculation({
    dob, gender, term: n, frequency: freq,
    deathBenefitType: deathType, mode: 'sa_to_premium', sumAssured: SA,
  });
  // inverse: premium -> SA (no riders)
  const inv = calc.calculateSumAssured(dob, gender, n, freq, premium, deathType);
  out.push({
    ...row,
    age: fwd.age,
    BP: fwd.BP_rate,
    interestRate: fwd.interestRate,
    gross: fwd.grossPremium,
    annual: fwd.annualPremium,
    reserves: fwd.reserves.map((r) => ({
      year: r.year, reserve: r.reserve, surrender: r.surrender, reducedSA: r.reducedSA,
    })),
    invSA: inv.sumAssured,
    invBP: inv.BP_rate,
  });
}
process.stdout.write(JSON.stringify(out));
// (age uses default new Date(); REF is informational. We echo fwd.age and the
//  oracle is fed that exact age, so any date drift cannot desync the comparison.)
