require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { processDocument } = require('./processor');

const app = express();
app.use(express.json());
app.use(express.static('.'));
const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function askGroq(question, context) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful business assistant. Use ONLY the context provided to answer questions. If the answer is not in the context, say you do not have that info.'
        },
        {
          role: 'user',
          content: 'Context:\n' + context + '\n\nQuestion: ' + question
        }
      ],
      max_tokens: 500
    })
  });
  const data = await res.json();
  console.log('Groq raw response:', JSON.stringify(data).substring(0, 300));
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
}

async function sendWhatsApp(phone, message) {
  const res = await fetch(
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
        text: { body: message }
      })
    }
  );
  const data = await res.json();
  console.log('WhatsApp result:', JSON.stringify(data));
  return data;
}

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
    console.log('Docs found:', docs?.length || 0);

    const context = docs && docs.length > 0
      ? docs.map(d => d.content).join('\n\n')
      : 'No documents uploaded yet. Please ask the business owner to upload their documents.';

    const reply = await askGroq(question, context);
    console.log('Reply:', reply.substring(0, 150));

    await sendWhatsApp(phone, reply);

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
