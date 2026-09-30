/**
 * The handwriting test sheet: what the writer was asked to write, one row per
 * line, top to bottom. Spaces are gaps on paper, not symbols.
 */
export const SHEET_V1: string[] = [
  '0 0 0 0 0',
  '1 1 1 1 1',
  '2 2 2 2 2',
  '3 3 3 3 3',
  '4 4 4 4 4',
  '5 5 5 5 5',
  '6 6 6 6 6',
  '7 7 7 7 7',
  '8 8 8 8 8',
  '9 9 9 9 9',
  '1+2+3+4+5+6',
  '9−8−7−6−5−4',
  '2×3×4×5×6×7',
  '8÷4÷2÷1÷3÷5',
  '1.5 2.5 3.5 4.5 0.5',
  '(1+2)(3+4)(5+6)',
  '12+7×3=',
  '(18+7)÷5+27=',
  '9÷0=',
  '3.5×2−1=',
  '100−25÷5=',
  '40÷(2+3)×6=',
];

/** Expected answers for the equation rows (checked end-to-end). */
export const SHEET_V1_ANSWERS: Record<string, string> = {
  '12+7×3=': '33',
  '(18+7)÷5+27=': '32',
  '9÷0=': 'Undefined',
  '3.5×2−1=': '6',
  '100−25÷5=': '95',
  '40÷(2+3)×6=': '48',
};

/** Test sheet 2 — fresh content, written freely (straight rows), never tuned on. */
export const SHEET_V2: string[] = [
  '305+947=',
  '86−19×2=',
  '7.25×4=',
  '1000÷8=',
  '(6+9)×(8−3)=',
  '2×(3+4×5)−6=',
  '0.5+0.25+0.125=',
  '144÷12÷3=',
  '9−3−2−1=',
  '−8+20=',
  '3.6÷0.4=',
  '((2+3)×4−5)÷3=',
  '58×7−406=',
  '7÷(4−4)=',
  '1+2×3−4÷5=',
  '67890−12345=',
];

export const SHEET_V2_ANSWERS: Record<string, string> = {
  '305+947=': '1252',
  '86−19×2=': '48',
  '7.25×4=': '29',
  '1000÷8=': '125',
  '(6+9)×(8−3)=': '75',
  '2×(3+4×5)−6=': '40',
  '0.5+0.25+0.125=': '0.875',
  '144÷12÷3=': '4',
  '9−3−2−1=': '3',
  '−8+20=': '12',
  '3.6÷0.4=': '9',
  '((2+3)×4−5)÷3=': '5',
  '58×7−406=': '0',
  '7÷(4−4)=': 'Undefined',
  '1+2×3−4÷5=': '6.2',
  '67890−12345=': '55545',
};

export const SHEETS = { v1: { rows: SHEET_V1, answers: SHEET_V1_ANSWERS }, v2: { rows: SHEET_V2, answers: SHEET_V2_ANSWERS } };
