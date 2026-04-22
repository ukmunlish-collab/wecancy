// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { processDocument } = require('./processor');

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_KEY
);

// --- Upload documents ---
app.post('/upload', upload.single('file'), async (req, res) => {
  const { businessId } = req.body;
  const { buffer, originalname, mimetype } = req.file;
  const chunks = await processDocument(
    buffer, originalname, mimetype, businessId
  );
  res.json({ success: true, chunks });
});

// --- WhatsApp webhook verify ---
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// --- WhatsApp incoming messages ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.entry?.[0]?.changes?.[0]?.value
    ?.messages?.[0];
  if (!msg || msg.type !== 'text') return;

  const question = msg.text.body;
  const phone = msg.from;

  // 1. Embed the question
  const embedModel = genAI.getGenerativeModel(
    { model: 'embedding-001' }
  );
  const qEmbed = await embedModel.embedContent(question);
  const qVec = qEmbed.embedding.values;

  // 2. Find relevant document chunks
  const { data: docs } = await supabase.rpc(
    'match_documents', { query_embedding: qVec, match_count: 4 }
  );
  const context = docs?.map(d => d.content).join('

') || '';

  // 3. Ask Gemini with context
  const chat = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const prompt = `You are a helpful business assistant.
Use ONLY the context below to answer the question.
If the answer is not in the context, say you don't have that info.

Context:
${context}

Question: ${question}`;

  const result = await chat.generateContent(prompt);
  const reply = result.response.text();

  // 4. Send reply via WhatsApp
  await fetch(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        text: { body: reply }
      })
    }
  );
});

app.listen(3000, () => console.log('Server running on port 3000'));