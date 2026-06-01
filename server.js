const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(__dirname)); // serves your index.html

// Internal API for the bot
app.use('/internal', (req, res, next) => {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.post('/internal/events', (req, res) => {
  console.log('Event from bot:', req.body);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));