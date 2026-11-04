import ExcelJS from "exceljs";
import { StudentImportError,parseStudentCsv } from "@/lib/teacher/student-import";

export async function importFileCsv(bytes:Uint8Array,name:string){
  if(!bytes.length||bytes.length>2_000_000)throw new StudentImportError(413,"名单需小于 2MB，每批最多 200 人");
  if(/\.csv$/i.test(name)){const csv=new TextDecoder("utf-8",{fatal:true}).decode(bytes);parseStudentCsv(csv);return csv;}
  if(!/\.xlsx$/i.test(name))throw new StudentImportError(400,"请选择 CSV 或 XLSX 名单");
  // Check central-directory uncompressed size before ExcelJS inflates the archive.
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let total=0,entries=0;
  for(let p=0;p+46<bytes.length;p++){if(data.getUint32(p,true)!==0x02014b50)continue;const length=data.getUint32(p+24,true);total+=length;entries++;if(total>16_000_000||entries>2000)throw new StudentImportError(413,"表格内容过大，请只保留名单工作表");p+=45+data.getUint16(p+28,true)+data.getUint16(p+30,true)+data.getUint16(p+32,true);}
  if(!entries)throw new StudentImportError(400,"XLSX 文件结构不正确");
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheet=workbook.worksheets[0];if(!sheet||sheet.rowCount>201||sheet.columnCount>20)throw new StudentImportError(400,"首张表最多 200 名学生、20 列");
  const rows:string[][]=[];sheet.eachRow(row=>{const values:string[]=[];for(let c=1;c<=sheet.columnCount;c++){const cell=row.getCell(c);if(cell.type===ExcelJS.ValueType.Formula)throw new StudentImportError(400,"名单不能包含公式，请粘贴为纯文本");values.push(cell.text);}rows.push(values);});
  const csv=rows.map(r=>r.map(s=>'"'+s.replaceAll('"','""')+'"').join(',')).join('\r\n');parseStudentCsv(csv);return csv;
}
