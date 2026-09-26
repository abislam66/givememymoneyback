// Plain-English names and short explanations for every CPT code used in the test data.
// Shared by the test-data generator and the explainer.

const CPT = {
  '99283': { short: 'ER visit', name: 'ER visit, moderate (level 3)', explain: 'An emergency room visit for a problem of medium seriousness. ER visits are ranked from level 1 (minor) to level 5 (most serious).' },
  '99284': { short: 'ER visit', name: 'ER visit, serious (level 4)', explain: 'An emergency room visit for a serious problem that needed a fast, careful check. Level 4 is the second-highest of five levels.' },
  '99285': { short: 'ER visit', name: 'ER visit, severe (level 5)', explain: 'An emergency room visit for a very serious problem, like chest pain. Level 5 is the highest of five levels.' },
  '73610': { short: 'ankle X-ray', name: 'Ankle X-ray, 3 or more views', explain: 'X-ray pictures of the ankle taken from at least three angles to look for broken bones.' },
  '29540': { short: 'ankle strapping', name: 'Ankle strapping', explain: 'Wrapping or taping the ankle to support it after an injury like a sprain.' },
  '93000': { short: 'heart tracing (ECG)', name: 'Heart tracing (ECG)', explain: 'An electrocardiogram. Stickers on your chest record your heartbeat so a doctor can read it.' },
  '71046': { short: 'chest X-ray', name: 'Chest X-ray, 2 views', explain: 'X-ray pictures of the chest from two angles, usually front and side.' },
  '80053': { short: 'metabolic blood panel', name: 'Comprehensive metabolic panel', explain: 'A blood test that checks sugar, salts, kidney and liver health.' },
  '85025': { short: 'blood count (CBC)', name: 'Complete blood count (CBC)', explain: 'A blood test that counts red cells, white cells and platelets.' },
  '36415': { short: 'blood draw', name: 'Blood draw', explain: 'Taking blood from a vein with a needle so it can be tested.' },
  '12002': { short: 'stitches', name: 'Wound repair, 2.6 to 7.5 cm', explain: 'Stitches for a simple cut that is about 1 to 3 inches long.' },
  '90715': { short: 'Tdap shot', name: 'Tdap vaccine', explain: 'A shot that protects against tetanus, diphtheria and whooping cough. Often given after a cut.' },
  '90471': { short: 'fee for giving a shot', name: 'Vaccine administration', explain: 'The charge for giving a shot. The vaccine itself is billed on a separate line.' },
  '99213': { short: 'office visit', name: 'Office visit, established patient', explain: 'A regular visit with a doctor you have seen before, for a problem of low to medium difficulty.' },
  '80061': { short: 'cholesterol test', name: 'Lipid panel (cholesterol test)', explain: 'A blood test that measures cholesterol and other fats in the blood.' },
  '70450': { short: 'head CT scan', name: 'CT scan of head, no contrast', explain: 'A detailed scan of the head made with X-rays, without dye in the veins.' },
  '96374': { short: 'IV medicine', name: 'IV push medication', explain: 'Giving one dose of medicine quickly through an IV line in a vein.' },
  '72148': { short: 'lower back MRI', name: 'MRI lower back, no contrast', explain: 'A detailed scan of the lower spine made with magnets, without dye in the veins.' },
  '97161': { short: 'physical therapy evaluation', name: 'Physical therapy evaluation', explain: 'The first physical therapy visit, where the therapist checks how you move and makes a plan.' },
  '97110': { short: 'therapy exercise session', name: 'Therapeutic exercise', explain: 'Exercises guided by a physical therapist to build strength and movement.' },
  '84443': { short: 'thyroid test', name: 'Thyroid test (TSH)', explain: 'A blood test that checks how well your thyroid gland is working.' },
  '99070': { short: 'supplies', name: 'Supplies and materials', explain: 'Supplies used during care, like bandages or splints, billed on their own line.' },
};

module.exports = { CPT };
