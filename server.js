require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { processDocument } = require('./processor');

const app = express();
app.use(express.json());
app.use(express.static('.'));
const upload = multer({ storage: multer.memoryStorage() });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { businessId } = req.body;
    const { buffer, originalname, mimetype } = req.file;
    const chunks = await processDocument(buffer, originalname, mimetype, businessId);
    res.json({ success: true, chunks });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/webhook', (req, res) => {
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log('[Webhook] Verification request received');
  console.log('[Webhook] verify_token:', verifyToken, '| challenge:', challenge);
  if (verifyToken === process.env.VERIFY_TOKEN) {
    console.log('[Webhook] Verification succeeded');
    res.send(challenge);
  } else {
    console.error('[Webhook] Verification failed — token mismatch (received:', verifyToken, ')');
    res.sendStatus(403);
  }
});


app.post('/webhook', async (req, res) => {
  console.log('[Webhook] Incoming POST request body:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') {
      console.log('[Webhook] No text message found in payload — skipping');
      return;
    }

    const question = msg.text.body;
    const phone = msg.from;
    console.log('[Webhook] Message received | type:', msg.type, '| from:', phone, '| text:', question);

    console.log('[Webhook] Calling embedding API...');
    const qEmbed = await genAI.embedContent({
      model: 'embedding-001',
      content: { parts: [{ text: question }] }
    });
    const qVec = qEmbed.embedding.values;
    console.log('[Webhook] Embedding received, vector length:', qVec.length);

    console.log('[Webhook] Calling Supabase match_documents RPC...');
    const { data: docs, error: rpcError } = await supabase.rpc('match_documents', {
      query_embedding: qVec,
      match_count: 4
    });
    if (rpcError) console.error('[Webhook] Supabase RPC error:', rpcError);
    console.log('[Webhook] Supabase returned', docs?.length ?? 0, 'document(s)');

    const context = docs?.map(d => d.content).join('\n\n') || '';

    const chatModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = 'You are a helpful business assistant.\n' +
      'Use ONLY the context below to answer the question.\n' +
      'If the answer is not in the context, say you do not have that info.\n\n' +
      'Context:\n' + context + '\n\nQuestion: ' + question;

    console.log('[Webhook] Calling Gemini generateContent...');
    const result = await chatModel.generateContent(prompt);
    const reply = result.response.text();
    console.log('[Webhook] Gemini reply:', reply);

    console.log('[Webhook] Sending WhatsApp message to', phone, '...');
    const waRes = await fetch(
      'https://graph.facebook.com/v18.0/' + process.env.WHATSAPP_PHONE_ID + '/messages',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          text: { body: reply }
        })
      }
    );
    console.log('[Webhook] WhatsApp API response status:', waRes.status);
  } catch (err) {
    console.error('Webhook error:', err);
  }
});


app.listen(3000, () => console.log('Server running on port 3000'));
