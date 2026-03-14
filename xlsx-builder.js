/**
 * XLSX Builder - Creates Excel spreadsheets
 */

import ExcelJS from "exceljs";

export async function createXlsxBuffer(sheetsData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "GYBR MCP Server";
  workbook.created = new Date();

  for (const sheetDef of sheetsData) {
    const sheet = workbook.addWorksheet(sheetDef.name);

    // Add headers with formatting
    if (sheetDef.headers && sheetDef.headers.length > 0) {
      const headerRow = sheet.addRow(sheetDef.headers);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
        cell.alignment = { horizontal: "left", vertical: "middle" };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
        };
      });
      headerRow.height = 22;

      // Auto-width columns
      sheetDef.headers.forEach((header, i) => {
        const col = sheet.getColumn(i + 1);
        col.width = Math.max(header.length + 4, 15);
      });
    }

    // Add data rows
    if (sheetDef.rows && sheetDef.rows.length > 0) {
      for (const row of sheetDef.rows) {
        const dataRow = sheet.addRow(row);
        dataRow.eachCell((cell) => {
          cell.font = { name: "Arial", size: 10 };
          cell.alignment = { horizontal: "left", vertical: "middle" };
        });
        dataRow.height = 18;
      }

      // Zebra striping
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1 && rowNumber % 2 === 0) {
          row.eachCell((cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
          });
        }
      });
    }

    // Freeze header row
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  return await workbook.xlsx.writeBuffer();
}
