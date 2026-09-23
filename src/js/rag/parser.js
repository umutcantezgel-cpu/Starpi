// @ts-check
// 100% client-side document parser using Web Streams & ArrayBuffers.
// Extracts plain text from .txt, .md, .json, .csv, and .pdf files without server communication.

/**
 * Extracts raw text from an ArrayBuffer of a PDF document without any external server.
 * Uses native DecompressionStream to decompress FlateDecode streams, then parses
 * BT ... ET text blocks, Tj, and TJ operators.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
export async function parsePdfBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const textDecoder = new TextDecoder('latin1');
  const rawString = textDecoder.decode(bytes);

  /** @type {string[]} */
  const extractedPages = [];

  // Match stream ... endstream blocks in PDF
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match;

  while ((match = streamRegex.exec(rawString)) !== null) {
    const streamContent = match[1];
    const streamStart = match.index;
    const streamEnd = match.index + match[0].length;

    // Look at dictionary preceding the stream
    const headerSlice = rawString.slice(Math.max(0, streamStart - 400), streamStart);
    const isFlate = /\/Filter\s*\/FlateDecode/i.test(headerSlice);

    let decodedStream = '';

    if (isFlate) {
      try {
        // Find exact binary offsets for stream
        const binaryStreamStart = rawString.indexOf('\n', streamStart) + 1;
        const binaryStreamEnd = rawString.lastIndexOf('endstream', streamEnd) - 1;

        if (binaryStreamEnd > binaryStreamStart) {
          const streamBytes = bytes.subarray(binaryStreamStart, binaryStreamEnd);
          // Try decompressing with Web Stream DecompressionStream
          if (typeof DecompressionStream !== 'undefined') {
            try {
              const ds = new DecompressionStream('deflate');
              const writer = ds.writable.getWriter();
              writer.write(streamBytes);
              writer.close();
              const response = new Response(ds.readable);
              const decompressedBuffer = await response.arrayBuffer();
              decodedStream = new TextDecoder('latin1').decode(decompressedBuffer);
            } catch {
              // Try raw deflate format if standard zlib header fails
              try {
                const dsRaw = new DecompressionStream('deflate-raw');
                const writer = dsRaw.writable.getWriter();
                // Skip 2-byte zlib header if present
                const rawSlice = streamBytes.length > 2 && streamBytes[0] === 0x78 ? streamBytes.subarray(2) : streamBytes;
                writer.write(rawSlice);
                writer.close();
                const response = new Response(dsRaw.readable);
                const decompressedBuffer = await response.arrayBuffer();
                decodedStream = new TextDecoder('latin1').decode(decompressedBuffer);
              } catch {
                decodedStream = streamContent;
              }
            }
          } else {
            decodedStream = streamContent;
          }
        }
      } catch {
        decodedStream = streamContent;
      }
    } else {
      decodedStream = streamContent;
    }

    if (decodedStream) {
      const pageText = extractPdfTextOperators(decodedStream);
      if (pageText.trim()) {
        extractedPages.push(pageText.trim());
      }
    }
  }

  // If streams didn't yield text (e.g. unusual encoding), fallback to scanning raw string for text blocks
  if (extractedPages.length === 0) {
    const rawFallback = extractPdfTextOperators(rawString);
    if (rawFallback.trim()) {
      return rawFallback.trim();
    }
  }

  return extractedPages.join('\n\n');
}

/**
 * Extracts text from PDF text operators within BT ... ET blocks.
 * Handles Tj, TJ, ', and " operators with octal and escape sequence unescaping.
 *
 * @param {string} content
 * @returns {string}
 */
export function extractPdfTextOperators(content) {
  /** @type {string[]} */
  const textSegments = [];
  const btRegex = /BT([\s\S]*?)ET/g;
  let btMatch;

  while ((btMatch = btRegex.exec(content)) !== null) {
    const block = btMatch[1];
    let blockText = '';

    // 1. Matches TJ array: [(text) 20 (more text)] TJ
    const tjArrayRegex = /\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
    let arrayMatch;
    while ((arrayMatch = tjArrayRegex.exec(block)) !== null) {
      const inner = arrayMatch[1];
      const stringRegex = /\(((?:[^)\\]|\\.)*)\)/g;
      let strMatch;
      while ((strMatch = stringRegex.exec(inner)) !== null) {
        blockText += decodePdfString(strMatch[1]) + ' ';
      }
    }

    // 2. Matches single string operators: (text) Tj or (text) '
    const tjSingleRegex = /\(((?:[^)\\]|\\.)*)\)\s*(?:Tj|'|")/g;
    let singleMatch;
    while ((singleMatch = tjSingleRegex.exec(block)) !== null) {
      blockText += decodePdfString(singleMatch[1]) + '\n';
    }

    if (blockText.trim()) {
      textSegments.push(blockText.trim());
    }
  }

  return textSegments.join('\n');
}

/**
 * Decodes PDF string escape sequences (e.g. \n, \r, \t, \(, \), \\, \ddd octal).
 * @param {string} str
 * @returns {string}
 */
export function decodePdfString(str) {
  return str
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * Parses JSON content into a readable structured text document.
 * @param {string} jsonText
 * @returns {string}
 */
export function parseJsonDocument(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    if (typeof data !== 'object' || data === null) {
      return String(data);
    }
    if (Array.isArray(data)) {
      return data
        .map((item, idx) => `Item ${idx + 1}:\n${typeof item === 'object' ? JSON.stringify(item, null, 2) : item}`)
        .join('\n\n');
    }
    return Object.entries(data)
      .map(([k, v]) => `${k}:\n${typeof v === 'object' ? JSON.stringify(v, null, 2) : v}`)
      .join('\n\n');
  } catch {
    return jsonText;
  }
}

/**
 * Parses an uploaded file into plain text using client-side ArrayBuffer / Streams.
 *
 * @param {File | { name: string, arrayBuffer: () => Promise<ArrayBuffer>, text: () => Promise<string> }} file
 * @returns {Promise<{ title: string, text: string, type: string }>}
 */
export async function parseDocumentFile(file) {
  const name = file.name || 'document';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  /** @type {string} */
  let text;
  let type = 'file';

  if (ext === 'pdf') {
    type = 'file';
    const buffer = await file.arrayBuffer();
    text = await parsePdfBuffer(buffer);
  } else if (ext === 'json') {
    type = 'text';
    const raw = await file.text();
    text = parseJsonDocument(raw);
  } else if (ext === 'md' || ext === 'txt' || ext === 'csv' || ext === 'log') {
    type = ext === 'csv' ? 'text' : 'file';
    text = await file.text();
  } else {
    // Default fallback
    try {
      text = await file.text();
    } catch {
      const buffer = await file.arrayBuffer();
      text = new TextDecoder('utf-8').decode(buffer);
    }
  }

  const title = name.replace(/\.[^/.]+$/, '').trim() || 'Untitled';
  return { title, text: text.trim(), type };
}
