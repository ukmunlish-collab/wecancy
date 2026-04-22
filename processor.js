require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function extractText(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (mimetype.includes('word')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (mimetype.includes('excel') || mimetype.includes('spreadsheet')) {
    const wb = XLSX.read(buffer);
    return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
  }
  return buffer.toString('utf-8');
}

function chunkText(text, size = 500) {
  const words = text.split(' ');
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(' '));
  }
  return chunks;
}

async function processDocument(buffer, filename, mimetype, businessId) {
  const text = await extractText(buffer, mimetype);
  const chunks = chunkText(text);

  for (const chunk of chunks) {
    await supabase.from('documents').insert({
      business_id: businessId,
      filename,
      content: chunk,
      embedding: null
    });
  }
  return chunks.length;
}

module.exports = { processDocument };
