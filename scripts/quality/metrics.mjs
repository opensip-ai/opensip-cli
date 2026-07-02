export function classifyOutcome({ expected, actual }) {
  if (expected === true && actual === true) return 'tp';
  if (expected === true && actual === false) return 'fn';
  if (expected === false && actual === true) return 'fp';
  return 'tn';
}

export function ratesForMatrix(matrix) {
  const precisionDenominator = matrix.tp + matrix.fp;
  const recallDenominator = matrix.tp + matrix.fn;
  const fprDenominator = matrix.fp + matrix.tn;
  return {
    ...matrix,
    support: matrix.tp + matrix.fp + matrix.fn + matrix.tn,
    precision: rate(matrix.tp, precisionDenominator),
    recall: rate(matrix.tp, recallDenominator),
    fpr: rate(matrix.fp, fprDenominator),
  };
}

export function macroAverage(rows) {
  return {
    precision: average(rows.map((row) => row.precision)),
    precisionChecks: rows.filter((row) => row.precision !== null).length,
    recall: average(rows.map((row) => row.recall)),
    recallChecks: rows.filter((row) => row.recall !== null).length,
    fpr: average(rows.map((row) => row.fpr)),
    fprChecks: rows.filter((row) => row.fpr !== null).length,
  };
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function average(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}
