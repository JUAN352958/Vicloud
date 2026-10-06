const express = require('express');
const cors = require('cors');
const fsPromises = require('fs').promises;
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const archiver = require('archiver');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const extract = require('extract-zip');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = 'teste';
const DB_PATH = path.join(__dirname, 'database', 'users.json');
const BOTS_DIR = path.join(__dirname, 'bots');

app.use(cors());
app.use(express.json());

async function createBotDirectoryStructure(botId) {
  const botDir = path.join(BOTS_DIR, botId);
  const logsDir = path.join(botDir, 'logs');
  const sourceDir = path.join(botDir, 'source');

  await fsPromises.mkdir(botDir, { recursive: true });
  await fsPromises.mkdir(logsDir, { recursive: true });
  await fsPromises.mkdir(sourceDir, { recursive: true });

  return {
    botDir,
    logsDir,
    sourceDir
  };
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acesso não fornecido' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

async function installDependencies(sourceDir, logStream) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
        logStream.write(`[${new Date().toISOString()}] No package.json found, skipping npm install\n`);
        return resolve();
      }

      logStream.write(`[${new Date().toISOString()}] Installing dependencies...\n`);
      
      const npmInstall = spawn('npm', ['install'], {
        cwd: sourceDir,
        shell: true
      });

      npmInstall.stdout.on('data', (data) => {
        logStream.write(`[${new Date().toISOString()}] npm install: ${data}`);
      });

      npmInstall.stderr.on('data', (data) => {
        logStream.write(`[${new Date().toISOString()}] npm install error: ${data}`);
      });

      npmInstall.on('close', (code) => {
        if (code === 0) {
          logStream.write(`[${new Date().toISOString()}] Dependencies installed successfully\n`);
          resolve();
        } else {
          const error = `npm install failed with code ${code}`;
          logStream.write(`[${new Date().toISOString()}] ERROR: ${error}\n`);
          reject(new Error(error));
        }
      });

      npmInstall.on('error', (error) => {
        logStream.write(`[${new Date().toISOString()}] ERROR: Failed to start npm install: ${error.message}\n`);
        reject(error);
      });
    } catch (error) {
      logStream.write(`[${new Date().toISOString()}] ERROR: Exception during npm install: ${error.message}\n`);
      reject(error);
    }
  });
}

async function extractBotFiles(zipPath, sourceDir, logStream) {
  try {
    await extract(zipPath, { dir: sourceDir });
    await fs.promises.unlink(zipPath);
    
    const files = await fs.promises.readdir(sourceDir);
    let mainFile = null;
    
    if (files.includes('package.json')) {
      const packageJson = JSON.parse(
        await fs.promises.readFile(path.join(sourceDir, 'package.json'), 'utf8')
      );
      mainFile = packageJson.main || 'index.js';
      
      await installDependencies(sourceDir, logStream);
    } else {
      mainFile = files.find(f => f === 'index.js') || files[0];
    }
    
    return mainFile;
  } catch (error) {
    throw new Error(`Erro ao processar arquivos: ${error.message}`);
  }
}

const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    try {
      const botId = uuidv4();
      req.botId = botId;
      const { botDir } = await createBotDirectoryStructure(botId);
      cb(null, botDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: function (req, file, cb) {
    cb(null, 'bot.zip');
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const isZip = 
      file.mimetype === 'application/zip' || 
      file.mimetype === 'application/x-zip-compressed' ||
      file.originalname.toLowerCase().endsWith('.zip');
    
    if (isZip) {
      cb(null, true);
    } else {
      cb(new Error(`Arquivo inválido. Mimetype: ${file.mimetype}, Nome: ${file.originalname}`));
    }
  },
  limits: {
fileSize: 900 * 1024 * 1024 // Limite de 100MB
  }
});

async function readUsers() {
  try {
    const data = await fsPromises.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fsPromises.mkdir(path.dirname(DB_PATH), { recursive: true });
      await fsPromises.writeFile(DB_PATH, JSON.stringify({ users: [] }));
      return { users: [] };
    }
    throw error;
  }
}

async function saveUsers(users) {
  try {
    await fsPromises.writeFile(DB_PATH, JSON.stringify(users, null, 2), 'utf8');
  } catch (error) {
    console.error('Erro ao salvar usuários:', error);
    throw error;
  }
}

app.post('/api/upload-bot', authenticateToken, upload.single('botFile'), async (req, res) => {
  try {
    console.log('Upload request received');
    
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo foi enviado' });
    }

    const botId = req.botId;
    const { sourceDir } = await createBotDirectoryStructure(botId);
    
    const logFile = path.join(BOTS_DIR, botId, 'logs', 'bot.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    const mainFile = await extractBotFiles(
      path.join(BOTS_DIR, botId, 'bot.zip'),
      sourceDir,
      logStream
    );

    const db = await readUsers();
    const userIndex = db.users.findIndex(u => u.id === req.user.id);

    if (userIndex === -1) {
      await fs.promises.rm(path.join(BOTS_DIR, botId), { recursive: true, force: true });
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (!db.users[userIndex].bots) {
      db.users[userIndex].bots = [];
    }

    const botInfo = {
      id: botId,
      uploadedAt: new Date().toISOString(),
      mainFileName: mainFile,
      status: 'stopped'
    };

    db.users[userIndex].bots.push(botInfo);
    await saveUsers(db);

    logStream.write(`Bot uploaded at ${new Date().toISOString()}\n`);
    logStream.end();

    res.status(201).json({
      message: 'Bot enviado com sucesso',
      bot: botInfo
    });

  } catch (error) {
    if (req.botId) {
      try {
        await fs.promises.rm(path.join(BOTS_DIR, req.botId), { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Erro ao limpar diretório do bot:', cleanupError);
      }
    }

    console.error('Erro no upload do bot:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/my-bots', authenticateToken, async (req, res) => {
  try {
    const db = await readUsers();
    const user = db.users.find(u => u.id === req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({
      bots: user.bots || []
    });

  } catch (error) {
    console.error('Erro ao listar bots:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }

    const db = await readUsers();

    if (db.users.some(user => user.email === email)) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = {
      id: Date.now().toString(),
      email,
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };

    db.users.push(newUser);
    await saveUsers(db);

    const token = jwt.sign({ id: newUser.id, email: newUser.email }, JWT_SECRET, {
      expiresIn: '24h'
    });

    res.status(201).json({
      message: 'Usuário registrado com sucesso',
      token,
      user: {
        id: newUser.id,
        email: newUser.email
      }
    });

  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const db = await readUsers();
    const user = db.users.find(u => u.email === email);

    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: '24h'
    });

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: {
        id: user.id,
        email: user.email
      }
    });

  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const db = await readUsers();
    const user = db.users.find(u => u.id === req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

if (process.env.NODE_ENV === 'development') {
  app.get('/api/users', async (req, res) => {
    try {
      const db = await readUsers();
      res.json(db.users.map(user => ({
        id: user.id,
        email: user.email,
        createdAt: user.createdAt
      })));
    } catch (error) {
      console.error('Erro ao listar usuários:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });
}

app.post('/api/bot-control/:botId/:action', authenticateToken, async (req, res) => {
  try {
    const { botId, action } = req.params;
    const userId = req.user.id;

    const db = await readUsers();
    const user = db.users.find(u => u.id === userId);
    const bot = user?.bots?.find(b => b.id === botId);

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const logPath = path.join(BOTS_DIR, botId, 'logs', 'bot.log');
    await fsPromises.writeFile(logPath, '', 'utf8');

    switch (action) {
      case 'start':
        if (botProcesses.has(botId)) {
          return res.status(400).json({ error: 'Bot is already running' });
        }
        await startBotProcess(botId, userId);
        break;

      case 'stop':
        const process = botProcesses.get(botId);
        if (process) {
          process.kill();
          botProcesses.delete(botId);
        }
        break;

      case 'restart':
        if (botProcesses.has(botId)) {
          botProcesses.get(botId).kill();
          botProcesses.delete(botId);
        }
        await startBotProcess(botId, userId);
        break;

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error controlling bot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/bot-status/:botId', authenticateToken, async (req, res) => {
  const { botId } = req.params;
  res.json({
    status: botProcesses.has(botId) ? 'running' : 'stopped'
  });
});

app.get('/api/bot-logs/:botId', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const logPath = path.join(BOTS_DIR, botId, 'logs', 'bot.log');
    
    const logs = await fsPromises.readFile(logPath, 'utf8');
    res.json({
      logs: logs.split('\n').filter(Boolean)
    });
  } catch (error) {
    console.error('Error reading bot logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const botProcesses = new Map();

async function startBotProcess(botId, userId) {
  try {
    const botDir = path.join(BOTS_DIR, botId);
    const sourceDir = path.join(botDir, 'source');
    const logFile = path.join(botDir, 'logs', 'bot.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    if (!(await fsPromises.stat(sourceDir).catch(() => false))) {
      throw new Error('Diretório do bot não encontrado');
    }

    const db = await readUsers();
    const user = db.users.find(u => u.id === userId);
    if (!user || !user.bots) {
      throw new Error('Usuário ou bots não encontrados');
    }
    
    const bot = user.bots.find(b => b.id === botId);
    if (!bot) {
      throw new Error('Informações do bot não encontradas');
    }

    const mainFile = path.join(sourceDir, bot.mainFileName);

    if (!(await fsPromises.stat(mainFile).catch(() => false))) {
      throw new Error('Arquivo principal do bot não encontrado');
    }

    try {
      await installDependencies(sourceDir, logStream);
    } catch (error) {
      logStream.write(`[${new Date().toISOString()}] WARNING: Failed to install dependencies: ${error.message}\n`);
    }

    // Limita ram (nao apaga isso)
    const childProcess = spawn('node', ['--max-old-space-size=100', mainFile], {
      cwd: sourceDir,
      env: { ...process.env, BOT_ID: botId }
    });

    // Monitor de uso de memória
    const memoryCheckInterval = setInterval(() => {
      if (childProcess.killed) {
        clearInterval(memoryCheckInterval);
        return;
      }

      try {
        const memoryUsage = process.memoryUsage();
        const heapUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024); // MB

        if (heapUsed > 50) {
          logStream.write(`[${new Date().toISOString()}] WARNING: Memory limit exceeded (${heapUsed}MB). Stopping bot.\n`);
          clearInterval(memoryCheckInterval);
          childProcess.kill();
          botProcesses.delete(botId);
          
          updateBotStatus(userId, botId, 'stopped').catch(error => {
            console.error('Error updating bot status after memory limit:', error);
          });
        }
      } catch (error) {
        logStream.write(`[${new Date().toISOString()}] ERROR: Failed to check memory usage: ${error.message}\n`);
      }
    }, 5000); 

    childProcess.stdout.on('data', (data) => {
      const logEntry = `[${new Date().toISOString()}] ${data}`;
      logStream.write(logEntry);
    });

    childProcess.stderr.on('data', (data) => {
      const logEntry = `[${new Date().toISOString()}] ERROR: ${data}`;
      logStream.write(logEntry);
    });

    childProcess.on('close', async (code) => {
      clearInterval(memoryCheckInterval);
      try {
        const logEntry = `[${new Date().toISOString()}] Process exited with code ${code}\n`;
        logStream.write(logEntry);
        logStream.end();
        botProcesses.delete(botId);
        
        await updateBotStatus(userId, botId, 'stopped');
      } catch (error) {
        console.error('Erro ao atualizar status do bot:', error);
      }
    });

    botProcesses.set(botId, childProcess);

    try {
      await updateBotStatus(userId, botId, 'running');
    } catch (error) {
      console.error('Erro ao atualizar status do bot para running:', error);
    }

    return true;
  } catch (error) {
    console.error(`Error starting bot ${botId}:`, error);
    return false;
  }
}

async function updateBotStatus(userId, botId, status) {
  const db = await readUsers();
  const userIndex = db.users.findIndex(u => u.id === userId);
  
  if (userIndex !== -1 && db.users[userIndex].bots) {
    const botIndex = db.users[userIndex].bots.findIndex(b => b.id === botId);
    if (botIndex !== -1) {
      db.users[userIndex].bots[botIndex].status = status;
      await saveUsers(db);
    }
  }
}

async function startAllBots() {
  try {
    const db = await readUsers();
    for (const user of db.users) {
      if (user.bots) {
        for (const bot of user.bots) {
          if (bot.status === 'running') {
            await startBotProcess(bot.id, user.id);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error starting all bots:', error);
  }
}

app.delete('/api/bot/:botId', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const userId = req.user.id;

    const db = await readUsers();
    const userIndex = db.users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = db.users[userIndex];
    if (!user.bots) {
      return res.status(404).json({ error: 'Bot não encontrado' });
    }

    const botIndex = user.bots.findIndex(b => b.id === botId);
    if (botIndex === -1) {
      return res.status(404).json({ error: 'Bot não encontrado' });
    }

    if (botProcesses.has(botId)) {
      try {
        const process = botProcesses.get(botId);
        process.kill();
        botProcesses.delete(botId);
      } catch (error) {
        console.error(`Erro ao parar o bot ${botId}:`, error);
        
      }
    }

    const botDir = path.join(BOTS_DIR, botId);
    try {
      await fsPromises.rm(botDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Erro ao excluir diretório do bot ${botId}:`, error);
    }

    user.bots.splice(botIndex, 1);

    await saveUsers(db);

    res.json({ 
      success: true,
      message: 'Bot excluído com sucesso'
    });

  } catch (error) {
    console.error('Erro ao excluir bot:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      message: error.message 
    });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/metrics', (req, res) => {
  const start = process.hrtime();
  
  for(let i = 0; i < 1000; i++) {
    Math.random();
  }
  
  const end = process.hrtime(start);
  const responseTimeMs = (end[0] * 1000 + end[1] / 1e6).toFixed(2);

  res.json({
    responseTime: parseFloat(responseTimeMs),
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
  });
});

app.post('/api/bot-commit/:botId', authenticateToken, upload.single('botFile'), async (req, res) => {
  try {
    const { botId } = req.params;
    const userId = req.user.id;
    // Verify bot ownership
    const db = await readUsers();
    const user = db.users.find(u => u.id === userId);
    const bot = user?.bots?.find(b => b.id === botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const botDir = path.join(BOTS_DIR, botId);
    const sourceDir = path.join(botDir, 'source');
    const tempDir = path.join(botDir, 'temp');
    const backupDir = path.join(botDir, 'backup');
    // Create backup of current source
    await fsPromises.mkdir(backupDir, { recursive: true });
    await fsPromises.cp(sourceDir, backupDir, { recursive: true });
    try {
      // Extract new files to temp directory
      await fsPromises.mkdir(tempDir, { recursive: true });
      await extract(req.file.path, { dir: tempDir });
      // Remove old source directory and move new files
      await fsPromises.rm(sourceDir, { recursive: true });
      await fsPromises.rename(tempDir, sourceDir);
      // Clean up
      await fsPromises.unlink(req.file.path);
      if (await fsPromises.access(backupDir).catch(() => false)) {
        await fsPromises.rm(backupDir, { recursive: true });
      }
      res.json({ message: 'Changes committed successfully' });
    } catch (error) {
      // Restore from backup if something goes wrong
      if (await fsPromises.access(backupDir).catch(() => false)) {
        await fsPromises.rm(sourceDir, { recursive: true });
        await fsPromises.rename(backupDir, sourceDir);
      }
      throw error;
    }
  } catch (error) {
    console.error('Error committing changes:', error);
    res.status(500).json({ error: 'Failed to commit changes' });
  }
});

// Route for creating and downloading backup
app.get('/api/bot-backup/:botId', authenticateToken, async (req, res) => {
  try {
    const { botId } = req.params;
    const userId = req.user.id;
    // Verify bot ownership
    const db = await readUsers();
    const user = db.users.find(u => u.id === userId);
    const bot = user?.bots?.find(b => b.id === botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    const sourceDir = path.join(BOTS_DIR, botId, 'source');
    const backupPath = path.join(BOTS_DIR, botId, `backup-${Date.now()}.zip`);

    // Create zip file
    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Handle archive warnings
    archive.on('warning', function(err) {
      if (err.code === 'ENOENT') {
        console.warn('Archive warning:', err);
      } else {
        throw err;
      }
    });

    // Handle archive errors
    archive.on('error', function(err) {
      throw err;
    });

    // Pipe archive data to the file
    archive.pipe(output);

    // Add the directory to the archive
    archive.directory(sourceDir, false);

    // Finalize the archive and wait for it to complete
    await archive.finalize();

    // Send the file
    res.download(backupPath, `bot-${botId}-backup.zip`, async (err) => {

      await fsPromises.unlink(backupPath).catch(console.error);
      
      if (err) {
        console.error('Error sending backup file:', err);
      }
    });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

startAllBots();


app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});