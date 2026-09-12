'use strict';

// RFC 4180 风格 CSV：含逗号/引号/换行的字段加双引号并转义内部引号；
// 输出带 UTF-8 BOM，确保 Excel 打开中文不乱码。
function escapeCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows) {
  const lines = rows.map((row) => row.map(escapeCell).join(','));
  return '\uFEFF' + lines.join('\r\n'); // UTF-8 BOM，供 Excel 正确识别中文
}

module.exports = { toCsv, escapeCell };
