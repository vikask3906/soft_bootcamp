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
