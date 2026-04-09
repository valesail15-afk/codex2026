import type { CSSProperties } from 'react';

export const MATRIX_UI = {
  borderColor: '#d9d9d9',
  headerBg: '#f7f8fa',
  subHeaderBg: '#fcfcfd',
  zebraBg: '#f5f5f5',
  highlightBg: '#e88700',
  highlightText: '#fff',
  coverageBg: '#e7f7de',
  text: '#222',
  muted: '#595959',
  teamBlue: '#2f54eb',
  profitRateRed: '#ff4d4f',
  numberBlue: '#1677ff',
  minFontSize: 12,
  baseFontSize: 13,
  rowHeight: 44,
  cellPadding: '8px 10px',
  cellMinWidth: 118,
} as const;

export const matrixTableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
  background: '#fff',
};

export const matrixWrapStyle: CSSProperties = {
  overflowX: 'auto',
  WebkitOverflowScrolling: 'touch',
};

export function matrixCellStyle(extra?: CSSProperties): CSSProperties {
  return {
    border: `1px solid ${MATRIX_UI.borderColor}`,
    padding: MATRIX_UI.cellPadding,
    textAlign: 'center',
    verticalAlign: 'middle',
    fontSize: MATRIX_UI.baseFontSize,
    lineHeight: 1.4,
    minWidth: MATRIX_UI.cellMinWidth,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    ...extra,
  };
}
