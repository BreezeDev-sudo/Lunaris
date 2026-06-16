const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(__dirname)); // serves your index.html

process.env.USE_SQLITE = process.env.USE_SQLITE || 'true';

const botRoot = path.join(__dirname, '..', 'LunarisBot');
let botStorage = null;
let initDatabase = null;

try {
  ({ initDatabase } = require(path.join(botRoot, 'db', 'init')));
  botStorage = require(path.join(botRoot, 'utils', 'storage'));
} catch (error) {
  console.warn('Dashboard SQLite API disabled. Could not load bot storage:', error.message);
}

const dbReady = initDatabase
  ? initDatabase().catch(error => {
    console.error('Dashboard SQLite database failed to initialize:', error);
    return false;
  })
  : Promise.resolve(false);

async function requireDashboardStorage(res) {
  if (!botStorage || !await dbReady) {
    res.status(503).json({ ok: false, error: 'Dashboard database unavailable' });
    return null;
  }
  return botStorage;
}

function normalizeMessageTemplates(raw) {
  const templates = raw && typeof raw === 'object' ? raw : {};
  const normalized = {};

  for (const [command, commandTemplates] of Object.entries(templates)) {
    if (!commandTemplates || typeof commandTemplates !== 'object') continue;
    normalized[command] = commandTemplates[command] && typeof commandTemplates[command] === 'object'
      ? commandTemplates[command]
      : commandTemplates;
  }

  return normalized;
}

function serializeCommands() {
  const commandsPath = path.join(botRoot, 'commands');
  if (!fs.existsSync(commandsPath)) return [];

  return fs.readdirSync(commandsPath)
    .filter(file => file.endsWith('.js'))
    .map(file => {
      const command = require(path.join(commandsPath, file));
      if (!command.data) return null;
      const data = typeof command.data.toJSON === 'function' ? command.data.toJSON() : command.data;
      return {
        id: data.name,
        name: data.name,
        description: data.description,
        options: (data.options ?? []).map(opt => ({
          name: opt.name,
          description: opt.description,
          type: opt.type,
          required: opt.required ?? false,
          options: opt.options ?? []
        }))
      };
    })
    .filter(Boolean);
}

app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/faq.html', (req, res) => res.redirect(301, '/faq'));

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'faq.html'));
});

app.get('/commands', async (req, res) => {
  res.json(serializeCommands());
});

app.get('/dashboard-data/:guildId', async (req, res) => {
  const storage = await requireDashboardStorage(res);
  if (!storage) return;

  try {
    const [commandConfig, messageTemplates, settingsConfig] = await Promise.all([
      storage.getGuildCommandConfig(req.params.guildId),
      storage.getGuildMessageTemplates(req.params.guildId),
      storage.getGuildSettings(req.params.guildId)
    ]);

    res.json({
      ok: true,
      guild: { id: req.params.guildId, present: true },
      bot: { online: false, uptime: null, ping: null },
      commands: serializeCommands(),
      commandConfig,
      messageTemplates: normalizeMessageTemplates(messageTemplates),
      settingsConfig,
      guildMeta: { channels: [], roles: [] },
      database: 'sqlite'
    });
  } catch (error) {
    console.error('Failed to get dashboard data:', error);
    res.status(500).json({ ok: false });
  }
});

app.get('/settings-config/:guildId', async (req, res) => {
  const storage = await requireDashboardStorage(res);
  if (!storage) return;

  try {
    res.json(await storage.getGuildSettings(req.params.guildId));
  } catch (error) {
    console.error('Failed to get settings config:', error);
    res.status(500).json({});
  }
});

app.post('/settings-config/:guildId', async (req, res) => {
  const storage = await requireDashboardStorage(res);
  if (!storage) return;

  try {
    await storage.saveGuildSettings(req.params.guildId, req.body || {});
    res.json({
      ok: true,
      settings: await storage.getGuildSettings(req.params.guildId),
      guildMeta: { channels: [], roles: [] },
      database: 'sqlite'
    });
  } catch (error) {
    console.error('Failed to save settings config:', error);
    res.status(500).json({ ok: false });
  }
});

app.get('/guild-config/:guildId', async (req, res) => {
  const storage = await requireDashboardStorage(res);
  if (!storage) return;

  try {
    res.json(await storage.getGuildCommandConfig(req.params.guildId));
  } catch (error) {
    console.error('Failed to get guild config:', error);
    res.status(500).json({});
  }
});

app.post('/guild-config/:guildId', async (req, res) => {
  const storage = await requireDashboardStorage(res);
  if (!storage) return;

  try {
    await storage.saveGuildCommandConfig(req.params.guildId, req.body || {});
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to save guild config:', error);
    res.status(500).json({ ok: false });
  }
});

app.get('/message-config/:guildId', async (req, res) => {
  const storage = await requireDashboardStorage(res);
  if (!storage) return;

  try {
    res.json(normalizeMessageTemplates(await storage.getGuildMessageTemplates(req.params.guildId)));
  } catch (error) {
    console.error('Failed to get message config:', error);
    res.status(500).json({});
  }
});

app.post('/message-config/:guildId', async (req, res) => {
  const storage = await requireDashboardStorage(res);
  if (!storage) return;

  try {
    const { command, templates } = req.body;
    if (!command || !templates || typeof templates !== 'object') {
      return res.status(400).json({ ok: false });
    }

    const existing = normalizeMessageTemplates(await storage.getGuildMessageTemplates(req.params.guildId));
    existing[command] = templates[command] && typeof templates[command] === 'object'
      ? templates[command]
      : templates;

    await storage.saveGuildMessageTemplates(req.params.guildId, existing);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to save message config:', error);
    res.status(500).json({ ok: false });
  }
});

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

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    database: botStorage && await dbReady ? 'sqlite' : 'unavailable'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
