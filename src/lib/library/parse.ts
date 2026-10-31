export class DocumentParseError extends Error { constructor(readonly code:string){super(code);} }
export class DocumentParseYield extends Error {}
export type PdfProgress = { version: 1; pages: string[]; ocrPages: number[] };
type PdfOptions = { progress?: PdfProgress; save?: (progress: PdfProgress) => Promise<void>; ocrBatch?: number };
export function documentMime(bytes:Uint8Array,filename:string) {
  const header=new TextDecoder().decode(bytes.slice(0,12));
  if(header.startsWith("%PDF-"))return "application/pdf";
  if(bytes[0]===0xff&&bytes[1]===0xd8)return "image/jpeg";
  if(bytes[0]===0x89&&header.slice(1,4)==="PNG")return "image/png";
  if(header.startsWith("RIFF")&&header.slice(8,12)==="WEBP")return "image/webp";
  if(bytes[0]===0x50&&bytes[1]===0x4b&&/\.docx$/i.test(filename))return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if(/\.(txt|md|markdown|csv|tsv|json)$/i.test(filename))return "text/plain; charset=utf-8";
  throw new DocumentParseError("unsupported_format");
}
// Reject obviously oversized/encrypted archives before handing them to DOCX.
// This is not a substitute for running untrusted parsers in a bounded worker.
export function validateDocx(bytes:Uint8Array) {
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let end=-1;for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65_557);n--)if(data.getUint32(n,true)===0x06054b50){end=n;break;}
  if(end<0)throw new DocumentParseError("invalid_docx");
  const count=data.getUint16(end+10,true), offset=data.getUint32(end+16,true);
  if(!count||count>1500||offset>=end)throw new DocumentParseError("docx_archive_limit");
  let cursor=offset,total=0;const names=new Set<string>();
  for(let n=0;n<count;n++) {
    if(cursor+46>end||data.getUint32(cursor,true)!==0x02014b50)throw new DocumentParseError("invalid_docx");
    const size=data.getUint32(cursor+24,true),nameLength=data.getUint16(cursor+28,true),extra=data.getUint16(cursor+30,true),comment=data.getUint16(cursor+32,true);
    if((data.getUint16(cursor+8,true)&1)||size>8*1024*1024||(total+=size)>32*1024*1024)throw new DocumentParseError("docx_archive_limit");
    const next=cursor+46+nameLength+extra+comment;if(next>end)throw new DocumentParseError("invalid_docx");
    const name=new TextDecoder().decode(bytes.slice(cursor+46,cursor+46+nameLength));
    if(name.includes("..")||name.startsWith("/")||name.includes("\\"))throw new DocumentParseError("invalid_docx");
    names.add(name);cursor=next;
  }
  if(!names.has("word/document.xml")||!names.has("[Content_Types].xml"))throw new DocumentParseError("invalid_docx");
}
export async function parseDocument(bytes:Uint8Array,mime:string,signal:AbortSignal,recognize?:(url:string,signal:AbortSignal)=>Promise<string>, options?: PdfOptions) {
  signal.throwIfAborted();let content="",parser="text-v1",note="文字已读取，请核对后保存。";
  if(mime.startsWith("text/")) {
    const encoding=bytes[0]===0xff&&bytes[1]===0xfe?"utf-16le":bytes[0]===0xfe&&bytes[1]===0xff?"utf-16be":"utf-8";
    try { content=new TextDecoder(encoding,{fatal:true}).decode(bytes); }
    catch { try {content=new TextDecoder("gb18030",{fatal:true}).decode(bytes);note="已按GB18030读取，请核对原文中的中文与标点。";} catch {throw new DocumentParseError("invalid_text_encoding");} }
    if(/[\u0000-\u0008\u000e-\u001f]/.test(content))throw new DocumentParseError("invalid_text_encoding");
  }
  else if(mime==="application/pdf") {
    const {getDocumentProxy,extractText,renderPageAsImage}=await import("unpdf");
    const pdf=await getDocumentProxy(Uint8Array.from(bytes),{isEvalSupported:false,useSystemFonts:false});
    try {
      if(pdf.numPages>50)throw new DocumentParseError("pdf_page_limit");
      const progress = options?.progress ?? { version: 1 as const, pages: (await extractText(pdf)).text, ocrPages: [] };
      if (progress.pages.length !== pdf.numPages) throw new DocumentParseError("invalid_pdf_progress");
      const missing = progress.pages.flatMap((text, index) => text.trim() || progress.ocrPages.includes(index) ? [] : [index]);
      if (missing.length && !recognize) throw new DocumentParseError("pdf_ocr_required");
      let scanned = 0;
      for (const index of missing) {
        signal.throwIfAborted();
        if (scanned >= (options?.ocrBatch ?? 50)) throw new DocumentParseYield("pdf_page_checkpointed");
        // Sequential, bounded-size rendering: never hold a whole exam as images.
        const page = await pdf.getPage(index + 1), viewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1800 / Math.max(viewport.width, viewport.height));
        const url = await renderPageAsImage(pdf, index + 1, { scale, toDataURL: true, canvasImport: () => import("@napi-rs/canvas") });
        progress.pages[index] = await recognize!(url, signal);
        progress.ocrPages.push(index); scanned++;
        await options?.save?.(progress);
        page.cleanup();
      }
      if (!progress.pages.some(text => text.trim())) throw new DocumentParseError("empty_document");
      content=progress.pages.map((t,n)=>`【原文件第 ${n+1} 页】\n${t}`).join("\n\n");parser=progress.ocrPages.length ? "unpdf-ocr-v2" : "unpdf-v1";
      note="PDF文字按原页码保留；栏序、表格与识别文字请核对。"+(progress.ocrPages.length ? `其中${progress.ocrPages.length}页已进行图片识别。` : "");
    } finally {await pdf.destroy();}
  } else if(mime.includes("wordprocessingml")) {
    validateDocx(bytes);const mammoth=await import("mammoth");
    // extractRawText accepts only the document input; external access is off
    // by default in Mammoth's reader. Do not pass an unsupported options arg.
    const result=await mammoth.extractRawText({buffer:Buffer.from(bytes)});content=result.value;
    parser="mammoth-1.13";note="Word段落与表格文字已提取；不虚构页码，内嵌图片、公式和批注请核对原件。"+(result.messages.length?`转换器有${result.messages.length}项提示，请核对预览。`:"");
  } else if(mime.startsWith("image/")&&recognize) {
    content=await recognize(`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,signal);parser="image-ocr-v1";note="图片识别文本待核对；原图已保留。";
  } else throw new DocumentParseError("unsupported_format");
  signal.throwIfAborted();
  if(!content.trim())throw new DocumentParseError("empty_document");
  if(content.length>60_000)throw new DocumentParseError("document_text_limit");
  return {content,parser,note};
}
export function ingestErrorMessage(code:string|null) {
  if(code==="pdf_ocr_required")return "原件已保存。这是扫描PDF，需要OCR任务；当前不会把空文字当作入库成功，请先上传对应页图片。";
  if(code==="pdf_page_limit"||code==="document_text_limit")return "原件已保存，资料较长，请按章节拆分后重新上传。";
  if(code==="unsupported_format")return "支持TXT、MD、CSV、TSV、JSON、文字PDF、DOCX及图片。旧版DOC、PPT、XLS请先导出为DOCX、PDF或文本。";
  if(code==="invalid_text_encoding")return "文本编码无法可靠读取，请另存为UTF-8或UTF-16后重试。";
  if(code==="invalid_docx"||code==="docx_archive_limit")return "原件已保存，Word文件结构异常或超过安全解析范围。";
  return "原件已保留，资料解析未完成，请稍后重试或粘贴文字。";
}
