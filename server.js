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
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const question = msg.text.body;
    const phone = msg.from;
    console.log('Question from', phone, ':', question);

    const { data: docs, error: dbError } = await supabase
      .from('documents')
      .select('content, filename')
      .limit(10);

    if (dbError) console.error('Supabase error:', dbError);
    console.log('Docs found:', docs?.length);

    const context = docs && docs.length > 0
      ? docs.map(d => d.content).join('\n\n')
      : 'No documents uploaded yet.';

    const chatModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = 'You are a helpful business assistant.\n' +
      'Use the context below to answer the question as best you can.\n' +
      'If the answer is not in the context, say you do not have that info.\n\n' +
      'Context:\n' + context + '\n\nQuestion: ' + question;

    const aiResult = await chatModel.generateContent(prompt);
    const reply = aiResult.response.text();
    console.log('Reply generated:', reply.substring(0, 100));

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
    const waJson = await waRes.json();
    console.log('WhatsApp result:', JSON.stringify(waJson));

  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
